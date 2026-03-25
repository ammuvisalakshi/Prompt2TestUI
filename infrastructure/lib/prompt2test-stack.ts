import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as cognito    from 'aws-cdk-lib/aws-cognito'
import * as ec2        from 'aws-cdk-lib/aws-ec2'
import * as rds        from 'aws-cdk-lib/aws-rds'
import * as sm         from 'aws-cdk-lib/aws-secretsmanager'
import * as lambda_    from 'aws-cdk-lib/aws-lambda'
import * as iam        from 'aws-cdk-lib/aws-iam'
import * as ecr        from 'aws-cdk-lib/aws-ecr'
import * as ecs        from 'aws-cdk-lib/aws-ecs'
import * as ssm        from 'aws-cdk-lib/aws-ssm'
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline'
import * as cpactions  from 'aws-cdk-lib/aws-codepipeline-actions'
import * as codebuild  from 'aws-cdk-lib/aws-codebuild'
import * as cr         from 'aws-cdk-lib/custom-resources'
import * as logs       from 'aws-cdk-lib/aws-logs'
import * as amplify    from 'aws-cdk-lib/aws-amplify'
import * as path       from 'path'

export interface Prompt2TestStackProps extends cdk.StackProps {
  githubOwner: string
  githubConnectionArn: string
}

export class Prompt2TestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Prompt2TestStackProps) {
    super(scope, id, props)

    // ══════════════════════════════════════════════════════════════════════
    // 1. VPC + NETWORKING
    // ══════════════════════════════════════════════════════════════════════
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: 'prompt2test-vpc',
      maxAzs: 2,
      natGateways: 0, // cost saving — Fargate tasks use public subnets with public IP
      subnetConfiguration: [
        { cidrMask: 24, name: 'public',   subnetType: ec2.SubnetType.PUBLIC },
        { cidrMask: 24, name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    })

    // Aurora security group — allow RDS Data API (no inbound needed, Data API is HTTPS)
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'Aurora PostgreSQL — no inbound required (Data API only)',
      allowAllOutbound: false,
    })

    // ECS tasks security group — open MCP, noVNC, health ports
    const ecsSg = new ec2.SecurityGroup(this, 'EcsSg', {
      vpc,
      description: 'Playwright MCP Fargate tasks',
      allowAllOutbound: true,
    })
    ecsSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3000), 'MCP server')
    ecsSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(6080), 'noVNC')
    ecsSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(8080), 'Health check')


    // ══════════════════════════════════════════════════════════════════════
    // 2. COGNITO — USER POOL + IDENTITY POOL
    // ══════════════════════════════════════════════════════════════════════
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'prompt2test-users',
      selfSignUpEnabled: false,       // admin-only user creation
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      autoVerify: { email: true },
      standardAttributes: {
        email:    { required: true,  mutable: true },
        fullname: { required: false, mutable: true },
      },
      mfa: cognito.Mfa.OFF,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // keep users on stack destroy
    })

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: 'prompt2test-web',
      authFlows: {
        userPassword: true,
        userSrp:      true,
      },
      generateSecret: false, // browser client — no secret
    })

    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: 'prompt2test_identity',
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [{
        clientId:     userPoolClient.userPoolClientId,
        providerName: userPool.userPoolProviderName,
      }],
    })


    // ══════════════════════════════════════════════════════════════════════
    // 3. AURORA SERVERLESS v2 + SECRETS MANAGER
    // ══════════════════════════════════════════════════════════════════════
    const dbSecret = new sm.Secret(this, 'AuroraSecret', {
      secretName: 'prompt2test/aurora/credentials',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'prompt2test' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
    })

    const auroraCluster = new rds.DatabaseCluster(this, 'AuroraCluster', {
      clusterIdentifier: 'prompt2test-vectors',
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_15_4,
      }),
      serverlessV2MinCapacity: 0,   // 0 = auto-pause when idle (~zero cost at rest)
      serverlessV2MaxCapacity: 4,
      writer: rds.ClusterInstance.serverlessV2('writer'),
      credentials: rds.Credentials.fromSecret(dbSecret),
      defaultDatabaseName: 'prompt2test',
      enableDataApi: true,          // HTTP-based SQL — no VPC connection needed from Lambda
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT, // keep data on stack destroy
    })


    // ══════════════════════════════════════════════════════════════════════
    // 4. DB SCHEMA INIT (Custom Resource — runs once after Aurora is ready)
    // ══════════════════════════════════════════════════════════════════════
    const schemaInitRole = new iam.Role(this, 'SchemaInitRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        rds: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({
            actions: ['rds-data:ExecuteStatement'],
            resources: [auroraCluster.clusterArn],
          }),
          new iam.PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: [dbSecret.secretArn],
          }),
        ]}),
      },
    })

    // Inline Python Lambda that creates the pgvector schema
    const schemaInitFn = new lambda_.Function(this, 'SchemaInitFn', {
      functionName: 'p2t-schema-init',
      runtime: lambda_.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      timeout: cdk.Duration.minutes(5),
      role: schemaInitRole,
      environment: {
        CLUSTER_ARN: auroraCluster.clusterArn,
        SECRET_ARN:  dbSecret.secretArn,
      },
      code: lambda_.Code.fromInline(`
import boto3, json, os

rds     = boto3.client('rds-data')
CLUSTER = os.environ['CLUSTER_ARN']
SECRET  = os.environ['SECRET_ARN']
DB      = 'prompt2test'

STATEMENTS = [
  "CREATE EXTENSION IF NOT EXISTS vector",
  """CREATE TABLE IF NOT EXISTS test_cases (
    id           TEXT PRIMARY KEY,
    env          TEXT NOT NULL,
    service      TEXT DEFAULT '',
    description  TEXT NOT NULL,
    steps        JSONB DEFAULT '[]',
    tags         TEXT[] DEFAULT '{}',
    created_by   TEXT DEFAULT '',
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    last_result  TEXT,
    last_run_at  TIMESTAMPTZ,
    embedding    vector(1024)
  )""",
  """CREATE TABLE IF NOT EXISTS run_records (
    id           TEXT PRIMARY KEY,
    test_case_id TEXT REFERENCES test_cases(id) ON DELETE CASCADE,
    env          TEXT NOT NULL,
    result       TEXT NOT NULL,
    summary      TEXT DEFAULT '',
    run_by       TEXT DEFAULT '',
    run_at       TIMESTAMPTZ DEFAULT NOW()
  )""",
  "CREATE INDEX IF NOT EXISTS idx_tc_env   ON test_cases(env)",
  "CREATE INDEX IF NOT EXISTS idx_tc_svc   ON test_cases(service)",
  "CREATE INDEX IF NOT EXISTS idx_rr_tc    ON run_records(test_case_id)",
  "CREATE INDEX IF NOT EXISTS idx_rr_env   ON run_records(env)",
  "CREATE INDEX IF NOT EXISTS idx_embed    ON test_cases USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)",
]

def handler(event, context):
  print('Event:', json.dumps(event))
  if event.get('RequestType') == 'Delete':
    return {'PhysicalResourceId': 'schema-init'}
  for stmt in STATEMENTS:
    try:
      rds.execute_statement(resourceArn=CLUSTER, secretArn=SECRET, database=DB, sql=stmt)
      print('OK:', stmt[:80])
    except Exception as e:
      msg = str(e).lower()
      if 'already exists' in msg or 'duplicate' in msg:
        print('Already exists (OK):', stmt[:60])
      else:
        raise
  return {'PhysicalResourceId': 'schema-init'}
`),
    })

    const schemaProvider = new cr.Provider(this, 'SchemaProvider', {
      onEventHandler: schemaInitFn,
      logRetention: logs.RetentionDays.ONE_WEEK,
    })

    const schemaInit = new cdk.CustomResource(this, 'SchemaInit', {
      serviceToken: schemaProvider.serviceToken,
      properties: { ClusterArn: auroraCluster.clusterArn }, // re-run if cluster changes
    })
    schemaInit.node.addDependency(auroraCluster)


    // ══════════════════════════════════════════════════════════════════════
    // 5. LAMBDA FUNCTIONS — testcase-writer + testcase-reader
    // ══════════════════════════════════════════════════════════════════════
    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      roleName: 'prompt2test-lambda-role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        main: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({
            actions: ['rds-data:ExecuteStatement', 'rds-data:BatchExecuteStatement'],
            resources: [auroraCluster.clusterArn],
          }),
          new iam.PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: [dbSecret.secretArn],
          }),
          new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel'],
            resources: ['*'], // Titan Embed v2 — scoped to model in prod
          }),
        ]}),
      },
    })

    const lambdaEnv = {
      CLUSTER_ARN: auroraCluster.clusterArn,
      SECRET_ARN:  dbSecret.secretArn,
    }

    const writerFn = new lambda_.Function(this, 'TestcaseWriter', {
      functionName: 'p2t-testcase-writer',
      runtime:      lambda_.Runtime.PYTHON_3_12,
      handler:      'index.handler',
      timeout:      cdk.Duration.seconds(120),
      memorySize:   256,
      role:         lambdaRole,
      environment:  lambdaEnv,
      code: lambda_.Code.fromAsset(
        path.join(__dirname, '../../lambda/testcase-writer'),
      ),
    })

    const readerFn = new lambda_.Function(this, 'TestcaseReader', {
      functionName: 'p2t-testcase-reader',
      runtime:      lambda_.Runtime.PYTHON_3_12,
      handler:      'index.handler',
      timeout:      cdk.Duration.seconds(120),
      memorySize:   256,
      role:         lambdaRole,
      environment:  lambdaEnv,
      code: lambda_.Code.fromAsset(
        path.join(__dirname, '../../lambda/testcase-reader'),
      ),
    })


    // ══════════════════════════════════════════════════════════════════════
    // 6. ECR REPOSITORIES
    // ══════════════════════════════════════════════════════════════════════
    const agentRepo = new ecr.Repository(this, 'AgentRepo', {
      repositoryName: 'prompt2test-agent',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 5, description: 'Keep last 5 images' }],
    })

    const playwrightRepo = new ecr.Repository(this, 'PlaywrightRepo', {
      repositoryName: 'prompt2test-playwright-mcp',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 5, description: 'Keep last 5 images' }],
    })


    // ══════════════════════════════════════════════════════════════════════
    // 7. ECS FARGATE — PLAYWRIGHT MCP CLUSTER + TASK DEFINITION
    // ══════════════════════════════════════════════════════════════════════
    const ecsCluster = new ecs.Cluster(this, 'PlaywrightCluster', {
      clusterName: 'prompt2test-playwright-cluster',
      vpc,
      containerInsights: false, // enable for production
    })

    const taskRole = new iam.Role(this, 'PlaywrightTaskRole', {
      roleName: 'prompt2test-playwright-task-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    })

    const taskExecRole = new iam.Role(this, 'PlaywrightTaskExecRole', {
      roleName: 'prompt2test-playwright-exec-role',
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
    })

    const taskDef = new ecs.FargateTaskDefinition(this, 'PlaywrightTaskDef', {
      family:          'prompt2test-playwright-mcp',
      cpu:             2048,  // 2 vCPU (ARM64 Graviton)
      memoryLimitMiB:  4096,  // 4 GB
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
      taskRole,
      executionRole: taskExecRole,
    })

    taskDef.addContainer('playwright', {
      containerName: 'playwright-mcp',
      image: ecs.ContainerImage.fromEcrRepository(playwrightRepo, 'latest'),
      environment: { BROWSER_MODE: 'headed' },
      portMappings: [
        { containerPort: 3000, name: 'mcp'    },
        { containerPort: 6080, name: 'novnc'  },
        { containerPort: 8080, name: 'health' },
      ],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'playwright',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    })


    // ══════════════════════════════════════════════════════════════════════
    // 8. SSM PARAMETERS — ECS config (read by AgentCore at runtime)
    // ══════════════════════════════════════════════════════════════════════
    new ssm.StringParameter(this, 'SsmClusterName', {
      parameterName: '/prompt2test/playwright/cluster-name',
      stringValue:   ecsCluster.clusterName,
      description:   'ECS cluster for playwright-mcp tasks',
    })

    new ssm.StringParameter(this, 'SsmTaskDefFamily', {
      parameterName: '/prompt2test/playwright/task-definition-family',
      stringValue:   taskDef.family,
      description:   'Fargate task definition family',
    })

    new ssm.StringParameter(this, 'SsmSubnetIds', {
      parameterName: '/prompt2test/playwright/subnet-ids',
      stringValue:   vpc.publicSubnets.map(s => s.subnetId).join(','),
      description:   'Public subnet IDs for Fargate tasks (assignPublicIp=ENABLED)',
    })

    new ssm.StringParameter(this, 'SsmSecurityGroupId', {
      parameterName: '/prompt2test/playwright/security-group-id',
      stringValue:   ecsSg.securityGroupId,
      description:   'Security group for playwright-mcp tasks',
    })


    // ══════════════════════════════════════════════════════════════════════
    // 9. CODEPIPELINES — Playwright MCP + Agent (GitHub → ECR)
    // ══════════════════════════════════════════════════════════════════════

    // ── Playwright MCP pipeline ──────────────────────────────────────────
    const playwrightBuildRole = new iam.Role(this, 'PlaywrightBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      inlinePolicies: {
        ecr: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['ecr:*'],                   resources: [playwrightRepo.repositoryArn] }),
          new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }),
          new iam.PolicyStatement({ actions: ['logs:*'],                  resources: ['*'] }),
        ]}),
      },
    })

    const playwrightBuild = new codebuild.PipelineProject(this, 'PlaywrightBuild', {
      projectName: 'prompt2test-playwright-mcp-build',
      environment: {
        buildImage:  codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        privileged:  true, // required for docker build
      },
      environmentVariables: {
        ECR_REPO_URI:    { value: playwrightRepo.repositoryUri },
        AWS_ACCOUNT_ID:  { value: this.account },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: { commands: [
            'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
          ]},
          build:     { commands: ['docker build -t $ECR_REPO_URI:latest .'] },
          post_build: { commands: ['docker push $ECR_REPO_URI:latest'] },
        },
      }),
      role: playwrightBuildRole,
      logging: { cloudWatch: { logGroup: new logs.LogGroup(this, 'PlaywrightBuildLogs', { retention: logs.RetentionDays.ONE_WEEK }) } },
    })

    const playwrightArtifact = new codepipeline.Artifact()
    const playwrightPipeline = new codepipeline.Pipeline(this, 'PlaywrightPipeline', {
      pipelineName: 'prompt2test-playwright-mcp',
    })
    playwrightPipeline.addStage({
      stageName: 'Source',
      actions: [new cpactions.CodeStarConnectionsSourceAction({
        actionName:    'GitHub',
        connectionArn: props.githubConnectionArn,
        owner:         props.githubOwner,
        repo:          'Prompt2TestPlaywrightMCP',
        branch:        'main',
        output:        playwrightArtifact,
      })],
    })
    playwrightPipeline.addStage({
      stageName: 'Build',
      actions: [new cpactions.CodeBuildAction({
        actionName: 'DockerBuild',
        project:    playwrightBuild,
        input:      playwrightArtifact,
      })],
    })

    // ── Agent pipeline ───────────────────────────────────────────────────
    const agentBuildRole = new iam.Role(this, 'AgentBuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      inlinePolicies: {
        ecr: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({ actions: ['ecr:*'],                    resources: [agentRepo.repositoryArn] }),
          new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }),
          new iam.PolicyStatement({ actions: ['logs:*'],                   resources: ['*'] }),
        ]}),
      },
    })

    const agentBuild = new codebuild.PipelineProject(this, 'AgentBuild', {
      projectName: 'prompt2test-agent-build',
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        privileged: true,
      },
      environmentVariables: {
        ECR_REPO_URI:   { value: agentRepo.repositoryUri },
        AWS_ACCOUNT_ID: { value: this.account },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: { commands: [
            'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com',
          ]},
          build:     { commands: ['docker build -t $ECR_REPO_URI:latest .'] },
          post_build: { commands: ['docker push $ECR_REPO_URI:latest'] },
        },
      }),
      role: agentBuildRole,
      logging: { cloudWatch: { logGroup: new logs.LogGroup(this, 'AgentBuildLogs', { retention: logs.RetentionDays.ONE_WEEK }) } },
    })

    const agentArtifact  = new codepipeline.Artifact()
    const agentPipeline  = new codepipeline.Pipeline(this, 'AgentPipeline', {
      pipelineName: 'prompt2test-agent',
    })
    agentPipeline.addStage({
      stageName: 'Source',
      actions: [new cpactions.CodeStarConnectionsSourceAction({
        actionName:    'GitHub',
        connectionArn: props.githubConnectionArn,
        owner:         props.githubOwner,
        repo:          'Prompt2TestAgent',
        branch:        'main',
        output:        agentArtifact,
      })],
    })
    agentPipeline.addStage({
      stageName: 'Build',
      actions: [new cpactions.CodeBuildAction({
        actionName: 'DockerBuild',
        project:    agentBuild,
        input:      agentArtifact,
      })],
    })


    // ══════════════════════════════════════════════════════════════════════
    // 10. AGENTCORE IAM ROLE (used when creating the runtime manually)
    // ══════════════════════════════════════════════════════════════════════
    const agentCoreRole = new iam.Role(this, 'AgentCoreRole', {
      roleName: 'prompt2test-agentcore-role',
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('bedrock.amazonaws.com'),
        new iam.ServicePrincipal('agentcore.bedrock.amazonaws.com'), // AgentCore service
      ),
      inlinePolicies: {
        main: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({
            sid: 'BedrockModels',
            actions: ['bedrock:InvokeModel', 'bedrock:ConverseStream', 'bedrock:InvokeModelWithResponseStream'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'SsmConfig',
            actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
            resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/prompt2test/*`],
          }),
          new iam.PolicyStatement({
            sid: 'EcsTasks',
            actions: ['ecs:RunTask', 'ecs:DescribeTasks', 'ecs:StopTask'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'Eni',
            actions: ['ec2:DescribeNetworkInterfaces'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'PassRoleToEcs',
            actions: ['iam:PassRole'],
            resources: [taskRole.roleArn, taskExecRole.roleArn],
          }),
          new iam.PolicyStatement({
            sid: 'Ecr',
            actions: ['ecr:GetAuthorizationToken', 'ecr:BatchCheckLayerAvailability',
                      'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'Logs',
            actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: ['*'],
          }),
        ]}),
      },
    })


    // ══════════════════════════════════════════════════════════════════════
    // 11. COGNITO IDENTITY POOL AUTH ROLE
    //     Grants browser SDK calls: Lambda, SSM, Bedrock, Cognito IDP
    // ══════════════════════════════════════════════════════════════════════
    const authenticatedRole = new iam.Role(this, 'CognitoAuthRole', {
      roleName: 'prompt2test-cognito-auth-role',
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: { 'cognito-identity.amazonaws.com:aud': identityPool.ref },
          'ForAnyValue:StringLike': { 'cognito-identity.amazonaws.com:amr': 'authenticated' },
        },
        'sts:AssumeRoleWithWebIdentity',
      ),
      inlinePolicies: {
        main: new iam.PolicyDocument({ statements: [
          new iam.PolicyStatement({
            sid: 'InvokeLambda',
            actions: ['lambda:InvokeFunction'],
            resources: [writerFn.functionArn, readerFn.functionArn],
          }),
          new iam.PolicyStatement({
            sid: 'SsmConfig',
            actions: [
              'ssm:GetParameter', 'ssm:GetParametersByPath',
              'ssm:PutParameter',  'ssm:DeleteParameter',
            ],
            resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/prompt2test/*`],
          }),
          new iam.PolicyStatement({
            sid: 'BedrockAgent',
            actions: ['bedrock:InvokeAgentRuntime'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'CognitoAdmin',
            actions: [
              'cognito-idp:ListUsers',
              'cognito-idp:AdminCreateUser',
              'cognito-idp:AdminDeleteUser',
              'cognito-idp:AdminSetUserPassword',
            ],
            resources: [userPool.userPoolArn],
          }),
        ]}),
      },
    })

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoles', {
      identityPoolId: identityPool.ref,
      roles: { authenticated: authenticatedRole.roleArn },
    })


    // ══════════════════════════════════════════════════════════════════════
    // 12. AMPLIFY HOSTING — React UI (auto-deploy from GitHub)
    // ══════════════════════════════════════════════════════════════════════
    const amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
      name: 'Prompt2TestUI',
      repository: `https://github.com/${props.githubOwner}/Prompt2TestUI`,
      // GitHub connection via CodeStar — same connection used by pipelines
      // Note: Amplify needs the connection ARN in the IAM role, not directly here.
      // See README for GitHub OAuth token setup.
      buildSpec: [
        'version: 1',
        'frontend:',
        '  phases:',
        '    preBuild:',
        '      commands:',
        '        - cd web && npm ci',
        '    build:',
        '      commands:',
        '        - npm run build',
        '  artifacts:',
        '    baseDirectory: web/dist',
        '    files:',
        '      - "**/*"',
        '  cache:',
        '    paths:',
        '      - web/node_modules/**/*',
      ].join('\n'),
      environmentVariables: [
        { name: 'VITE_AWS_REGION',          value: this.region },
        { name: 'VITE_USER_POOL_ID',         value: userPool.userPoolId },
        { name: 'VITE_USER_POOL_CLIENT_ID',  value: userPoolClient.userPoolClientId },
        { name: 'VITE_IDENTITY_POOL_ID',     value: identityPool.ref },
        // Set VITE_AGENT_RUNTIME_ARN after creating AgentCore runtime (post-deploy step)
        { name: 'VITE_AGENT_RUNTIME_ARN',    value: 'REPLACE_AFTER_AGENTCORE_DEPLOY' },
      ],
    })

    new amplify.CfnBranch(this, 'AmplifyMasterBranch', {
      appId:      amplifyApp.attrAppId,
      branchName: 'master',
      enableAutoBuild: true,
    })


    // ══════════════════════════════════════════════════════════════════════
    // 13. STACK OUTPUTS — copy these into .env / Amplify env vars
    // ══════════════════════════════════════════════════════════════════════
    new cdk.CfnOutput(this, 'OutUserPoolId',        { value: userPool.userPoolId,            exportName: 'P2T-UserPoolId',        description: '→ VITE_USER_POOL_ID' })
    new cdk.CfnOutput(this, 'OutUserPoolClientId',  { value: userPoolClient.userPoolClientId, exportName: 'P2T-UserPoolClientId',  description: '→ VITE_USER_POOL_CLIENT_ID' })
    new cdk.CfnOutput(this, 'OutIdentityPoolId',    { value: identityPool.ref,               exportName: 'P2T-IdentityPoolId',    description: '→ VITE_IDENTITY_POOL_ID' })
    new cdk.CfnOutput(this, 'OutRegion',            { value: this.region,                    exportName: 'P2T-Region',            description: '→ VITE_AWS_REGION' })
    new cdk.CfnOutput(this, 'OutAgentCoreRoleArn',  { value: agentCoreRole.roleArn,          exportName: 'P2T-AgentCoreRoleArn',  description: 'Use when creating AgentCore runtime' })
    new cdk.CfnOutput(this, 'OutAgentEcrUri',       { value: agentRepo.repositoryUri,        exportName: 'P2T-AgentEcrUri',       description: 'Use when creating AgentCore runtime' })
    new cdk.CfnOutput(this, 'OutPlaywrightEcrUri',  { value: playwrightRepo.repositoryUri,   exportName: 'P2T-PlaywrightEcrUri' })
    new cdk.CfnOutput(this, 'OutAuroraClusterArn',  { value: auroraCluster.clusterArn,       exportName: 'P2T-AuroraClusterArn' })
    new cdk.CfnOutput(this, 'OutAuroraSecretArn',   { value: dbSecret.secretArn,             exportName: 'P2T-AuroraSecretArn' })
    new cdk.CfnOutput(this, 'OutWriterFnArn',       { value: writerFn.functionArn,           exportName: 'P2T-WriterFnArn' })
    new cdk.CfnOutput(this, 'OutReaderFnArn',       { value: readerFn.functionArn,           exportName: 'P2T-ReaderFnArn' })
    new cdk.CfnOutput(this, 'OutAmplifyAppId',      { value: amplifyApp.attrAppId,           exportName: 'P2T-AmplifyAppId',      description: 'Connect GitHub OAuth in Amplify console' })
    new cdk.CfnOutput(this, 'OutEcsClusterName',    { value: ecsCluster.clusterName,         exportName: 'P2T-EcsClusterName' })
  }
}

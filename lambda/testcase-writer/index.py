import json
import boto3
import uuid
import time
import os

rds    = boto3.client('rds-data',       region_name='us-east-1')
br     = boto3.client('bedrock-runtime', region_name='us-east-1')

# CDK sets these env vars; fallback to existing ARNs for the original account
CLUSTER = os.environ.get('CLUSTER_ARN', 'arn:aws:rds:us-east-1:590183962483:cluster:prompt2test-vectors')
SECRET  = os.environ.get('SECRET_ARN',  'arn:aws:secretsmanager:us-east-1:590183962483:secret:prompt2test/aurora/credentials-ITbucn')
DB      = 'prompt2test'

def sql(statement, params=None, retries=8, delay=8):
    kwargs = dict(resourceArn=CLUSTER, secretArn=SECRET, database=DB, sql=statement)
    if params:
        kwargs['parameters'] = params
    for attempt in range(retries):
        try:
            return rds.execute_statement(**kwargs)
        except rds.exceptions.from_code('DatabaseResumingException'):
            if attempt < retries - 1:
                print(f'Aurora resuming, waiting {delay}s (attempt {attempt+1}/{retries})...')
                time.sleep(delay)
            else:
                raise
        except Exception as e:
            if 'DatabaseResumingException' in str(e) or 'resuming' in str(e).lower():
                if attempt < retries - 1:
                    print(f'Aurora resuming (str match), waiting {delay}s (attempt {attempt+1}/{retries})...')
                    time.sleep(delay)
                else:
                    raise
            else:
                raise

def embed(text):
    r = br.invoke_model(
        modelId='amazon.titan-embed-text-v2:0',
        body=json.dumps({'inputText': text[:8000]})
    )
    return json.loads(r['body'].read())['embedding']

def vec_str(v):
    return '[' + ','.join(str(x) for x in v) + ']'

def handler(event, context):
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Content-Type': 'application/json',
    }

    body = event if isinstance(event.get('action'), str) else json.loads(event.get('body') or '{}')
    action = body.get('action')

    try:
        # ── Save Test Case ──────────────────────────────────────────────
        if action == 'save_test_case':
            tc_id       = 'tc_' + uuid.uuid4().hex[:12]
            description = body['description']
            env         = body.get('env', 'dev')
            service     = body.get('service', '')
            steps       = json.dumps(body.get('steps', []))
            tags        = body.get('tags', [])
            created_by  = body.get('createdBy', '')

            embedding = embed(description)

            sql(
                '''INSERT INTO test_cases
                   (id, env, service, description, steps, tags, created_by, embedding)
                   VALUES (:id,:env,:service,:description,:steps,:tags::text[],:created_by,:emb::vector)
                   ON CONFLICT (id) DO NOTHING''',
                [
                    {'name':'id',          'value':{'stringValue': tc_id}},
                    {'name':'env',         'value':{'stringValue': env}},
                    {'name':'service',     'value':{'stringValue': service}},
                    {'name':'description', 'value':{'stringValue': description}},
                    {'name':'steps',       'value':{'stringValue': steps}, 'typeHint':'JSON'},
                    {'name':'tags',        'value':{'stringValue': '{' + ','.join(tags) + '}'}},
                    {'name':'created_by',  'value':{'stringValue': created_by}},
                    {'name':'emb',         'value':{'stringValue': vec_str(embedding)}},
                ]
            )
            return {'statusCode': 200, 'headers': headers, 'body': json.dumps({'id': tc_id})}

        # ── Save Run Record ─────────────────────────────────────────────
        elif action == 'save_run_record':
            run_id      = 'run_' + uuid.uuid4().hex[:12]
            tc_id       = body['testCaseId']
            env         = body.get('env', 'dev')
            result      = body['result']   # PASS | FAIL
            summary     = body.get('summary', '')
            run_by      = body.get('runBy', '')

            sql(
                '''INSERT INTO run_records (id, test_case_id, env, result, summary, run_by)
                   VALUES (:id,:tc_id,:env,:result,:summary,:run_by)''',
                [
                    {'name':'id',      'value':{'stringValue': run_id}},
                    {'name':'tc_id',   'value':{'stringValue': tc_id}},
                    {'name':'env',     'value':{'stringValue': env}},
                    {'name':'result',  'value':{'stringValue': result}},
                    {'name':'summary', 'value':{'stringValue': summary}},
                    {'name':'run_by',  'value':{'stringValue': run_by}},
                ]
            )
            sql(
                'UPDATE test_cases SET last_result=:r, last_run_at=NOW() WHERE id=:id',
                [
                    {'name':'r',  'value':{'stringValue': result}},
                    {'name':'id', 'value':{'stringValue': tc_id}},
                ]
            )
            return {'statusCode': 200, 'headers': headers, 'body': json.dumps({'id': run_id})}

        # ── Update Test Case ─────────────────────────────────────────────
        elif action == 'update_test_case':
            tc_id   = body['id']
            service = body.get('service', '')
            sql('UPDATE test_cases SET service = :service WHERE id = :id',
                [
                    {'name':'service', 'value':{'stringValue': service}},
                    {'name':'id',      'value':{'stringValue': tc_id}},
                ])
            return {'statusCode': 200, 'headers': headers, 'body': json.dumps({'updated': tc_id})}

        # ── Delete Test Case ─────────────────────────────────────────────
        elif action == 'delete_test_case':
            tc_id = body['id']
            sql('DELETE FROM run_records WHERE test_case_id = :id',
                [{'name':'id', 'value':{'stringValue': tc_id}}])
            sql('DELETE FROM test_cases WHERE id = :id',
                [{'name':'id', 'value':{'stringValue': tc_id}}])
            return {'statusCode': 200, 'headers': headers, 'body': json.dumps({'deleted': tc_id})}

        else:
            return {'statusCode': 400, 'headers': headers, 'body': json.dumps({'error': f'Unknown action: {action}'})}

    except Exception as e:
        print(f'Error: {e}')
        return {'statusCode': 500, 'headers': headers, 'body': json.dumps({'error': str(e)})}

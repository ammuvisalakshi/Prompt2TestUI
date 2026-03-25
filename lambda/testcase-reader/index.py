import json
import boto3

rds = boto3.client('rds-data',        region_name='us-east-1')
br  = boto3.client('bedrock-runtime', region_name='us-east-1')

CLUSTER = 'arn:aws:rds:us-east-1:590183962483:cluster:prompt2test-vectors'
SECRET  = 'arn:aws:secretsmanager:us-east-1:590183962483:secret:prompt2test/aurora/credentials-ITbucn'
DB      = 'prompt2test'

def sql(statement, params=None):
    kwargs = dict(resourceArn=CLUSTER, secretArn=SECRET, database=DB, sql=statement)
    if params:
        kwargs['parameters'] = params
    return rds.execute_statement(**kwargs)

def embed(text):
    r = br.invoke_model(
        modelId='amazon.titan-embed-text-v2:0',
        body=json.dumps({'inputText': text[:8000]})
    )
    return json.loads(r['body'].read())['embedding']

def vec_str(v):
    return '[' + ','.join(str(x) for x in v) + ']'

def cell(c):
    if c.get('isNull'):
        return None
    return (c.get('stringValue') or c.get('longValue') or
            c.get('doubleValue') or c.get('booleanValue'))

def parse_tags(raw):
    if not raw:
        return []
    return [t for t in raw.strip('{}').split(',') if t]

def handler(event, context):
    headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        'Content-Type': 'application/json',
    }

    body = event if isinstance(event.get('action'), str) else json.loads(event.get('body') or '{}')
    action = body.get('action')

    try:
        # ── List Test Cases ─────────────────────────────────────────────
        if action == 'list_test_cases':
            env = body.get('env', 'dev')
            res = sql(
                '''SELECT tc.id, tc.env, tc.service, tc.description, tc.tags,
                          tc.created_by, tc.created_at::text, tc.last_result, tc.last_run_at::text,
                          (SELECT json_agg(json_build_object(
                              'id', r.id, 'result', r.result,
                              'runAt', r.run_at::text, 'runBy', r.run_by,
                              'summary', r.summary
                           ) ORDER BY r.run_at DESC)
                           FROM (SELECT * FROM run_records WHERE test_case_id = tc.id
                                 ORDER BY run_at DESC LIMIT 5) r
                          ) as runs
                   FROM test_cases tc
                   WHERE tc.env = :env
                   ORDER BY tc.created_at DESC''',
                [{'name':'env','value':{'stringValue': env}}]
            )
            items = []
            for row in res['records']:
                items.append({
                    'id':          cell(row[0]),
                    'env':         cell(row[1]),
                    'service':     cell(row[2]) or '',
                    'description': cell(row[3]),
                    'tags':        parse_tags(cell(row[4])),
                    'createdBy':   cell(row[5]) or '',
                    'createdAt':   cell(row[6]),
                    'lastResult':  cell(row[7]),
                    'lastRunAt':   cell(row[8]),
                    'runs':        json.loads(cell(row[9])) if cell(row[9]) else [],
                })
            return {'statusCode': 200, 'headers': headers, 'body': json.dumps(items)}

        # ── List Run Records ────────────────────────────────────────────
        elif action == 'list_run_records':
            env = body.get('env', 'dev')
            res = sql(
                '''SELECT r.id, r.test_case_id, tc.description, r.env,
                          r.result, r.summary, r.run_by, r.run_at::text
                   FROM run_records r
                   JOIN test_cases tc ON tc.id = r.test_case_id
                   WHERE r.env = :env
                   ORDER BY r.run_at DESC
                   LIMIT 100''',
                [{'name':'env','value':{'stringValue': env}}]
            )
            items = []
            for row in res['records']:
                items.append({
                    'id':          cell(row[0]),
                    'testCaseId':  cell(row[1]),
                    'description': cell(row[2]),
                    'env':         cell(row[3]),
                    'result':      cell(row[4]),
                    'summary':     cell(row[5]) or '',
                    'runBy':       cell(row[6]) or '',
                    'runAt':       cell(row[7]),
                })
            return {'statusCode': 200, 'headers': headers, 'body': json.dumps(items)}

        # ── Get Single Test Case ─────────────────────────────────────────
        elif action == 'get_test_case':
            tc_id = body['id']
            res = sql(
                '''SELECT id, env, service, description, steps::text, tags,
                          created_by, created_at::text, last_result, last_run_at::text
                   FROM test_cases WHERE id = :id''',
                [{'name':'id', 'value':{'stringValue': tc_id}}]
            )
            if not res['records']:
                return {'statusCode': 404, 'headers': headers, 'body': json.dumps({'error': 'Not found'})}
            row = res['records'][0]
            return {'statusCode': 200, 'headers': headers, 'body': json.dumps({
                'id':          cell(row[0]),
                'env':         cell(row[1]),
                'service':     cell(row[2]) or '',
                'description': cell(row[3]),
                'steps':       json.loads(cell(row[4]) or '[]'),
                'tags':        parse_tags(cell(row[5])),
                'createdBy':   cell(row[6]) or '',
                'createdAt':   cell(row[7]),
                'lastResult':  cell(row[8]),
                'lastRunAt':   cell(row[9]),
            })}

        # ── Semantic Search ─────────────────────────────────────────────
        elif action == 'search':
            query     = body.get('query', '')
            env       = body.get('env', 'dev')
            threshold = float(body.get('threshold', 0.75))
            limit     = int(body.get('limit', 5))

            if not query.strip():
                return {'statusCode': 200, 'headers': headers, 'body': json.dumps([])}

            embedding = embed(query)
            res = sql(
                '''SELECT id, env, service, description, tags, last_result,
                          1 - (embedding <=> :emb::vector) as similarity
                   FROM test_cases
                   WHERE env = :env AND embedding IS NOT NULL
                   ORDER BY embedding <=> :emb::vector
                   LIMIT :lim''',
                [
                    {'name':'emb', 'value':{'stringValue': vec_str(embedding)}},
                    {'name':'env', 'value':{'stringValue': env}},
                    {'name':'lim', 'value':{'longValue': limit}},
                ]
            )
            matches = []
            for row in res['records']:
                sim = row[6].get('doubleValue', 0)
                if sim >= threshold:
                    matches.append({
                        'id':          cell(row[0]),
                        'env':         cell(row[1]),
                        'service':     cell(row[2]) or '',
                        'description': cell(row[3]),
                        'tags':        parse_tags(cell(row[4])),
                        'lastResult':  cell(row[5]),
                        'similarity':  round(sim * 100),
                    })
            return {'statusCode': 200, 'headers': headers, 'body': json.dumps(matches)}

        else:
            return {'statusCode': 400, 'headers': headers, 'body': json.dumps({'error': f'Unknown action: {action}'})}

    except Exception as e:
        print(f'Error: {e}')
        return {'statusCode': 500, 'headers': headers, 'body': json.dumps({'error': str(e)})}

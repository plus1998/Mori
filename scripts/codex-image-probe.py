#!/usr/bin/env python3
"""最小实测：只读登录凭证，查询两条额度链路，可选生成一张图片。

python3 scripts/codex-image-probe.py --generate --output-dir /tmp/eco-image-probe
python3 scripts/codex-image-probe.py --account-db /path/eco-coding.sqlite --account-id oa_xxx
凭证只发送给 chatgpt.com；不刷新 token，不切换账号，不写入账号数据库。
"""
import argparse
import base64
import hashlib
import json
import sqlite3
import struct
import time
import urllib.error
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--auth-file', type=Path, default=Path.home() / '.codex/auth.json')
    parser.add_argument('--account-db', type=Path)
    parser.add_argument('--account-id')
    parser.add_argument('--generate', action='store_true')
    parser.add_argument('--model', default='gpt-6.1-sol', help='Codex Responses 编排模型，可显式覆盖')
    parser.add_argument('--output-dir', type=Path, default=Path('/tmp/eco-image-probe'))
    args = parser.parse_args()
    if args.account_db:
        if not args.account_id:
            parser.error('--account-db 必须同时指定 --account-id')
        with sqlite3.connect(args.account_db.resolve().as_uri() + '?mode=ro', uri=True) as db:
            row = db.execute('SELECT auth_json, proxy_url FROM openai_accounts WHERE id = ?',
                             (args.account_id,)).fetchone()
        if not row or not row[0]:
            raise SystemExit('指定账号不存在或没有登录凭证')
        if row[1]:
            raise SystemExit('该账号配置了独立代理；此最小探针尚未实现账号代理，停止以免走错出口')
        auth = json.loads(row[0])
    else:
        auth = json.loads(args.auth_file.read_text())
    tokens = auth.get('tokens', auth)
    token, account_id = tokens.get('access_token'), tokens.get('account_id')
    if not token or not account_id:
        raise SystemExit('凭证缺少 access_token 或 account_id')
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report = {'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'source': 'eco-account' if args.account_db else 'auth-file', 'requests': []}

    def safe_error(text):
        return text.replace(token, '[redacted]').replace(account_id, '[redacted]')[:1000]

    def request(path, body=None, timeout=30):
        headers = {'Authorization': 'Bearer ' + token, 'ChatGPT-Account-Id': account_id,
                   'Content-Type': 'application/json', 'OpenAI-Beta': 'codex-1',
                   'originator': 'Codex Desktop'}
        req = urllib.request.Request('https://chatgpt.com' + path,
                                     json.dumps(body).encode() if body is not None else None,
                                     headers)
        return urllib.request.urlopen(req, timeout=timeout)

    def quota(path, body=None):
        result = {'path': path}
        try:
            with request(path, body) as response:
                data = json.load(response)
                result.update(status=response.status, keys=list(data))
            if path.endswith('/usage'):
                result.update({key: data.get(key) for key in
                               ['plan_type', 'rate_limit', 'additional_rate_limits', 'model_usage']})
            else:
                limits = data.get('limits_progress')
                result['limits_progress'] = limits
                result['image_gen'] = ([item for item in limits
                                        if isinstance(item, dict) and item.get('feature_name') == 'image_gen']
                                       if isinstance(limits, list) else None)
        except urllib.error.HTTPError as error:
            result.update(status=error.code, error=safe_error(error.read().decode('utf-8', 'replace')))
        except Exception as error:
            result['error'] = safe_error(str(error))
        report['requests'].append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return result

    quota('/backend-api/wham/usage')
    quota('/backend-api/conversation/init', {'gizmo_id': None, 'requested_default_model': None,
                                           'conversation_id': None, 'timezone_offset_min': -480})
    generation_ok = not args.generate
    if args.generate:
        result = {'path': '/backend-api/codex/responses', 'model': args.model,
                  'image_model': 'gpt-image-2', 'event_types': {}, 'images': []}
        started = time.monotonic()
        payload = {
            'model': args.model, 'store': False, 'stream': True,
            'instructions': "Use the image_generation tool to create exactly one image for the user's request. Return the generated image result.",
            'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text':
                'Generate a simple flat illustration of a small green leaf centered on a white square background. No text.'}]}],
            'tools': [{'type': 'image_generation', 'model': 'gpt-image-2', 'action': 'generate',
                       'size': '1024x1024', 'quality': 'low', 'output_format': 'png'}],
            'tool_choice': {'type': 'image_generation'},
        }
        seen = set()

        def scan(value):
            if isinstance(value, dict):
                if value.get('type') == 'image_generation_call' and isinstance(value.get('result'), str):
                    encoded = value['result']
                    if encoded.startswith('data:image/'):
                        encoded = encoded.split(',', 1)[1]
                    image = base64.b64decode(encoded, validate=True)
                    digest = hashlib.sha256(image).hexdigest()
                    if digest not in seen:
                        if image[:8] != b'\x89PNG\r\n\x1a\n':
                            raise ValueError('返回图片不是 PNG')
                        seen.add(digest)
                        width, height = struct.unpack('>II', image[16:24])
                        name = 'generated-' + str(len(seen)) + '.png'
                        (args.output_dir / name).write_bytes(image)
                        result['images'].append({'file': name, 'bytes': len(image), 'sha256': digest,
                                                 'width': width, 'height': height})
                for item in value.values():
                    scan(item)
            elif isinstance(value, list):
                for item in value:
                    scan(item)

        def event(raw):
            if raw.strip() == '[DONE]':
                return
            value = json.loads(raw)
            kind = value.get('type', '<missing>')
            result['event_types'][kind] = result['event_types'].get(kind, 0) + 1
            if kind in ('error', 'response.failed', 'response.incomplete'):
                detail = value.get('error') or value.get('response', {}).get('error')
                result.setdefault('errors', []).append(safe_error(json.dumps(detail or value)))
            scan(value)
            print('event:', kind, flush=True)

        try:
            print('generating one image...', flush=True)
            with request(result['path'], payload, timeout=180) as response:
                result['status'] = response.status
                if 'application/json' in response.headers.get('content-type', ''):
                    event(response.read().decode())
                else:
                    lines = []
                    for line in response:
                        line = line.decode('utf-8').rstrip('\r\n')
                        if not line:
                            if lines:
                                event('\n'.join(lines))
                                lines = []
                        elif line.startswith('data:'):
                            lines.append(line[5:].lstrip())
                    if lines:
                        event('\n'.join(lines))
            generation_ok = (bool(result['images']) and not result.get('errors')
                             and result['event_types'].get('response.completed', 0) > 0)
            result['success'] = generation_ok
            if not generation_ok:
                result['error'] = '没有获得成功的图片生成结果'
        except urllib.error.HTTPError as error:
            result.update(status=error.code, error=safe_error(error.read().decode('utf-8', 'replace')))
        except Exception as error:
            result['error'] = safe_error(str(error))
        result['elapsed_seconds'] = round(time.monotonic() - started, 2)
        report['requests'].append(result)
        print(json.dumps(result, ensure_ascii=False), flush=True)
        quota('/backend-api/wham/usage')
    (args.output_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print('report:', args.output_dir / 'report.json')
    raise SystemExit(0 if generation_ok else 1)


if __name__ == '__main__':
    main()

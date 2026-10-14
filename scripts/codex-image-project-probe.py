#!/usr/bin/env python3
"""直接加载 chatgpt2api 原项目，验证其额度查询与本地账号轮转。

用安装了原项目依赖的 Python 运行，--project-dir 指定检出的项目目录。
实际凭证只在内存中使用；不调用 token 刷新，不加入第三方项目账号池。
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-dir', type=Path, required=True)
    parser.add_argument('--auth-file', type=Path, default=Path.home() / '.codex/auth.json')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--generate', action='store_true', help='通过项目原有 Codex 生图方法生成一张，再查询额度')
    args = parser.parse_args()
    sys.path.insert(0, str(args.project_dir.resolve()))
    from utils.log import logger
    # 原项目 debug 日志含邮箱和账号 ID；实测只输出下面的字段白名单。
    logger._logger.disabled = True
    from services.openai_backend_api import OpenAIBackendAPI
    from services.account_service import AccountService, account_service
    from services.storage.json_storage import JSONStorageBackend

    report = {'project_client': 'OpenAIBackendAPI', 'quota': {}, 'local_pool': {}}
    auth = json.loads(args.auth_file.read_text())
    token = auth.get('tokens', auth).get('access_token')
    if not token:
        raise SystemExit('登录凭证缺少 access_token')

    def safe(error):
        return str(error).replace(token, '[redacted]')[:700]

    # 直接执行原项目 get_user_info，不自行拼装 headers / TLS 指纹。
    with OpenAIBackendAPI(token) as backend:
        try:
            info = backend.get_user_info()
            report['quota'] = {'success': True, **{key: info.get(key) for key in
                                ['type', 'quota', 'limits_progress', 'restore_at', 'status']}}
        except Exception as error:
            report['quota'] = {'success': False, 'error': safe(error)}
            # get_user_info 并发调用三个接口；失败后分别重测以确定哪个环节失败。
            def diagnose(name, method):
                try:
                    data = method()
                    result = {'method': name, 'success': True}
                    if name == '_get_conversation_init':
                        result['limits_progress'] = data.get('limits_progress')
                    elif name == '_get_default_account':
                        result['plan_type'] = data.get('plan_type')
                    return result
                except Exception as error:
                    return {'method': name, 'success': False, 'error': safe(error)}
            with ThreadPoolExecutor(max_workers=3) as executor:
                futures = [executor.submit(diagnose, name, getattr(backend, name)) for name in
                           ['_get_me', '_get_conversation_init', '_get_default_account']]
                report['quota']['diagnostics'] = [f.result() for f in futures]
    print(json.dumps({'quota': report['quota']}, ensure_ascii=False), flush=True)

    if args.generate:
        # 仅在内存中登记来源，满足项目 _ensure_codex_source_account 的真实检查。
        # 不调用 add_accounts / fetch_remote_info，避免保存或刷新实际登录凭证。
        account_service._accounts[token] = {'access_token': token, 'source_type': 'codex',
                                           'type': 'Plus', 'status': '正常',
                                           'quota': report['quota'].get('quota')}
        generation = {'events': {}, 'success': False}
        started = time.monotonic()
        try:
            with OpenAIBackendAPI(token) as backend:
                images = []
                def scan(value):
                    if isinstance(value, dict):
                        if value.get('type') == 'image_generation_call' and isinstance(value.get('result'), str):
                            images.append(value['result'])
                        for item in value.values():
                            scan(item)
                    elif isinstance(value, list):
                        for item in value:
                            scan(item)
                print('project Codex generation started...', flush=True)
                for event in backend.iter_codex_image_response_events(
                        prompt='A simple flat illustration of one blue circle centered on white. No text.',
                        size='1024x1024', quality='low'):
                    kind = event.get('type', '<missing>')
                    generation['events'][kind] = generation['events'].get(kind, 0) + 1
                    scan(event)
                    print('event:', kind, flush=True)
                if not images or 'response.completed' not in generation['events']:
                    raise ValueError('项目接口未返回完整成功图片')
                encoded = images[0]
                if encoded.startswith('data:image/'):
                    encoded = encoded.split(',', 1)[1]
                raw = base64.b64decode(encoded, validate=True)
                from io import BytesIO
                from PIL import Image
                with Image.open(BytesIO(raw)) as image:
                    generation['dimensions'] = list(image.size)
                    image.verify()
                destination = args.output.with_suffix('.png')
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(raw)
                generation.update(success=True, image_bytes=len(raw), image_file=destination.name)
                try:
                    after = backend.get_user_info()
                    generation['quota_after'] = {'success': True, **{key: after.get(key) for key in
                                                ['quota', 'limits_progress', 'restore_at', 'status']}}
                except Exception as error:
                    generation['quota_after'] = {'success': False, 'error': safe(error)}
        except Exception as error:
            generation['error'] = safe(error)
        finally:
            account_service._accounts.pop(token, None)
        generation['elapsed_seconds'] = round(time.monotonic() - started, 2)
        report['generation'] = generation
        print(json.dumps({'generation': generation}, ensure_ascii=False), flush=True)

    # 使用原项目的领取/释放函数验证本地调度；没有发送测试 token 到上游。
    with tempfile.TemporaryDirectory(prefix='eco-project-pool-') as temp:
        service = AccountService(JSONStorageBackend(Path(temp) / 'accounts.json'))
        def item(token, **extra):
            return {'access_token': token, 'status': '正常', 'quota': 3,
                    'type': 'Plus', 'source_type': 'codex', **extra}
        service._accounts = {x['access_token']: x for x in [
            item('A'), item('B'), item('disabled', status='禁用'),
            item('empty', quota=0), item('web', source_type='web'), item('free', type='Free')]}
        selected = []
        for _ in range(6):
            token = service._acquire_next_candidate_token(source_type='codex',
                                                          plan_types=('plus', 'team', 'pro'))
            selected.append(token)
            service.release_image_slot(token)
        assert selected == ['A', 'B', 'A', 'B', 'A', 'B'], selected
        service._accounts['A']['status'] = '禁用'
        after_disable = service._acquire_next_candidate_token(source_type='codex',
                                                              plan_types=('plus', 'team', 'pro'))
        service.release_image_slot(after_disable)
        assert after_disable == 'B', after_disable
        report['local_pool'] = {'success': True, 'selected': selected,
                                'after_disable_A': after_disable,
                                'scope': 'original selection code, synthetic accounts, no upstream calls'}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'local_pool': report['local_pool']}, ensure_ascii=False), flush=True)
    print('report:', args.output)


if __name__ == '__main__':
    main()

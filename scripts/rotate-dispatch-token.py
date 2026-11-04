#!/usr/bin/env python3
"""Hidden token input, non-executing dispatch permission check, Cloudflare update."""
import getpass
import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request
import uuid

REPO = 'frypanegg/ER_Radar'
WORKFLOW = 'daily-bargaining-update.yml'


def main():
    if not sys.stdin.isatty():
        raise RuntimeError('로컬 터미널에서 실행하세요. 비대화형 입력은 허용하지 않습니다.')
    token = getpass.getpass('새 fine-grained PAT (화면에 표시되지 않음): ').strip()
    if not token.startswith('github_pat_'):
        raise RuntimeError('Fine-grained PAT 형식이 아닙니다. 기존 Cloudflare 값은 변경하지 않았습니다.')
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'er-radar-token-rotation'}
    # An impossible ref asks GitHub to validate authentication/Actions permission
    # without starting the daily collector or sending its report email.
    missing_ref = 'er-radar-permission-check-' + str(uuid.uuid4())
    payload = json.dumps({'ref': missing_ref}).encode()
    request = urllib.request.Request(f'https://api.github.com/repos/{REPO}/actions/workflows/{WORKFLOW}/dispatches', data=payload, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30):
            raise RuntimeError('예상하지 못한 dispatch 응답. Cloudflare 값은 변경하지 않았습니다.')
    except urllib.error.HTTPError as error:
        if error.code != 422:
            raise RuntimeError(f'GitHub 인증/권한 검증 실패 (HTTP {error.code}). Cloudflare 값은 변경하지 않았습니다.') from None
        try:
            message = json.loads(error.read()).get('message', '')
        except (ValueError, TypeError):
            message = ''
        if error.code != 422 or message != f'No ref found for: {missing_ref}':
            raise RuntimeError(f'GitHub 인증/권한 검증 실패 (HTTP {error.code}). Cloudflare 값은 변경하지 않았습니다.') from None
    except urllib.error.URLError:
        raise RuntimeError('GitHub 연결 실패. Cloudflare 값은 변경하지 않았습니다.') from None
    print('GitHub dispatch 권한 검사 통과. 실제 워크플로는 실행하지 않았습니다.')
    root = pathlib.Path(__file__).resolve().parent.parent
    result = subprocess.run(['npx', '--no-install', 'wrangler', 'secret', 'put', 'GITHUB_DISPATCH_TOKEN', '--name', 'er-radar'],
                            input=token + '\n', text=True, cwd=root, capture_output=True)
    if result.returncode:
        raise RuntimeError('Cloudflare 비밀값 등록 실패. 인증 상태를 확인하고 다시 실행하세요. 상세 출력은 토큰 노출 방지를 위해 생략했습니다.')
    print('GITHUB_DISPATCH_TOKEN 교체 완료. 토큰 값은 파일·로그에 저장하지 않았습니다.')
    print('실제 예약 호출의 종단 검증은 다음 06:20 KST 실행으로 확인해야 합니다.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, KeyboardInterrupt) as error:
        print(str(error) or '취소됨')
        raise SystemExit(1)

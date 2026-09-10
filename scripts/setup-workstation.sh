#!/usr/bin/env bash
#
# 새 맥에서 이 저장소를 개발·운영할 수 있는 상태로 만든다.
#
# 공개 서비스는 이 스크립트와 무관하다. 수집·검증·커밋·배포는 GitHub Actions에서
# 돌고, 화면은 Cloudflare Workers가 서빙한다. 여기서 만드는 것은 그 파이프라인을
# 손볼 수 있는 작업대다. 그래서 이 스크립트는 무엇도 배포하지 않는다.
#
# 비밀값은 절대 화면에 찍지 않는다. 있는지와 길이만 알린다.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${KKJ_ENV:-$(dirname "$REPO_DIR")/kkj.env}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=13

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

missing=0

step "1. 도구 확인"

if ! command -v git >/dev/null 2>&1; then
  bad "git이 없다. 'xcode-select --install'을 먼저 실행한다."
  exit 1
fi
ok "git $(git --version | awk '{print $3}')"

if ! command -v node >/dev/null 2>&1; then
  bad "node가 없다. package.json이 요구하는 것은 >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 이다."
  if command -v brew >/dev/null 2>&1; then
    echo "     설치: brew install node"
  else
    echo "     설치: https://nodejs.org 에서 LTS를 받는다."
  fi
  exit 1
fi

node_version="$(node -p 'process.versions.node')"
node_major="${node_version%%.*}"
node_rest="${node_version#*.}"
node_minor="${node_rest%%.*}"
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ] ||
   { [ "$node_major" -eq "$MIN_NODE_MAJOR" ] && [ "$node_minor" -lt "$MIN_NODE_MINOR" ]; }; then
  bad "node $node_version은 너무 낮다. >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0이 필요하다."
  exit 1
fi
ok "node $node_version"

step "2. 의존성 설치"
cd "$REPO_DIR"
npm ci
ok "node_modules 준비 완료"

step "3. 비밀값 확인"
#
# 로컬 스크립트가 실제로 읽는 키만 본다. NAVER 자격증명은 GitHub 시크릿에만 있고
# 이 맥에는 필요 없다. 값은 찍지 않는다 — 이름과 길이만 본다.
required_keys=(
  SUPABASE_PJT_URL
  SUPABASE_SERVICE_ROLE_KEY
  DASHBOARD_ADMIN_CODE
  OPENDART_API_KEY
)

if [ ! -f "$ENV_FILE" ]; then
  warn "kkj.env가 없다: $ENV_FILE"
  echo "     이 파일은 깃에 없다. 기존 맥에서 직접 옮겨야 한다(에어드롭 권장)."
  echo "     없어도 대시보드 빌드·테스트는 되지만, Supabase를 건드리는 스크립트는 못 쓴다."
  missing=1
else
  # 형식은 'KEY = value'다. 등호 왼쪽만 보고, 값은 길이만 잰다.
  for key in "${required_keys[@]}"; do
    len="$(awk -F= -v k="$key" '
      {
        name = $1
        sub(/^[ \t]+/, "", name); sub(/[ \t]+$/, "", name)
        if (name == k) {
          value = substr($0, index($0, "=") + 1)
          sub(/^[ \t]+/, "", value); sub(/[ \t]+$/, "", value)
          print length(value); exit
        }
      }
    ' "$ENV_FILE")"
    if [ -n "$len" ] && [ "$len" -gt 0 ]; then
      ok "$key (${len}자)"
    else
      bad "$key 없음 또는 빈 값"
      missing=1
    fi
  done
fi

step "4. 회귀 검증"
#
# 빌드 + 타입 검사 + 테스트를 한 번에 돈다. 여기까지 통과하면 이 맥에서
# 파이프라인을 손볼 준비가 끝난 것이다.
npm test

step "완료"
if [ "$missing" -eq 0 ]; then
  ok "작업대 준비 끝. 저장소: $REPO_DIR"
else
  warn "테스트는 통과했지만 비밀값이 빠져 있다. 위 항목을 채우면 Supabase 스크립트도 쓸 수 있다."
fi

cat <<'NEXT'

  필요할 때만 추가로 붙이면 되는 것:
    gh auth login          수동으로 워크플로를 깨울 때(gh workflow run)
    npx wrangler login     이 맥에서 직접 배포할 때

  둘 다 없어도 매일 자동 수집·배포는 그대로 돈다. GitHub Actions가 하는 일이다.
NEXT

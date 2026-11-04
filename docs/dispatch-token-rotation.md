# Cloudflare 예약 호출 토큰 교체

- 대상: Worker `er-radar`의 `GITHUB_DISPATCH_TOKEN`.
- GitHub 소유자/저장소: `frypanegg` / `ER_Radar`만 선택. 기존 `Actions: Read and write`, Metadata 읽기 권한 유지. 다른 저장소나 쓰기 권한 추가 금지.
- 2026-11-04 점검: 비밀값 등록 확인, 06:20 KST 예약 호출 실행 성공(41720919160). GitHub 예비 스케줄도 유지한다.
- 메일 기준 약 2026-11-11 만료 예정. 정확한 만료일은 GitHub 설정에서 확인한다. 예비 스케줄이 있어도 주 예약 호출 토큰은 만료 전에 교체해야 한다.

## 실행

1. 사용자가 GitHub 설정에서 해당 토큰을 재발급한다. 가능하면 기존 토큰과 동일 범위의 교체 토큰을 별도로 발급해 기존 토큰을 검증 완료까지 유지한다. 재생성을 사용하면 기존 값이 즉시 무효화될 수 있으므로 아래 등록까지 연속 수행한다. 만료는 90일 등 유한 기간으로 설정하고 다음 교체일을 기록한다.
2. 로컬 터미널에서 `python3 scripts/rotate-dispatch-token.py`를 실행하고 새 토큰을 숨김 입력에 붙여 넣는다. 채팅·명령행 인자·저장소에 토큰을 넣지 않는다.
3. 도구는 기존 일일 수집 워크플로에 존재하지 않는 무작위 ref로 요청해 정확한 `422 No ref found` 응답(인증·권한 검사 통과 후 ref 검증 거절)을 확인한 뒤 `wrangler secret put GITHUB_DISPATCH_TOKEN --name er-radar`로 교체한다. 이 검사는 실제 워크플로를 실행하지 않으므로 수집·메일·자료 수정이 없다. 실제 Cloudflare 예약 호출 성공을 증명하는 검사는 아니며 다음 예약 실행에서 확인해야 한다. 권한 검증이 실패하면 Cloudflare 값은 변경하지 않는다.
4. 등록 성공 후 다음 06:20 KST 실행과 `data/automation-heartbeat.json`의 `lastCloudflareLaunchKstDate`를 확인한다. 새 토큰을 별도로 발급했다면 검증 후 기존 토큰을 폐기한다.

## 유지 관리

- GitHub 만료 알림 수신 시 같은 절차를 수행한다. 만료일 14일 전에 교체하도록 운영 일정을 잡는다.
- 기존 `check-collection-freshness.mjs`는 Cloudflare 예약 호출이 3일 연속 없으면 오류를 보고한다. GitHub 예비 호출이 성공하더라도 주 호출 고장을 별도로 감지한다.
- 장기적으로 GitHub App의 단기 설치 토큰 방식으로 전환하면 PAT 수동 갱신 의존을 줄일 수 있다. 앱 생성·설치·개인키 보관은 별도 변경 범위이며 이번 교체에 포함하지 않는다.

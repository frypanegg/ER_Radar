# 노사교섭 레이더

한국 주요 제조기업의 임금협상·단체협상 사건을 **원청 법인 직접고용 노조** 기준으로 추적하는 사실 데이터 대시보드입니다.

## 핵심 원칙

- 진행률 대신 `U`, `S0`–`S8` 주 단계와 조정·쟁의·대표성·인준 병렬 상태를 함께 표시합니다.
- 사건의 기본 키는 `법인 × 직접고용주 × 교섭연도 × 협약유형 × 교섭단위 × 적용범위`입니다.
- 하청·사내협력사·용역·파견·계열사 노조의 원청 상대 교섭은 공개 보드에서 제외하고 감사용 검토함으로 격리합니다.
- 상태 변화마다 원문 URL, 발생일·게시일, 출처 등급, 짧은 사실 주석을 기록합니다.
- 과반 노조 표시는 전체 직원 대비 가입률이 아니라 교섭창구 단일화 참여노조 조합원 기준으로만 `O/X/확인중`을 표기합니다.

## 구성

- `app/` — 법인 검색·교섭 단계 조회·연도별 사실 사건 상세·추적 기업 추가 요청 화면
- `docs/negotiation-framework.md` — 법률·연구 근거, 단계 모델, 데이터 규칙
- `data/company-universe.json` — 초기 추적 후보와 선정 점수 기준
- `data/historical-fact-seed.json` — 12개사 2021–2025 초기 사실 데이터. 원청 직접고용·원문 URL이 함께 확인된 행만 공개 후보로 포함
- `scripts/build-historical-seed.mjs` — 조사 결과를 공개 가능한 초기 사실 데이터로 병합·검증
- `scripts/collect-news.mjs` — KST 매일 06:30 기준 뉴스 후보 수집·범위 분류기
- `docs/data-pipeline.md` — 수집 운영과 안전 장치
- `docs/supabase-setup.md` — Supabase 테이블·RLS·환경 변수·초기 적재 운영 기준
- `docs/공유-접근과-검색비노출-정책.md` — 공유 URL 열람과 검색 비노출 정책

## 실행

```bash
npm install
npm run dev
npm test
```

뉴스 수집은 NAVER API HUB 자격증명이 있을 때 `NAVER_API_HUB_CLIENT_ID`, `NAVER_API_HUB_CLIENT_SECRET`을 설정한 뒤 실행합니다. 자세한 형식과 RSS 보조 탐색의 제한은 `docs/data-pipeline.md`를 참조하세요.

초기 과거 데이터는 다음 명령으로 병합합니다.

```bash
node scripts/build-historical-seed.mjs --as-of 2026-08-10
```

Supabase에 실제로 적재하기 전에는 대상 프로젝트를 명시적으로 선택하고, 서버 전용 환경 변수만 배포 플랫폼에 설정합니다. 자세한 절차는 `docs/supabase-setup.md`를 참조하세요.

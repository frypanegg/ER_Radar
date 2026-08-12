# Supabase 데이터베이스 설정·운영 기준

## 적용 상태

이 문서는 원청 직접고용 노조 교섭 대시보드의 Supabase 운영 기준이다. 현재 대상 프로젝트가 아직 확정되지 않았으므로, 마이그레이션과 데이터 적재는 수행하지 않았다.

프로젝트가 확정되면 [초기 마이그레이션](../supabase/migrations/20260810_initial_bargaining_dashboard.sql)을 승인된 Supabase 프로젝트에 한 번만 적용한다. 기존의 다른 서비스용 데이터베이스에는 제품 소유자의 명시적 승인 없이 적용하지 않는다.

## 공개 범위와 보안 원칙

대시보드는 로그인 없이 공유 URL로 열람할 수 있다. 데이터베이스에서도 `anon` 역할은 **검증·공개 완료된 사실 데이터의 읽기**만 가능하도록 설계한다.

| 구분 | 허용 범위 |
| --- | --- |
| `anon` | 공개된 법인·직접고용 노조·교섭사건·사건 타임라인·쟁점·합의 조건·원문 URL 주석의 `SELECT`만 허용 |
| `authenticated` | 기본 권한 없음. 이 제품은 로그인 사용자를 전제로 하지 않음 |
| `service_role` | 수집 결과 적재, 사람 검증 결과 반영, 공개 전환, 회사 추가 요청 저장 |
| 브라우저 | `service_role` 키에 절대 접근하지 않음 |

모든 `public` 스키마 테이블에 RLS(Row Level Security)를 활성화한다. `anon`에 `INSERT`, `UPDATE`, `DELETE` 권한 또는 정책을 만들지 않는다. 직접고용 범위를 통과하지 못한 후보와 회사 추가 요청은 `anon`에게 노출되지 않는다.

`service_role`은 RLS를 우회할 수 있으므로 Worker/서버 런타임에서만 사용한다. `NEXT_PUBLIC_` 접두사, 클라이언트 번들, 정적 파일, 브라우저 로그에 포함하면 안 된다.

## 필요한 환경 변수

값은 리포지터리의 `.env` 파일이나 소스 코드에 커밋하지 않는다. 배포 플랫폼의 암호화된 런타임 환경 변수에만 설정한다.

| 변수 | 용도 | 노출 위치 |
| --- | --- | --- |
| `SUPABASE_URL` | 선택된 Supabase 프로젝트 URL | Worker/서버 전용 |
| `SUPABASE_SERVICE_ROLE_KEY` | 적재·검토·회사 추가 요청을 위한 서버 역할 키 | Worker/서버 전용, 절대 브라우저 금지 |
| `DASHBOARD_ADMIN_CODE` | 추적 회사 추가 요청을 허용할 운영 관리 코드 | Worker/서버 전용 |
| `SUPABASE_PROJECT_REF` | 운영 확인용 프로젝트 참조값(선택) | Worker/CI 전용 |

브라우저가 Supabase Data API에 직접 연결할 필요가 없다면 `SUPABASE_ANON_KEY`나 공개 키도 설정하지 않는다. 이후 읽기 전용 직접 연결을 도입할 때도 `SUPABASE_SERVICE_ROLE_KEY`와 같은 값을 `NEXT_PUBLIC_` 변수로 바꾸면 안 된다.

## 테이블 구성

| 테이블 | 역할 | 공개 여부 |
| --- | --- | --- |
| `tracked_companies` | 실명 법인, 산업, 추적 상태, 공개·검증 상태 | 검증·공개된 행만 |
| `union_profiles` | 직접고용 노조, 조합원 수, 과반 교섭창구 상태, 대표교섭노조 여부 | 직접고용·검증·공개된 행만 |
| `union_governance_events` | 노조 선거, 집행부 교체, 임기 변경 이슈 | 상위 노조가 공개 가능한 경우만 |
| `bargaining_cases` | 법인 × 교섭연도 × 협약유형 × 교섭단위 × 적용범위의 사건 | 직접고용·검증·공개된 행만 |
| `bargaining_case_unions` | 한 사건에 참여하는 복수 노조의 연결 | 공개 사건·공개 노조의 연결만 |
| `bargaining_events` | 요구안, 본교섭, 결렬·조정, 잠정합의, 찬반투표, 조인, 이행의 타임라인 | 직접고용·검증·공개된 행만 |
| `bargaining_issues` | 임금·성과급·고용안정 등 쟁점과 해결 상태 | 공개 사건의 검증 행만 |
| `bargaining_terms` | 잠정합의안·찬반투표·조인 후의 기존 대비 변경 내용 | 공개 사건의 검증 행만 |
| `sources` | 기사 전문이 아닌 원문 URL·제목·발행 정보·출처 등급 | 공개 주석으로 연결된 검증 행만 |
| `source_annotations` | 사실 메모와 원문 URL을 사건·이벤트·쟁점 등에 연결 | 공개 대상에 연결된 검증 행만 |
| `scope_review_audits` | 하청·사내협력사·용역·파견·계열사·혼합 후보의 범위 판정 감사 기록 | 비공개 |
| `company_add_requests` | 관리 코드가 확인된 추적 회사 추가 요청 | 비공개 |

`sources`에는 기사 본문이나 긴 인용문을 저장하지 않는다. 제목, 원문 URL, 발행 시각, 출처 품질, 검증 상태와 짧은 사실 메모만 보관한다.

## 원청 직접고용 공개 게이트

공개 대상은 다음 조건을 **모두** 만족해야 한다.

1. `direct_employer_company_id = company_id`
2. `covered_worker_relation = 'DIRECT'`
3. `scope_classification = 'PRIMARY_DIRECT_UNION'`
4. `include_in_primary_dashboard = true`
5. `verification_status = 'VERIFIED'`
6. `is_published = true`

마이그레이션은 이 조건을 `CHECK` 제약과 `anon` RLS 정책 양쪽에 넣는다. 따라서 하청 노조가 원청에 교섭을 요구한 기사, 사내협력사·용역·파견 노조 사례, 계열사 별도 법인 사례, 원청·하청이 섞여 자동 분리할 수 없는 기사는 주 대시보드의 단계·쟁점·노출도 집계에 들어갈 수 없다.

제외·보류 후보는 `scope_review_audits`에 `scope_classification`, 피고용 관계, 판정 사유, 검토자 유형, Skill 규칙 버전과 함께 남긴다. 이 감사 테이블에는 공개 읽기 정책을 만들지 않는다.

## 과반 노조 값의 기록 방식

`union_profiles.majority_union_status`의 값은 `YES`, `NO`, `UNKNOWN`, `NOT_APPLICABLE`이다.

- `YES` 또는 `NO`를 사용하려면 참여 노조 기준의 분자·분모·근거 URL을 모두 기록한다.
- 조합원 수나 대표교섭노조 여부만으로 과반 여부를 추정하지 않는다.
- 공개 화면은 근거가 완결된 경우에만 O/X를 표시하고, 나머지는 `확인중`으로 표시한다.

## 회사 추가 요청 흐름

회사 추가 버튼은 대시보드의 일반 공개 쓰기 기능이 아니다. 다음 흐름으로 구현한다.

```text
운영자 입력 → Worker의 POST 엔드포인트 → 관리 코드 검증 → service_role INSERT → PENDING 검토
```

1. Worker는 HTTPS 요청에서 관리 코드를 받은 뒤 서버의 `DASHBOARD_ADMIN_CODE`와 상수 시간 비교를 한다.
2. 코드가 맞을 때만 `company_add_requests`에 `status = 'PENDING'`으로 삽입한다.
3. 이 테이블에는 코드 원문을 저장하지 않으며, `admin_code_verified_at`에 검증 시각만 남긴다.
4. 아침 수집 결과 메일의 서명된 검토 링크에서 사람이 승인하면 `APPROVED` 처리되고,
   `tracked_companies`에는 `NEEDS_REVIEW`·비공개·일시정지 상태로 등록된다.
5. `승인 기업 과거자료 수집` 워크플로가 최근 5개년 Google News RSS 후보의 제목·매체·
   발행일·URL만 `sources`와 `scope_review_audits`에 비공개 저장한다. 후보는 모두
   `UNKNOWN_REVIEW`로 시작하고, 원청 직접고용 범위 확인 뒤에만 공개 검토 대상으로 올린다.
6. 실패한 코드, 원문 코드, 불필요한 IP·개인식별정보는 데이터베이스와 로그에 남기지 않는다. 엔드포인트에는 속도 제한을 둔다.

`company_add_requests`의 UI 연동용 핵심 열은 `id`, `company_legal_name`, `company_name`, `website_url`, `industry`, `rationale`, `status`, `requested_at`, `reviewed_at`, `review_note`이다. 이 테이블에는 `anon` 권한이 없다.

## 적용 순서

1. 제품 소유자가 사용할 Supabase 프로젝트를 확정한다.
2. 배포 플랫폼의 서버 전용 환경 변수에 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DASHBOARD_ADMIN_CODE`를 설정한다. Cloudflare Workers에서는 `npx wrangler secret put <이름>`으로 넣는다.
3. [초기 마이그레이션](../supabase/migrations/20260810_initial_bargaining_dashboard.sql)을 적용한다.
4. 보안 권고 도구로 RLS·권한·공개 스키마 경고를 점검한다.
5. 12개 초기 추적 법인의 검증된 과거 5년 사실 데이터만 적재한다. 출처 URL이 없거나 원청 직접고용 범위가 확인되지 않은 항목은 공개 상태로 적재하지 않는다.
6. `anon` 역할로 공개 행만 조회되는지, 하청·혼합 후보와 회사 추가 요청이 조회되지 않는지 확인한다.
7. Worker API를 연결한 뒤 회사 추가 요청은 `PENDING` 행만 생성되는지, 관리 코드·service role 키가 응답과 로그에 없는지 확인한다.

## 운영 검증 SQL 예시

다음 쿼리는 관리 권한으로만 실행한다. `anon` 테스트는 별도의 제한된 연결 또는 Supabase 정책 테스트 환경에서 수행한다.

```sql
-- 공개된 사건이 직접고용 게이트를 모두 만족하는지 확인
SELECT id, company_id, bargaining_year, agreement_type, scope_classification,
       covered_worker_relation, include_in_primary_dashboard, verification_status
FROM public.bargaining_cases
WHERE is_published
  AND NOT (
    direct_employer_company_id = company_id
    AND scope_classification = 'PRIMARY_DIRECT_UNION'
    AND covered_worker_relation = 'DIRECT'
    AND include_in_primary_dashboard
    AND verification_status = 'VERIFIED'
  );

-- 공개된 이벤트가 부모 사건의 공개 범위를 벗어나지 않는지 확인
SELECT be.id, be.bargaining_case_id
FROM public.bargaining_events AS be
LEFT JOIN public.bargaining_cases AS bc ON bc.id = be.bargaining_case_id
WHERE be.is_published
  AND (bc.id IS NULL OR NOT bc.is_published OR bc.scope_classification <> 'PRIMARY_DIRECT_UNION');

-- 공개되지 않아야 하는 회사 추가 요청 수를 운영자가 확인
SELECT status, count(*)
FROM public.company_add_requests
GROUP BY status
ORDER BY status;
```

## 변경 규칙

- 법률·행정지침 변화로 원청과 하청의 사용자성 판단이 넓어져도, 제품의 공개 범위인 **원청 법인 직접고용 노조만**이라는 게이트를 임의로 완화하지 않는다.
- 원청·하청 범위 검토 Skill의 규칙 버전과 `scope_review_audits.rule_version`을 함께 갱신한다.
- 새 테이블을 `public` 스키마에 추가할 때는 RLS 활성화, `anon` 권한 최소화, 공개·검증 조건 정책, 인덱스를 같은 변경에 포함한다.
- 역사 데이터의 정정은 기존 행을 조용히 덮어쓰기보다 원문 URL·검증 시각·정정 주석을 남겨 추적 가능하게 한다.

## 개통 실행 순서 (2026-08-11 기준)

준비된 것과 남은 것을 구분한다. **1번과 2번은 계정 소유자만 할 수 있고, 3번부터는 스크립트로 처리된다.**

1. **Supabase 프로젝트 생성** — 제품 소유자가 대상 프로젝트를 확정한다. 다른 서비스의 데이터베이스에 적용하면 안 된다.
2. **시크릿 등록** — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DASHBOARD_ADMIN_CODE`를 Worker 시크릿으로 넣는다. 서비스 역할 키는 RLS를 우회하므로 브라우저·`NEXT_PUBLIC_`·정적 파일·로그에 절대 넣지 않는다.
3. **마이그레이션 적용** — 두 파일을 순서대로 한 번만 적용한다.

   ```bash
   supabase/migrations/20260810_initial_bargaining_dashboard.sql
   supabase/migrations/20260811_bargaining_record_corrections.sql
   ```

4. **적재 전 검증** — 네트워크를 쓰지 않고 payload 형태와 건수를 먼저 확인한다.

   ```bash
   node scripts/load-supabase-seed.mjs --dry-run
   ```

5. **실제 적재** — 법인 → 교섭 사건 → 사건별 경과 순으로 자연키 기준 멱등 적재한다. 재실행해도 결과가 같다.

   ```bash
   node scripts/load-supabase-seed.mjs
   ```

6. **검증** — 익명 역할로 공개 행만 조회되는지, `scope_review_audits`·`company_add_requests`·`bargaining_record_corrections`가 전혀 보이지 않는지 확인한다.

### 기록 수정 요청 대장

`bargaining_record_corrections`는 사람이 제출한 수정 요청을 담는다. 화면의 **기록 수정 요청** 버튼 → `POST /api/record-corrections` 경로다.

- 접수 조건: 관리 코드 일치, 근거 원문 URL(http·https), 수정 사유, 수정자 이름. 하나라도 없으면 접수하지 않는다.
- 함께 저장하는 것: 대상 기록 식별자·법인·교섭연도, 수정 항목, **이전값과 이후값**, 근거 URL, 사유, **수정자 이름과 관리 코드 검증 시각**.
- 저장하지 않는 것: 관리 코드 원문, 이메일·계정 식별자.
- 상태는 `PENDING`으로만 생성된다. **검토를 통과하지 않은 수정은 공개 사실이 아니다.** 같은 기록·같은 항목에 검토 대기 요청이 이미 있으면 `409`로 거부한다.
- 아침 메일에는 PENDING 요청별 `수정 요청 검토` 버튼이 들어간다. 링크는 관리 코드 대신
  48시간 유효 HMAC 서명을 사용하며, GET은 상세 확인만 하고 POST 승인·반려에서만 처리한다.
- 승인 가능한 항목은 주 단계, 확인일, 협약유형, 노조명, 사실 요약이다. 승인 시 해당
  `bargaining_cases` 행을 수정하고 수정 대장을 `APPLIED`로 바꾼다. 반영 뒤 화면은 DB 값을
  정적 시드보다 우선한다.
- 두 번째 상태 변경에 실패하면 첫 번째 DB 수정을 이전값으로 되돌리는 보상 처리를 한다.
  다만 별도 DB 함수가 아닌 REST 두 단계 처리이므로, 운영 로그와 수정 대장을 함께 확인한다.

### 과거 교섭 경과 적재

`bargaining_events`가 단계별 경과의 적재지다. 입력 자료는 `data/historical-flow-events.json`이고, `scripts/build-historical-seed.mjs`가 검증 후 공개 시드의 `flowEvents`로 병합한다.

검증 규칙은 다음과 같다. 위반하면 빌드가 실패한다.

- `recordId`가 과거 시드의 기록과 일치해야 한다.
- `date`는 `YYYY-MM-DD`이고 교섭연도보다 이르면 안 된다. 이듬해로 넘어가는 것은 이월이므로 허용한다.
- `stage`는 `U`, `S0`–`S8` 중 하나다.
- `sourceUrl`이 없으면 받지 않는다. 근거 없는 경과는 넣지 않는다.
- 같은 `recordId` 안에서 같은 `sourceUrl`은 하나만 남는다.

2026-08-11 기준 커버리지는 **경과 보유 12건(2026년), 결과만 확인 44건(2021–2025년)**이다. 과거 44건은 각 사건의 근거 URL을 확인하는 조사가 남아 있고, 채워지지 않은 연도는 화면에서 "결과만 확인된 기록"으로 표시된다.

## anon 역할 RLS 검증 결과 (2026-08-12)

`SUPABASE_ANON_KEY`로 실제 조회·쓰기를 시도해 확인했다. 모든 행이 공개 상태라 "숨김이
작동하는지"는 조회만으로 증명되지 않으므로, **비공개 행을 하나 만들어 음성 검증**을 했다.

| 항목 | 결과 |
| --- | --- |
| 공개 사실 테이블 anon 읽기 | `tracked_companies` 12 · `bargaining_cases` 56 · `bargaining_events` 79 |
| 비공개 행 음성 검증 | 임시 `is_published=false` 행 → service_role 1건 / **anon 0건** |
| `verification_status ≠ VERIFIED` 행 | anon 조회 0건 |
| `scope_review_audits` | anon `401` 거부 |
| `company_add_requests` | anon `401` 거부 |
| `bargaining_record_corrections` | anon `401` 거부 |
| anon `INSERT` / `UPDATE` / `DELETE` | 모두 `401` 거부 |
| 키 없이 접근 | `401` 거부 |

검증용으로 만든 행과 종단 확인용 수정 요청 행은 확인 후 삭제했다.

### 남은 문제: `sources`가 anon에 0건

정책이 `source_annotations`와의 연결을 요구한다.

```sql
CREATE POLICY anon_read_sources_linked_to_published_facts ON public.sources
  FOR SELECT TO anon USING (
    is_published AND verification_status = 'VERIFIED'
    AND EXISTS (SELECT 1 FROM public.source_annotations sa
                WHERE sa.source_id = sources.id AND sa.is_published
                  AND sa.verification_status = 'VERIFIED')
  );
```

적재기가 `source_annotations`를 만들지 않으므로 anon에게는 출처가 하나도 보이지 않는다.
지금은 화면이 Worker(service_role)를 거쳐 사실을 읽으므로 렌더링에 영향이 없다. 다만
**브라우저가 anon 키로 Supabase를 직접 읽는 구조로 바꾸면 출처 표시가 사라진다.**
그 전에 `scripts/load-supabase-seed.mjs`가 `source_annotations`를 함께 적재해야 한다.

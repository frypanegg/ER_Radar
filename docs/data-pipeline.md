# 임금·단체협상 뉴스 데이터 파이프라인

## 목적과 범위

scripts/collect-news.mjs는 초기 공개 추적 12개 법인의 당해 연도 임금협상·단체협상 관련
뉴스 **후보**를 하루 한 번 수집한다. 원문 본문이나 검색 API의 요약문은 결과에
저장하지 않는다. 공개 결과에는 제목, 매체, 발행 일시, URL, 그리고 이 프로젝트가
계산한 회사·교섭단위·단계 분류만 들어간다.

대상 회사는 다음과 같다.

1. 삼성전자
2. LG전자
3. 현대자동차
4. 기아
5. SK하이닉스
6. 포스코
7. 현대제철
8. HD현대중공업
9. 한화오션
10. 한국GM
11. 현대모비스
12. 두산에너빌리티

회사 명칭, 별칭, 교섭단위, 검색어는 `data/source-config.json`에서 관리한다.
회사가 사명을 바꾸거나 교섭대표노조가 달라지면 코드가 아니라 이 설정을 먼저
갱신한다.

## 실행 환경

- Node.js 22 이상
- `fast-xml-parser` 패키지
- NAVER API HUB를 쓸 때만 NAVER API HUB 자격증명

```bash
export NAVER_API_HUB_CLIENT_ID="..."
export NAVER_API_HUB_CLIENT_SECRET="..."
node scripts/collect-news.mjs
```

`NAVER_CLIENT_ID`/`NAVER_CLIENT_SECRET`과 `NAVER_API_CLIENT_ID`/`NAVER_API_CLIENT_SECRET`도
별칭으로 지원한다. 기본 수집원은 NAVER API HUB의 `/search/v1/news`와
`X-NCP-APIGW-API-KEY-ID`·`X-NCP-APIGW-API-KEY` 인증 헤더를 사용한다. 자격증명은 설정 파일이나
결과 JSON에 기록하지 않는다.

자격증명이 모두 있으면 NAVER API HUB 뉴스 검색을 우선 사용한다. 자격증명이 없으면
Google News RSS를 후보 탐색용으로 사용하며, `auto` 모드에서 개별 NAVER 요청이 실패한 경우에도
해당 검색어만 RSS로 재시도한다. **현재 운영 기준 수집원은 Google News RSS다.**

RSS만으로 발견된 후보는 원문 URL 확인 전까지 교섭사건의 상태·쟁점·노출도 집계에
반영하지 않는다. 그 확인을 자동화한 것이 다음 절의 원문 URL 되돌리기다.

## 원문 URL 되돌리기와 검증

`scripts/resolve-google-news.mjs`는 RSS가 주는 `news.google.com/rss/articles/CBMi…`
링크를 발행사 원문 주소로 되돌린다. 이 링크는 HTTP 리다이렉트가 아니라 페이지 내부
스크립트로 최종 주소를 만들기 때문에 다음 두 단계를 거친다. 헤드리스 브라우저는
쓰지 않고 `fetch`만 사용한다.

1. 기사 페이지에서 `data-n-a-id`·`data-n-a-ts`·`data-n-a-sg` 서명 값을 읽는다.
2. 같은 서명으로 `batchexecute` RPC를 호출해 발행사 URL을 받는다.

되돌린 URL은 세 가지를 통과해야 원문 근거로 인정한다.

| 검사 | 통과 조건 | 실패 시 상태 |
| --- | --- | --- |
| 서명 추출 | 세 값이 모두 있음 | `SIGNATURE_NOT_FOUND` |
| 주소 추출 | 구글이 아닌 http(s) 주소가 나옴 | `RESOLUTION_FAILED` |
| 도달 가능성 | 원문 응답이 2xx·3xx | `RESOLVED_UNREACHABLE` |
| 제목 일치 | RSS 제목 토큰의 40% 이상이 원문 페이지 제목에 있음 | `RESOLVED_TITLE_MISMATCH` |

`RESOLVED_AND_REACHABLE`인 후보만 `originalUrl`이 채워지고
`requiresSourceVerification = false`가 되어 상태 집계 후보로 올라간다. 나머지는 검증
결과를 감사용으로 남기되 공개 상태를 바꾸지 않는다.

제목 일치 검사는 장식용이 아니다. 응답의 URL은 JSON 문자열 안의 JSON 문자열이라
역슬래시가 겹쳐 들어오는데(`?idxno\\u003d85080`), 이를 제대로 풀지 않으면 쿼리스트링이
잘린 주소가 만들어진다. 잘린 주소는 대개 발행사의 다른 기사로 연결되며, 제목 일치
검사가 이를 걸러낸다. 회귀 사례는 `tests/daily-automation.test.mjs`에 있다.

되돌리기는 네트워크 비용이 크므로 원청 노조 공개 후보로 분류된 기사에만 적용하고,
1회 실행당 기본 60건으로 제한한다(`--max-resolve`). `--no-resolve`로 끌 수 있다.

```bash
# RSS만 사용
node scripts/collect-news.mjs --source google

# 네이버만 사용(자격증명이 없으면 실패)
node scripts/collect-news.mjs --source naver

# 파일을 쓰지 않는 진단 실행
node scripts/collect-news.mjs --dry-run --source google
```

기본 결과 경로는 `public/data/news-candidates.json`이다. `--config`, `--output`,
`--year`, `--max-per-query` 옵션은 `node scripts/collect-news.mjs --help`에서
확인할 수 있다.

## 고정 수집 주기

모든 회사의 수집 주기는 **1일 1회**로 고정한다. 권장 운영 시각은 매일
**KST 06:30**이다. 서버의 cron이 시간대 지정을 지원하면 다음처럼 실행한다.

```cron
CRON_TZ=Asia/Seoul
30 6 * * * cd /absolute/project/path && /absolute/node/path scripts/collect-news.mjs
```

UTC만 지원하는 스케줄러에서는 `30 21 * * *`로 설정한다. 이는 KST 기준 다음 날
06:30이며, 한국은 일광절약시간을 적용하지 않는다.

**실제 운영 스케줄러는 `.github/workflows/daily-bargaining-update.yml`이다.**
`schedule: cron: "30 21 * * *"`로 등록되어 있고, 수집 → 원문 확인 → 사실 반영 →
회귀 검증 → 커밋 → 배포를 한 작업에서 처리한다. `workflow_dispatch`로 수동 실행할
수 있으며 `force` 입력을 켜면 같은 KST 날짜라도 다시 수집하고, `deploy` 입력을 켜면
공개 사실이 바뀌지 않은 실행에서도 현재 코드·데이터를 다시 배포한다.

배포 단계는 Cloudflare Workers로 `npx wrangler deploy`를 실행한다. 화면이 읽는 사실
데이터는 빌드 시점에 번들로 들어가므로, 반영 후 빌드된 산출물을 배포해야 공개 URL이
같이 갱신된다. `CLOUDFLARE_API_TOKEN` 시크릿이 없으면 경고만 남기고 저장소 데이터만
갱신한다.

수집기는 결과의 `batch.kstDate`를 확인한다. 같은 KST 날짜에 이미 실행한 배치가
있으면 네트워크 요청 없이 종료하므로 잘못된 중복 실행도 하루 한 번으로 제한된다.
장애 복구나 분류 규칙 검증을 위해 의도적으로 다시 실행할 때만 `--force`를 쓴다.
동시 실행은 결과 파일 옆의 잠금 파일로 차단하고, 출력은 임시 파일을 거쳐 원자적으로
교체한다. 모든 쿼리가 실패하면 기존 결과를 보존한다.

## 수집과 정제 순서

1. 현재 KST 연도를 기본 대상 연도로 정한다.
2. 회사별 설정 검색어를 NAVER API HUB 또는 Google News RSS에 요청한다.
3. 발행 일시가 대상 연도 밖인 기사, URL·날짜가 없는 기사, 노사관계 신호가 없는
   기사를 제거한다.
4. 추적 파라미터를 제거한 URL로 1차 중복 제거한다.
5. 대괄호형 말머리와 공백·문장부호를 정규화한 제목으로 2차 중복 제거한다.
6. 범위 검토 서브에이전트가 먼저 원청 직접고용 노조 여부를 판정·격리한다.
7. 포함된 후보에 한해 회사, 교섭단위, 협상 단계, 예외 상태를 분류한다.
8. 공개 후보로 남은 기사만 원문 URL을 되돌리고 도달 가능성·제목 일치를 확인한다.
9. 확인 결과를 반영해 다시 분류하고, 최신성 점수와 검토 필요 여부를 계산해 JSON을 교체한다.

`eligibleForStatusAggregation: true`인 기사만 후속 교섭사건 집계기가 상태를 바꿀 수 있다.
원청 직접고용 범위를 통과했더라도 원문 URL 확인에 실패하면 `requiresSourceVerification: true`로
남아 단계·쟁점·노출도에 반영하지 않는다.

RSS와 API의 설명 필드는 분류에도 사용하지 않으며 결과에 저장하지 않는다.
원문 페이지는 **URL이 실재하는지와 제목이 일치하는지 확인하는 용도로만** 내려받고,
본문·요약문은 파싱하지도 저장하지도 않는다. 결과에 남는 것은 제목, 매체, 발행 일시,
원문 URL, 그리고 이 프로젝트가 계산한 분류뿐이다.

## 원청 직접고용 노조 범위 제한과 검토 서브에이전트

primary-union-scope-review 서브에이전트는 단계 분류보다 먼저 실행되는 필수 게이트다.
현재 일일 수집기는 제목·법인/노조 별칭·제외 신호를 이용하는 보수적 1차 판정기로
실행하고, 제외·혼합·불명확 후보는 검토 큐로 격리한다. 이 게이트의 규칙 버전,
격리 정책, 법률 변경 업데이트 절차는 Codex 개인 스킬
$primary-union-scope-review에 보관한다. 스킬은 직접고용 게이트를 바꾸지 않는 한
법령·시행령·행정지침 변경에 맞춰 근거·신호·회귀 사례를 버전으로 갱신할 수 있다.

주 대시보드는 선택된 원청 법인과 직접 근로관계가 있는 노동조합의 교섭사건만
포함한다. 회사명이 기사에 등장하거나 하청노조가 원청에 교섭을 요구했다는 사실만으로
원청 노조 사건에 합치지 않는다. 회사별 매치에는 다음 두 필드가 반드시 붙는다.

- `scopeClassification`: 고용·노조 범위 판정
- `includeInPrimaryDashboard`: 원청 대시보드 집계 허용 여부

| 범위 코드 | 포함 | 판정 원칙 |
| --- | --- | --- |
| `PRIMARY_DIRECT_UNION` | 예 | 선택 법인과 설정된 직접고용 원청 노조 별칭이 함께 확인됨 |
| `SUBCONTRACTOR_UNION_EXCLUDED` | 아니요 | 협력사·하청·사내하청·용역·파견 등 비직접고용 신호 |
| `AFFILIATE_UNION_EXCLUDED` | 아니요 | 계열사·자회사·관계사 노조 신호 |
| `UNKNOWN_REVIEW` | 아니요 | 직접 사용자와 적용 근로자 관계를 제목에서 확인하지 못함 |
| `MIXED_NEEDS_SPLIT` | 아니요 | 원청 노조와 제외 대상 신호가 한 제목에 섞여 자동 분리 불가 |

`SUBCONTRACTOR_UNION_EXCLUDED`에는 사내협력사·수급업체·하청 사업자도 포함한다.
계약 밖 사용자의 사용자성 주장이나 원청 상대 교섭 요구는 별도 감사 후보로만 남기고
주 상태, 쟁점, 미디어 노출 건수에 합산하지 않는다. 혼합 기사를 자동으로 원청 몫으로
나누지 않는다. 별도 근거로 사건을 분리하기 전까지 `MIXED_NEEDS_SPLIT` 검토 큐다.

출력의 `batch.stats.scopeCounts`, `companyScopeCounts`, `excludedCompanyMatches`,
`excludedAuditCandidates`, 회사별
`excludedAuditCount`로 제외 건수를 점검한다. 제외 기사에는
`classification.excludedAudit`이 있지만 사용자 화면은 반드시
`includeInPrimaryDashboard === true`만 렌더링한다. 범위 제외 기사의 주 상태는 `U`,
`retainMainState: true`로 고정해 실수로 상태를 바꾸지 못하게 한다.

검토 서브에이전트의 출력에는 `scopeReview.agentId`, `scopeReview.ruleVersion`,
`scopeReview.executionOrder`, `scopeReview.quarantined`가 남는다. 공개 이벤트·회사
지표는 이 값이 `PRIMARY_DIRECT_UNION`인 경우에만 후속 처리한다.

## 단계 분류 체계

| 코드 | 화면 라벨 | 의미 |
| --- | --- | --- |
| `preparation` | 준비 | 요구안 마련, 상견례, 교섭 준비 |
| `bargaining` | 교섭 | 본교섭·실무교섭·재교섭 진행 |
| `breakdown_mediation` | 결렬·조정 | 교섭 결렬, 노동위원회 조정·중재 |
| `industrial_action` | 쟁의 | 쟁의권 확보, 파업·준법투쟁 실행 |
| `tentative_agreement` | 잠정합의 | 노사 잠정합의안 도출 |
| `final_agreement` | 최종타결 | 조합원 가결, 협약 체결, 최종 타결 |
| `manual_review` | 수동검토 | 제목만으로 확정할 수 없음 |

정상적인 설명 순서는 `준비 → 교섭 → 결렬·조정 → 쟁의 → 잠정합의 → 최종타결`이다.
그러나 이 분류 체계는 기사 주제 라벨이며, 뒤 단계의 숫자가 항상 회사의 현재 주
상태라는 뜻은 아니다. 현재 상태 집계에는 아래 `statusCode` 프레임워크를 사용한다.

### 대시보드 상태 프레임워크

| 코드 | 이름 | 의미 |
| --- | --- | --- |
| `U` | `unverified` | 제목만으로 주 상태를 확인하지 못함 |
| `S0` | `not_started` | 당해 교섭 미개시 |
| `S1` | `preparing` | 요구안·상견례 등 준비 |
| `S2` | `representation` | 교섭대표 선정·교섭단위 결정 |
| `S3` | `bargaining` | 교섭 진행·재개 |
| `S4` | `impasse_mediation` | 실제 교착·결렬 또는 조정 확인 |
| `S5` | `tentative` | 잠정합의 도출 |
| `S6` | `ratification` | 조합원 찬반투표·인준 |
| `S7` | `signed_effective` | 협약 체결·발효·최종 타결 |
| `S8` | `implementation` | 합의 이행·임금 반영 |

각 분류에는 `eventState`가 함께 붙는다. 허용값은 `planned`, `occurred`,
`cancelled`, `corrected`, `disputed`다. 예정·취소·정정·분쟁 보도는
`retainMainState: true`이므로 상태 집계기가 기존 주 상태를 덮어쓰지 않는다.

중요하게, 파업 또는 쟁의행위 기사만으로 `S4`를 만들지 않는다. 제목에 실제 교섭
결렬·교착이나 노동위원회 조정이 확인된 경우에만 `S4`를 낸다. 찬반투표·파업
예정이나 진행만 확인되면 `statusCode: U`, `retainMainState: true`로 주 상태는
유지하고, 다음 `parallelStates.dispute`만 갱신한다. 같은 제목에 교섭 결렬과
파업이 모두 명시된 경우에는 `S4`와 파업 `dispute` 상태를 함께 낼 수 있다.

| `dispute` 코드 | 간단 표시명 | 의미 |
| --- | --- | --- |
| `IMPASSE_REPORTED` | 교착 | 교섭 결렬·교착·난항 보도 |
| `MEDIATION_REQUESTED` | 조정 신청 | 조정·중재 신청 |
| `MEDIATION_ACTIVE` | 조정 중 | 조정 회의·절차 진행 |
| `MEDIATION_SETTLED` | 조정 성립 | 조정·중재에서 합의 성립 |
| `MEDIATION_UNRESOLVED` | 조정 불성립 | 조정 중지·종료·불성립 |
| `ADMINISTRATIVE_GUIDANCE` | 행정지도 | 노동위원회 행정지도 |
| `ARBITRATION_ACTIVE` | 중재 중 | 중재 절차 진행 |
| `ARBITRATION_AWARD` | 중재재정 | 중재재정·판정 확인 |
| `STRIKE_VOTE_SCHEDULED` | 쟁의투표 예정 | 찬반투표 계획 |
| `STRIKE_VOTE_PASSED` | 쟁의투표 가결 | 쟁의행위 찬반투표 가결 |
| `STRIKE_ANNOUNCED` | 파업 예고 | 파업 선언·계획 |
| `STRIKE_ACTIVE` | 파업 중 | 파업·준법투쟁 실행 |
| `STRIKE_SUSPENDED_OR_RETURNED` | 파업 유보·복귀 | 철회·유보·업무 복귀 |

`parallelStates.representation`은 교섭대표 선정, 단위 분리, 단위 불명 상태를,
`parallelStates.agreement`는 잠정합의, 인준 예정·완료, 부결, 체결·발효, 이행을
주 단계와 별개로 보존한다.

### 부정·예정 표현 방어

`파업 예정`, `조정 신청 검토`, `타결 전망` 같은 문장은 해당 사건이 아직 발생하지
않았으므로 목표 단계를 `suggestedStage`에만 둔다. 현재 `stage`는 설정된 이전 단계로
유지하며 `eventType: future_plan`, `needsReview: true`를 표시한다.

`파업하지 않기로`, `결렬 아니다`, `타결 실패` 같은 부정 표현도 긍정 단계 신호로
사용하지 않는다. 부정 신호와 긍정 신호가 한 제목에 함께 있으면 더 보수적인 단계를
택하고 수동 검토 대상으로 보낸다.

`잠정합의안 찬반투표 예정`은 잠정합의 자체가 이미 만들어진 경우이므로 단순한
`예정` 한 단어만으로 잠정합의 단계를 취소하지 않는다. 단계별 문장 패턴으로
예정 표현을 검사하는 이유다.

### 비선형 상태 전이

아래 사건은 정상 순방향 전이를 덮어쓴다.

| `eventType` | 기본 현재 단계 | `transitionHint` |
| --- | --- | --- |
| `tentative_rejected` | 교섭 | `rollback_to_bargaining` |
| `rejected_then_action_resumed` | 쟁의 | `rollback_then_advance` |
| `bargaining_resumed` | 교섭 | `resume_or_rollback` |
| `renewed_bargaining_broken` | 결렬·조정 | `rollback_then_breakdown` |
| `agreement_failed` | 결렬·조정 | `stay_or_rollback` |
| `industrial_action_withdrawn` | 주 상태 유지 | `retain_main_state` |

따라서 잠정합의 기사가 더 오래되었다는 이유로, 그 뒤에 나온 잠정합의안 부결 기사를
무시하면 안 된다. `transitionHint`를 적용해 현재 상태를 되돌린 뒤 다음 기사를 본다.

## 복수노조와 교섭단위

상태의 기본 키는 회사 하나가 아니라 다음 조합이다.

```text
{ companyId, bargainingUnitId }
```

제목에 노조·지회 이름이 있으면 해당 교섭단위만 연결한다. 한 회사에 설정된
교섭단위가 하나뿐이면 이를 `single_configured_unit` 근거로 추론할 수 있다. 복수
교섭단위 회사에서 제목에 단위가 없으면 `bargainingUnits: []`,
`bargainingUnitScope: unspecified`, `needsReview: true`로 남긴다. 이 기사를 모든
노조의 상태에 일괄 반영해서는 안 된다.

한 제목이 둘 이상의 회사나 교섭단위를 명시할 수 있으므로, 기사 자체는 한 번만
저장하되 `classification.companies[]`에 각각의 매치를 보존한다. 화면이나 집계기는
이 배열을 펼쳐 회사별 타임라인을 만든다.

## 현재 상태를 계산하는 권장 방식

1. `includeInPrimaryDashboard === true`인 기사와 회사 매치만 남긴다.
2. `classification.companies[]`를 펼친 뒤 교섭단위가 명확한 기사만
   `{companyId, bargainingUnitId}`별로 묶는다.
3. `publishedAt` 오름차순으로 읽되 `confidence`가 낮거나 `needsReview`인 전이는
   검토 큐로 보낸다.
4. `eventState: occurred`이고 `retainMainState: false`인 경우에만 `statusCode`를
   주 상태에 적용한다.
5. `S4`는 `statusBasis`가 실제 교착·조정 근거를 가리킬 때만 적용한다.
6. `parallelStates.dispute`, `representation`, `agreement`는 주 상태와 독립적으로
   갱신한다.
7. 위 표의 비선형 이벤트는 `transitionHint`대로 되돌리거나 유지한다.
8. `planned`, `cancelled`, `corrected`, `disputed` 이벤트는 자동 승격하지 않는다.
9. 마지막으로 확인된 전이의 기사 일시를 상태의 `asOf`로 표시한다.

날짜가 최신이라는 사실만으로 단계가 단조 증가한다고 가정하지 않는다. 결과 JSON의
`taxonomy.dateAloneDoesNotImplyProgression`도 이 제약을 명시한다.

## 회사·노조 메타데이터와 기사 주석

`companyCoverage[].selection`에는 회사 선정 기준인 규모(`scale`), 산업영향
(`industryImpact`), 언론노출도(`mediaExposure`), 법정 과반노조 여부
(`majorityUnion.status`: `O`/`X`/`UNKNOWN`), 각 `verifiedAt`이 들어간다. 현재 값은
편집용 초기값이므로 `verifiedAt: null`, `needsReview: true`다.

여기서 과반노조는 오직 노조법 제29조의2 제4항에 따른 **교섭창구 단일화 참여노조
전체 조합원 중 과반**을 뜻한다. `numerator`, `denominator`, `calculationBasis`,
`evidenceDate`, `evidenceUrl`이 모두 확인되지 않으면 `UNKNOWN(확인중)`이다. 이를
`representativeBargainingUnion`(교섭대표노조 여부) 또는
`directEmploymentUnionizationRate`(직접고용 전체 대비 가입률)와 절대 혼용하지
않는다. 세 필드는 설정과 노조 프로필에서 분리한다.

회사별 `unionProfiles[]`에는 교섭단위별 조합원 수, 노조 선거 이슈, 검증일을 둘 수
있다. 공식 근거를 아직 연결하지 않은 초기 후보는 `memberCount: null`,
`electionIssues: []`, `verifiedAt: null`, `needsReview: true`로 둔다. 숫자나 선거
쟁점을 제목만 보고 추정하지 않는다.

`classification.annotations`에는 다음 후보 필드가 있다.

- `agreementType.code`: 당해 연도 `WAGE`, `CBA`, `INTEGRATED` 중 제목으로 확인한 값
- `issueSummary[]`: 제목 키워드로 확인한 임금·성과급·고용·근로시간 등 의제 코드
- `impasseReason`: 교착 기사에 나온 의제 후보. 인과관계는 항상 미확인으로 둠
- `ratification.proposalChangeSummary`: 전년·기존안 대비 변화. 비교 근거가 없으면
  `summary: null`, `needsReview: true`
- `originalUrlStatus`: `DIRECT` 또는 `AGGREGATOR_ONLY`

기사에는 수집 URL과 함께 `originalUrl`을 둔다. 네이버 API의 `originallink`는 원문
URL로 저장하고, Google News RSS가 원문 주소를 주지 않으면 `null`과
`AGGREGATOR_ONLY`를 남긴다. 원문 본문은 어느 경우에도 저장하지 않는다.

찬반투표 제목은 `voteData`에 투표 유형, 예정·진행·가결·부결 사실, 제목에 명시된
투표율·찬성률만 기록한다. `legalConclusionInferred: false`이므로 쟁의권 성립이나
협약 효력을 자동 판단하지 않는다. 쟁의투표 가결도 주 단계는 그대로 유지한다.

## 최신성과 신뢰도

`classification.freshness.score`는 30일 반감기의 지수 감쇠 값이다.

```text
freshness = 0.5 ^ (ageDays / 30)
```

`very_recent`(7일 이내), `recent`(30일 이내), `aging`(설정상 검토 기준 이내),
`archive`로 함께 구분한다. 최신성은 화면 정렬·시각적 강조를 위한 값이며, 오래된
기사가 틀렸다는 뜻은 아니다.

`confidence`는 제목의 단계 신호와 회사 직접 명시 여부를 결합한 휴리스틱이다.
다음 경우에는 `needsReview`가 켜진다.

- 제목에는 회사명이 없고 검색어 문맥으로만 연결된 경우
- 복수 교섭단위 회사인데 제목에서 단위를 찾지 못한 경우
- 둘 이상의 회사·교섭단위가 한 제목에 잡힌 경우
- 부정·예정 표현이 있거나 단계가 불분명한 경우
- 잠정합의 부결처럼 상태 역전의 해석이 필요한 경우

## 결과 스키마 요약

초기 `public/data/news-candidates.json`은 네트워크 없이도 읽을 수 있도록 같은
스키마의 빈 `articles` 배열과 12개 법인의 0건 커버리지를 제공한다. 실제 수집 후
기사 한 건은 다음 모양이다.

```json
{
  "id": "news_0123456789abcdef",
  "title": "기사 제목",
  "media": "매체명",
  "publishedAt": "2026-07-15T03:20:00.000Z",
  "url": "https://example.com/news/123",
  "originalUrl": "https://example.com/news/123",
  "classification": {
    "stage": { "code": "bargaining", "label": "교섭" },
    "eventType": "stage_update",
    "transitionHint": "evaluate_by_date",
    "statusCode": "S3",
    "statusName": "bargaining",
    "statusLabel": "교섭",
    "eventState": "occurred",
    "eventStateCode": "OCCURRED",
    "retainMainState": false,
    "statusBasis": "stage_mapping",
    "scopeClassification": "PRIMARY_DIRECT_UNION",
    "includeInPrimaryDashboard": true,
    "parallelStates": {
      "dispute": {
        "code": "NONE",
        "label": "없음",
        "eventState": "occurred"
      },
      "representation": {
        "code": "SINGLE_UNION",
        "label": "단일 교섭단위 추론",
        "eventState": "occurred",
        "eventStateCode": "OCCURRED"
      },
      "agreement": {
        "code": "NONE",
        "label": "없음",
        "eventState": "occurred"
      }
    },
    "confidence": 0.84,
    "needsReview": false,
    "freshness": {
      "score": 0.91,
      "ageDays": 4.1,
      "band": "very_recent"
    },
    "companies": [
      {
        "companyId": "hyundai-motor",
        "companyName": "현대자동차",
        "matchBasis": "title_alias",
        "confidence": 0.94,
        "bargainingUnits": [
          {
            "id": "metal-union-branch",
            "name": "금속노조 현대자동차지부",
            "matchBasis": "single_configured_unit"
          }
        ],
        "bargainingUnitScope": "inferred_single",
        "representationState": {
          "code": "SINGLE_UNION",
          "label": "단일 교섭단위 추론",
          "eventState": "occurred",
          "eventStateCode": "OCCURRED"
        },
        "scopeClassification": "PRIMARY_DIRECT_UNION",
        "includeInPrimaryDashboard": true,
        "directEmployerMatch": true,
        "coveredWorkerRelation": "DIRECT",
        "needsReview": false,
        "reasonCode": "company_alias"
      }
    ],
    "reasonCodes": ["stage_signal", "company_alias"],
    "collectionSources": ["naver"]
  }
}
```

`batch.status`가 `partial`이면 일부 검색어가 실패한 것이다. 화면은 기존 기사와
구분해 “부분 갱신”을 표시하는 것이 좋다. `batch.stats`에는 수집원별 요청 수,
제외·중복 제거 건수, 최종 후보 건수가 들어간다.

## 운영 점검

```bash
# JS 문법 확인
node --check scripts/collect-news.mjs

# 설정과 초기 출력 JSON 확인
node -e 'JSON.parse(require("fs").readFileSync("data/source-config.json", "utf8"))'
node -e 'JSON.parse(require("fs").readFileSync("public/data/news-candidates.json", "utf8"))'

# 실제 네트워크·분류를 시험하되 결과 파일은 보존
node scripts/collect-news.mjs --dry-run --source google --max-per-query 3
```

검색어·별칭을 바꿀 때는 오탐과 누락을 함께 확인한다. 특히 `포스코`처럼 그룹과
사업회사가 같은 이름을 공유하거나, `대우조선해양`처럼 과거 사명이 기사에 남아
있는 회사는 수동 검토 표본을 정기적으로 살펴야 한다.

## 공개 사실 시드 자동 반영

`scripts/apply-daily-update.mjs`는 수집 결과 가운데 아래 조건을 모두 만족하는
기사만 `data/current-2026-fact-seed.json`에 반영한다.

- `scopeClassification = PRIMARY_DIRECT_UNION`이고 `includeInPrimaryDashboard = true`
- `eligibleForStatusAggregation = true`이고 원문 URL 확인 완료
- 기사에 매칭된 법인이 하나
- 주 단계가 `U`가 아니고 `retainMainState`가 아님
- 기존 기록보다 발생일이 늦음

반영 범위는 **사건 정보로 한정한다.** 단계, 발생일, 제목, 원문 URL, 매체, 신뢰도,
교섭 경과 항목만 갱신하고 노조명·직접고용 범위 근거·범위 증빙 URL·법인명은 기존
값을 유지한다. 이 값들은 기사 제목으로 추정할 수 없기 때문이다. 추적 목록에 없는
법인은 반영하지 않으며, 새 법인 추가는 사람의 범위 검토를 거친다.

자동 반영된 기록은 `factualStatus = "AUTO_COLLECTED_TITLE_BASIS"`로 표시해 사람이
검증한 `VERIFIED_SOURCE` 기록과 구분한다. 사람이 검증한 `S7`·`S8` 체결 기록은 같은
등급의 근거 없이 하위 단계로 되돌아가지 않는다.

모든 실행 결과는 `data/daily-update-audit.json`에 최근 60회까지 남는다. 반영된 항목은
법인·이전 단계·다음 단계·원문 URL까지, 보류된 항목은 사유 코드별 건수로 기록한다.

```bash
# 반영 계획만 확인
node scripts/apply-daily-update.mjs --dry-run

# 격리된 입력으로 시험
node scripts/apply-daily-update.mjs --candidates /tmp/c.json --seed /tmp/s.json --audit /tmp/a.json
```

### 자동화가 보수적으로 동작하는 이유

제목만으로 단계를 올릴 수 없는 신호가 많다. 파업 찬반투표 가결, 파업권 확보,
부분파업 보도는 그 자체로 교섭 결렬(`S4`)을 만들지 않으며 기존 상태를 유지한다.
실제로 2026-08-10 실행에서는 158건 중 원문 확인까지 통과한 23건이 있었으나 공개
단계를 바꾼 건은 0건이었다. 이는 규칙이 의도대로 동작한 결과이지 수집 실패가 아니다.

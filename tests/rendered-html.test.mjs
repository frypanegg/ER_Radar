import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { classifyArticle, validateConfiguration } from "../scripts/collect-news.mjs";
import { resolveCurrentAsOf } from "../lib/collection-freshness.mjs";
import { formatDate } from "../lib/display-format.mjs";
import automationHeartbeat from "../data/automation-heartbeat.json" with { type: "json" };
import currentSeed from "../data/current-2026-fact-seed.json" with { type: "json" };

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    {
      ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function requestCompanyAddition() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("company-request", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/api/company-requests", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-dashboard-admin-code": "incorrect-code",
      },
      body: JSON.stringify({ companyLegalName: "테스트 주식회사" }),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

// 바닥글에 찍힌 기준일만 떼어 온다.
//
// 예전에는 문서 전체에서 `기준일.*기준 현황`을 찾았다. 화면은 기준일을 점으로
// 찍는데(2026.09.06) 기대값은 붙임표(2026-09-06)였으니 이 검사는 애초에 바닥글을
// 보고 있지 않았다. 대신 상단 띠의 "마지막 수집 2026-09-06 KST"에 걸려서, 두 날짜가
// 같은 날에만 우연히 통과했다. 사실이 실제로 반영된 날은 시드 기준일이 하루 앞서
// 나가면서 그 우연이 깨졌고, 06:20 실행이 그날 수집분을 통째로 되돌렸다.
// 2026-08-25 · 08-28 · 09-05 · 09-06이 그렇게 날아갔다.
function readAsOfLabel(html) {
  const footer = html.match(/<div class="footer-meta">([\s\S]*?)<\/div>/)?.[1] ?? "";
  const text = footer.replaceAll("<!-- -->", "").replace(/<[^>]+>/g, "");
  return text.match(/([\d.]+)\s*기준 현황/)?.[1] ?? null;
}

test("server-renders the collective-bargaining framework dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.equal(
    response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive, nosnippet, noimageindex",
  );

  const html = await response.text();
  assert.match(html, /<title>노사교섭 레이더 \| 원청 노조 교섭 현황<\/title>/);
  assert.match(html, /교섭현황 대시보드/);
  assert.match(html, /원청 노조/);
  assert.match(html, /교섭 단계별 조회/);
  assert.match(html, /회사 검색/);
  assert.doesNotMatch(html, /협약 범위/);
  assert.match(html, /교섭 경과/);
  assert.match(html, /데이터 수정/);
  assert.match(html, /2026년 현재/);

  // 기준일을 문자열로 박아 두면 사실이 실제로 반영되는 날 이 테스트가 깨진다.
  // 2026-08-15에 그 일이 났고, 회귀 검증 실패로 그날 수집분 전체가 되돌려졌다.
  // 화면과 같은 함수로 기대값을 계산해 규칙이 어긋날 때만 실패하게 한다.
  const expectedAsOf = resolveCurrentAsOf({
    seedAsOf: currentSeed.asOf,
    heartbeat: automationHeartbeat,
  });
  assert.equal(readAsOfLabel(html), formatDate(expectedAsOf));
  assert.match(html, /radar-mark/);
  assert.match(html, /삼성전자 주식회사/);
  assert.match(html, /HD현대중공업 주식회사/);
  assert.match(html, /원문 URL 주석/);
  assert.doesNotMatch(html, /제조 법인 [A-E]|example\.invalid|데모 · 실제 현황 아님|프레임워크 시연/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow/);
  assert.match(html, /<meta name="googlebot" content="noindex, nofollow/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|loading skeleton/i);
});

test("화면이 마지막 수집 시각을 보여준다", async () => {
  // 수집이 멈춰도 화면이 평소와 똑같으면 사람이 멈춘 걸 알 수 없다.
  // 2026-08-11 아침에 스케줄이 유실됐을 때 정확히 이 문제가 드러났다.
  const heartbeat = JSON.parse(
    await readFile(new URL("data/automation-heartbeat.json", templateRoot), "utf8"),
  );
  // 예정 시각은 설정에서 읽는다. 여기에 시각을 박아 두면 스케줄을 옮길 때 화면·설정·
  // 워크플로 가운데 하나만 바뀌어도 어느 쪽이 맞는지 알 수 없게 된다.
  const { collectionPolicy } = JSON.parse(
    await readFile(new URL("data/source-config.json", templateRoot), "utf8"),
  );
  const html = await (await render()).text();

  assert.ok(
    html.includes(`수집 예정: 매일 ${collectionPolicy.recommendedRunTime} KST`),
    `화면이 수집 예정 시각 ${collectionPolicy.recommendedRunTime} KST를 보여줘야 한다`,
  );
  assert.match(
    html,
    new RegExp(heartbeat.lastRunKstDate.replaceAll("-", "\\-")),
    "마지막 수집 KST 날짜가 화면에 있어야 한다",
  );
  assert.match(html, /collection-state/);
});

test("기록 수정 요청은 검증 없이 공개 데이터를 바꾸지 못한다", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("correction", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const post = (body, headers = {}) =>
    worker.fetch(
      new Request("http://localhost/api/record-corrections", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
      { waitUntil() {}, passThroughOnException() {} },
    );

  // Supabase·관리 코드가 설정되지 않은 상태에서는 접수 자체를 열지 않는다.
  const unconfigured = await post({ targetRecordId: "x" });
  assert.equal(unconfigured.status, 503);
  assert.match((await unconfigured.json()).error, /데이터베이스 연결/);
  assert.equal(
    unconfigured.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive, nosnippet, noimageindex",
  );

  // GET으로는 접수되지 않는다.
  const wrongMethod = await worker.fetch(
    new Request("http://localhost/api/record-corrections"),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(wrongMethod.status, 405);

  // 수정 경로가 자동 수집보다 느슨해지지 않도록, 근거 URL을 필수로 둔다.
  const source = await readFile(new URL("worker/index.ts", templateRoot), "utf8");
  assert.match(source, /근거 원문 URL은 http·https 주소로 입력 필요/);
  assert.match(source, /status: "PENDING"/);

  // 운영 관리 코드를 화면에서 없앤 대신 신청자 신원을 필수로 받는다. 신원은 인증이
  // 아니므로, 접수만으로 공개 데이터가 바뀌지 않는 순서가 그대로여야 한다.
  assert.match(source, /readRequesterIdentity/);
  for (const required of [
    "신청자 소속 입력 필요",
    "신청자 회사 입력 필요",
    "신청자 직급 입력 필요",
    "휴대전화번호는",
    "이메일 주소 형식 확인 필요",
  ]) {
    assert.ok(source.includes(required), `신원 항목 검증이 빠졌다: ${required}`);
  }

  // 접수 경로에서는 더 이상 관리 코드를 확인하지 않는다. 그 값은 인증 링크 서명에만 쓴다.
  assert.doesNotMatch(source, /hasSameSecret\(request\.headers\.get\("x-dashboard-admin-code"\)/);
  assert.doesNotMatch(source, /admin_code:\s*/);
  // 코드 원문은 어떤 대장에도 저장하지 않는다.
  assert.doesNotMatch(source, /admin_code_verified_at/);

  // 승인으로 공개 데이터를 바꾼 사실은 별도 이력 대장에 남는다.
  assert.match(source, /manual_change_audits/);
});

test("교섭 경과와 종결·이월 상태를 함께 보여준다", async () => {
  // 이 화면은 현재 상태만 보는 도구가 아니다. 교착·조정 횟수, 쟁의 수준, 그리고 그 해에
  // 체결됐는지(또는 이듬해로 넘어갔는지)를 단계와 같이 읽을 수 있어야 한다.
  const html = await (await render()).text();

  assert.match(html, /flow-rollup/, "교섭 경과 누적 지표가 있어야 한다");
  assert.match(html, /교착·조정/);
  assert.match(html, /본교섭 기록/);
  // 체결·이월은 확인된 상태이므로 칩으로 단다. 미확인은 칩을 달지 않는다. "체결 확인 못 함"은
  // 확인하지 못했다는 말을 결론처럼 붙여, 체결되지 않았다는 뜻으로 읽혔다.
  assert.doesNotMatch(html, /settlement-chip settlement-settlement_unconfirmed/);
  assert.doesNotMatch(html, /체결 확인 못 함/);

  // 이슈는 노조 선거 단독 항목이 아니라 교섭을 움직인 사실을 모아 보여준다.
  assert.match(html, /identity-issues/);
  assert.doesNotMatch(html, /노조 선거 이슈/);

  // 주 단계에서 그대로 파생되던 병렬 상태 행과, 내부 판정용 범위 증빙은 화면에서 뺀다.
  assert.doesNotMatch(html, /병렬 상태/);
  assert.doesNotMatch(html, /원청 노조 범위 증빙/);
  assert.doesNotMatch(html, /법인 × 교섭연도 × 협약유형/);

  // 서비스 이름은 히어로 제목 자리에서 한 번만 크게 보여준다.
  assert.match(html, /hero-brand/);
});

test("교섭 단계 모델은 제목 옆에 두고 별도 섹션으로 두지 않는다", async () => {
  // 단계 축은 특정 회사의 좌표가 아니라 이 화면이 쓰는 축을 읽는 자리다. 그것만으로
  // 한 섹션과 메뉴 항목을 차지할 만큼의 내용이 아니어서 제목 옆으로 옮겼다.
  const html = await (await render()).text();

  assert.match(html, /hero-stage-model/, "단계 모델이 히어로에 있어야 한다");
  assert.match(html, /hero-stage-track/);

  // 10개 단계가 순서대로 다 나와야 축으로 읽힌다.
  for (const code of ["U", "S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"]) {
    assert.match(html, new RegExp(`hero-stage-code">${code}<`), `${code}가 있어야 한다`);
  }

  // 설명은 기본으로 접어 둔다. 펼치지 않아도 읽히면 섹션을 옮긴 뜻이 없어진다.
  assert.match(html, /<details class="hero-stage-glossary"(?![^>]*\bopen\b)/);
  assert.match(html, /단계 설명 보기/);

  // 옛 섹션과 메뉴 항목은 남지 않아야 한다.
  assert.doesNotMatch(html, /framework-section/);
  assert.doesNotMatch(html, /id="framework"/);
  assert.doesNotMatch(html, /단계 프레임워크/);
  assert.doesNotMatch(html, /stage-dictionary/);
  assert.doesNotMatch(html, /단계는 정렬 좌표/);
});

test("교섭현황이 없는 단계 버튼은 눌리지 않는다", async () => {
  // 단계 버튼을 누를 때마다 반응이 달랐다. 사례가 있는 단계는 목록이 좁혀지고 상세가
  // 따라왔지만, 없는 단계는 목록이 0건이 되면서 상세에는 조건과 무관한 회사가 그대로
  // 남았다. 같은 버튼처럼 생겼는데 결과가 갈리는 상태였다.
  const html = await (await render()).text();
  const source = await readFile(new URL("app/page.tsx", templateRoot), "utf8");

  // 2026년 기준으로 S0·S2·S5에는 공개 교섭현황이 없다. 잠금 표시가 실제로 나가야 한다.
  assert.match(html, /stage-filter-chip[^>]*disabled/, "빈 단계 필터 칩은 잠겨야 한다");

  // 단계를 고르는 입구는 목록 위 필터 칩 하나로 모았다. 같은 stageFocus를 조작하는
  // 컨트롤이 둘이면 한쪽만 토글이 되어 같은 단계를 두 번 눌렀을 때 반응이 갈린다.
  assert.match(source, /onClick=\{\(\) => focusStage\(stage\.code\)\}/);
  assert.equal(
    source.match(/focusStage\(stage\.code\)/g)?.length,
    1,
    "단계를 고르는 컨트롤은 하나여야 한다",
  );
  assert.doesNotMatch(
    source,
    /setStageFocus\(\(current\) => current === stage\.code/,
    "토글로 동작하면 안 된다",
  );

  // 목록이 비었는데 상세만 남으면, 목록은 "없음"인데 아래에는 다른 회사가 펼쳐진다.
  assert.match(source, /\{visibleCases\.length > 0 && \(\s*<article className="case-detail"/);
});

test("keeps scope and source guards in the production-facing implementation", async () => {
  const [page, layout, config, framework, pipeline, historicalSeed, currentSeed] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../data/source-config.json", import.meta.url), "utf8"),
    readFile(new URL("../data/negotiation-framework.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/collect-news.mjs", import.meta.url), "utf8"),
    readFile(new URL("../data/historical-fact-seed.json", import.meta.url), "utf8"),
    readFile(new URL("../data/current-2026-fact-seed.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /"use client"/);
  assert.match(page, /원청 노조 확정 법인 검색/);
  assert.match(page, /교섭 단계별 조회/);
  assert.match(page, /하청·사내협력사·용역·파견/);
  assert.match(page, /추적 기업 추가/);
  assert.match(page, /데이터 수정/);
  assert.match(page, /correction-target-list/);
  assert.match(page, /\/api\/company-requests/);
  assert.doesNotMatch(page, /SkeletonPreview/);
  assert.match(layout, /노사교섭 레이더 \| 원청 노조 교섭 현황/);
  assert.match(layout, /index: false/);
  assert.match(layout, /noimageindex: true/);
  assert.doesNotMatch(layout, /openGraph/);
  assert.doesNotMatch(layout, /twitter/);
  assert.match(framework, /"S0"/);
  // S8(이행·사후관리)은 단계 축에서 없앴다. 되살아나면 화면에 누를 수 없는 칩이 다시 생긴다.
  assert.doesNotMatch(framework, /"S8"/);
  assert.match(config, /"scopeReviewAgent"/);
  assert.match(config, /"primary-union-scope-review"/);
  assert.match(config, /"authentication": "api-hub"/);
  assert.match(pipeline, /eligibleForStatusAggregation/);
  assert.match(pipeline, /requiresSourceVerification/);
  assert.match(pipeline, /X-NCP-APIGW-API-KEY-ID/);

  const seed = JSON.parse(historicalSeed);
  const current = JSON.parse(currentSeed);
  // 추적 목록은 늘어난다. 굳은 숫자를 박아 두면 법인을 추가할 때마다 데이터가 아니라
  // 테스트가 깨진다. 지켜야 할 것은 개수가 아니라 두 목록이 같은 법인 집합을 가리키고
  // 초기 12개사 아래로 줄지 않는다는 점이다.
  assert.ok(seed.trackingCompanies.length >= 12);
  assert.equal(seed.coverage.length, seed.trackingCompanies.length);
  assert.ok(seed.records.length >= 44);
  assert.ok(seed.records.every((record) => record.scopeClassification === "PRIMARY_DIRECT_UNION"));
  assert.ok(seed.records.every((record) => record.includeInPrimaryDashboard === true));
  assert.ok(seed.records.every((record) => /^https?:\/\//.test(record.sourceUrl)));
  assert.ok(seed.records.every((record) => !record.sourceUrl.includes("example.invalid")));
  // 일일 자동 반영이 기준일을 앞으로 밀기 때문에 고정 날짜 대신 형식과 하한을 본다.
  assert.match(current.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(current.asOf >= "2026-08-10");
  // 2026년 레코드는 추적 법인 수와 같지 않다. 그해 사건을 아직 원문으로 확인하지 못한
  // 법인은 레코드 없이 "근거 미확인"으로 남기는 것이 이 프로젝트의 규칙이다.
  assert.ok(current.records.length >= 12);
  assert.ok(current.records.length <= seed.trackingCompanies.length);
  assert.ok(current.records.every((record) => record.bargainingYear === 2026));
  assert.ok(current.records.every((record) => record.scopeClassification === "PRIMARY_DIRECT_UNION"));
  assert.ok(current.records.every((record) => record.coveredWorkerRelation === "DIRECT"));
  assert.ok(current.records.every((record) => record.includeInPrimaryDashboard === true));
  assert.ok(current.records.every((record) => /^https?:\/\//.test(record.sourceUrl)));
  assert.ok(current.records.every((record) => record.flowEvents.length > 0));

  const robots = await readFile(new URL("../public/robots.txt", import.meta.url), "utf8");
  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Disallow: \//);

  await assert.rejects(access(new URL("app/_sites-preview", templateRoot)));
});

test("does not expose unauthenticated company-request writes before the database is configured", async () => {
  const response = await requestCompanyAddition();
  assert.equal(response.status, 503);
  assert.equal(
    response.headers.get("x-robots-tag"),
    "noindex, nofollow, noarchive, nosnippet, noimageindex",
  );
  const body = await response.json();
  assert.match(body.error, /데이터베이스 연결/);
});

test("메일 검토 링크는 서명이 맞아도 GET만으로 DB를 바꾸지 않는다", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("admin-review", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCount += 1; return new Response("[]", { status: 200 }); };
  try {
    const invalid = await worker.fetch(
      new Request("http://localhost/admin/review?kind=correction&id=00000000-0000-4000-8000-000000000001&expires=1800000000&signature=invalid"),
      {
        ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "server-only",
        DASHBOARD_ADMIN_CODE: "admin-secret",
      },
      { waitUntil() {}, passThroughOnException() {} },
    );
    assert.equal(invalid.status, 403);
    assert.equal(fetchCount, 0, "서명이 틀리면 DB 조회도 하지 않아야 한다");
    assert.equal(invalid.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet, noimageindex");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const source = await readFile(new URL("worker/index.ts", templateRoot), "utf8");
  assert.match(source, /bargaining_cases\?select=id/);
  assert.match(source, /status=eq\.PENDING/);
  assert.match(source, /reviewed_by=is\.null/);
  assert.match(source, /EMAIL_REVIEW_PROCESSING/);
  assert.match(source, /changedCase/);
  assert.match(source, /status !== "PENDING"/);
});

test("승인 기업은 최근 5개년 비공개 후보 수집으로 이어진다", async () => {
  const [schema, workflow, processor] = await Promise.all([
    readFile(new URL("../supabase/migrations/20260810_initial_bargaining_dashboard.sql", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/process-company-onboarding.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/process-company-onboarding.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(schema, /CREATE TABLE public\.scope_review_audits/);
  assert.match(schema, /UNKNOWN_REVIEW/);
  assert.match(schema, /ENABLE ROW LEVEL SECURITY/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /process-company-onboarding\.mjs/);
  assert.match(processor, /scope_classification: "UNKNOWN_REVIEW"/);
  assert.match(processor, /is_published: false/);
  assert.match(processor, /currentYear - 4/);
  assert.doesNotMatch(processor, /bargaining_cases\?/);
});

test("quarantines subcontractor bargaining before a primary-company stage is assigned", async () => {
  const config = JSON.parse(
    await readFile(new URL("../data/source-config.json", import.meta.url), "utf8"),
  );
  validateConfiguration(config);
  const now = new Date("2026-08-10T00:00:00.000Z");
  const baseRecord = {
    media: "검증 매체",
    publishedAt: now.toISOString(),
    originalUrl: "https://example.com/original",
    collectionSources: ["naver"],
    originCompanyIds: ["hyundai-motor"],
  };

  const primary = classifyArticle(
    {
      ...baseRecord,
      title: "현대차 노조 임금협상 교섭 재개",
      url: "https://example.com/primary",
    },
    config,
    now,
    2026,
  );
  const subcontractor = classifyArticle(
    {
      ...baseRecord,
      title: "현대차 하청 노조, 원청에 임금교섭 요구",
      url: "https://example.com/subcontractor",
    },
    config,
    now,
    2026,
  );

  assert.equal(primary.classification.scopeClassification, "PRIMARY_DIRECT_UNION");
  assert.equal(primary.classification.includeInPrimaryDashboard, true);
  assert.equal(primary.classification.statusCode, "S3");
  assert.equal(primary.classification.eligibleForStatusAggregation, true);

  assert.equal(
    subcontractor.classification.scopeClassification,
    "SUBCONTRACTOR_UNION_EXCLUDED",
  );
  assert.equal(subcontractor.classification.includeInPrimaryDashboard, false);
  assert.equal(subcontractor.classification.statusCode, "U");
  assert.equal(
    subcontractor.classification.excludedAudit
      .excludedFromStatusIssuesAndMediaExposure,
    true,
  );
});

test("기업 목록이 최근 확인된 순서로 나온다", async () => {
  const html = await (await render()).text();

  // 카드 순서는 렌더된 법인명으로 읽는다. 카드는 법적 실명을 title 속성에 남긴다.
  const rendered = [...html.matchAll(/class="case-card[^"]*"[\s\S]*?<strong title="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(rendered.length > 1, "카드가 두 개 이상 렌더돼야 순서를 검증할 수 있다");

  // 화면과 같은 규칙으로 기대 순서를 만든다. 대표 사건과 경과 중 가장 늦은 날짜가
  // 그 법인의 최신 확인일이고, 공개할 사실이 없는 법인은 비교 대상이 없어 맨 뒤다.
  const historicalSeed = JSON.parse(
    await readFile(new URL("../data/historical-fact-seed.json", import.meta.url), "utf8"),
  );
  const year = Math.max(
    ...[...currentSeed.records, ...historicalSeed.records].map((record) => record.bargainingYear),
  );
  const lastUpdatedByName = new Map();
  for (const record of [...currentSeed.records, ...historicalSeed.records]) {
    if (record.bargainingYear !== year) continue;
    const latest = (record.flowEvents ?? []).reduce(
      (newest, event) => (event.date > newest ? event.date : newest),
      record.eventDate,
    );
    const previous = lastUpdatedByName.get(record.companyLegalName);
    if (!previous || latest > previous) lastUpdatedByName.set(record.companyLegalName, latest);
  }

  const renderedDates = rendered.map((name) => lastUpdatedByName.get(name) ?? null);
  for (let index = 1; index < renderedDates.length; index += 1) {
    const previous = renderedDates[index - 1];
    const current = renderedDates[index];
    if (current === null) continue; // 사실이 없는 법인은 뒤쪽에 몰려 있다.
    assert.ok(
      previous !== null,
      `사실이 없는 법인이 ${rendered[index]}(${current})보다 앞에 있다`,
    );
    assert.ok(
      previous >= current,
      `순서가 최신순이 아니다: ${rendered[index - 1]}(${previous}) → ${rendered[index]}(${current})`,
    );
  }

  // 고정 순서로 되돌아가면 맨 앞 카드가 최신이 아니게 되므로 여기서 걸린다.
  //
  // 단, 어느 "법인"이 맨 앞인지는 굳히지 않는다. 같은 날짜를 가진 법인이 여럿일 때
  // 화면은 이름순으로 가르는데, 기대값을 법인명으로 잡으면 그 동점 규칙까지 똑같이
  // 흉내내야 한다. 실제로 2026-08-25 수집에서 기아가 현대자동차와 같은 날짜로 올라오면서
  // 이 단언만 깨졌고, 그 하나 때문에 그날 수집분 전체가 되돌려졌다. 지켜야 할 성질은
  // "맨 앞이 가장 최근"이지 "맨 앞이 현대자동차"가 아니다.
  const newestDate = [...lastUpdatedByName.values()].reduce(
    (newest, date) => (date > newest ? date : newest),
    "",
  );
  assert.equal(
    renderedDates[0],
    newestDate,
    `맨 앞 카드가 최신이 아니다: ${rendered[0]}(${renderedDates[0]}) · 최신 ${newestDate}`,
  );
});

// 추적 대상을 제조업 밖으로 넓혔다. 항공·금융·플랫폼·철도가 들어오면서 화면 문구의
// "제조업"이 사실과 어긋나게 됐고, 굳어 있던 12개사 가정도 함께 풀었다.
test("추적 대상이 제조업을 넘어선 주요 기업으로 넓혀져 있다", async () => {
  const [page, universe, historicalSeed, currentSeed] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../data/company-universe.json", import.meta.url), "utf8"),
    readFile(new URL("../data/historical-fact-seed.json", import.meta.url), "utf8"),
    readFile(new URL("../data/current-2026-fact-seed.json", import.meta.url), "utf8"),
  ]);

  // 화면 안내 문구가 다시 제조업으로 좁아지면 추적 목록과 어긋난다.
  assert.match(page, /대한민국 주요 기업의 단체교섭 현황을 모니터링합니다/);
  assert.doesNotMatch(page, /주요 제조업/);

  const tracked = new Set(
    JSON.parse(universe).initialPublicTracking.map((company) => company.id),
  );
  for (const id of ["korean-air", "kb-kookmin-bank", "kakao", "korail", "coupang"]) {
    assert.ok(tracked.has(id), `${id}가 추적 목록에 없다`);
  }

  // 확장 법인도 기존과 같은 원청 직접고용 게이트를 통과해야 한다.
  const seed = JSON.parse(historicalSeed);
  const current = JSON.parse(currentSeed);
  const added = [...seed.records, ...current.records].filter((record) =>
    tracked.has(record.companyId),
  );
  assert.ok(added.every((record) => record.scopeClassification === "PRIMARY_DIRECT_UNION"));
  assert.ok(added.every((record) => record.directEmployerId === record.companyId));
  assert.ok(added.every((record) => /^https?:\/\//.test(record.sourceUrl)));
});

// 사용자가 보려는 것은 "그 해 교섭이 언제 끝났는가"다. 과거 연도 레코드가 완료 시점을
// 담고 있는지 확인한다. 확인하지 못한 연도를 채우지 않는 것은 규칙이지만, 확인한 것을
// 빠뜨리면 화면이 비어 보인다.
test("확장 법인의 과거 연도 교섭 완료 시점이 시드에 들어 있다", async () => {
  const seed = JSON.parse(
    await readFile(new URL("../data/historical-fact-seed.json", import.meta.url), "utf8"),
  );
  const settledStages = new Set(["S5", "S6", "S7"]);
  const expected = [
    ["kumho-tire", 2025, "S7"],
    ["seoul-metro", 2024, "S6"],
    ["seoul-metro", 2025, "S6"],
    ["korail", 2025, "S5"],
    ["kb-kookmin-bank", 2025, "S6"],
  ];

  for (const [companyId, year, stage] of expected) {
    const record = seed.records.find(
      (candidate) => candidate.companyId === companyId && candidate.bargainingYear === year,
    );
    assert.ok(record, `${companyId} ${year} 기록이 없다`);
    assert.equal(record.stage, stage);
    assert.ok(settledStages.has(record.stage));
    assert.match(record.eventDate, /^\d{4}-\d{2}-\d{2}$/);
  }

  // 조인·서명 근거 없이 S7로 올린 행이 섞이면 안 된다.
  const signed = seed.records.filter((record) => record.stage === "S7");
  assert.ok(signed.every((record) => /조인|서명|체결|발효/.test(`${record.title} ${record.factSummary} ${record.annotation}`)));
});

// 추적 목록에 넣어도 수집기 설정에 없으면 그 법인은 영원히 갱신되지 않는다. 수집기는
// company-universe가 아니라 source-config를 읽기 때문이다. 두 목록이 갈라지면
// 화면에는 카드가 보이는데 내용은 처음 심은 값에서 멈춘다.
test("추적 목록과 수집기 설정이 같은 법인을 가리킨다", async () => {
  const [universe, config] = await Promise.all([
    readFile(new URL("../data/company-universe.json", import.meta.url), "utf8"),
    readFile(new URL("../data/source-config.json", import.meta.url), "utf8"),
  ]);

  const tracked = JSON.parse(universe).initialPublicTracking.map((company) => company.id);
  const collected = new Set(JSON.parse(config).companies.map((company) => company.id));

  const missing = tracked.filter((id) => !collected.has(id));
  assert.deepEqual(missing, [], `수집기 설정에 없는 추적 법인: ${missing.join(", ")}`);

  // 추적을 그만둔 법인이 수집기 설정에 남으면 매일 헛수집을 한다. 삭제는 두 파일에서
  // 함께 이뤄져야 한다.
  const trackedIds = new Set(tracked);
  const orphans = [...collected].filter((id) => !trackedIds.has(id));
  assert.deepEqual(orphans, [], `추적 목록에 없는 수집기 설정 법인: ${orphans.join(", ")}`);
});

test("추적 법인은 모두 2021년 이후 확인된 교섭 기록을 하나 이상 가진다", async () => {
  // 2021년까지 거슬러 아무 교섭도 확인되지 않는 법인은 추적 대상에서 뺀다. 근거가 한 건도
  // 없는 법인을 남겨 두면 화면이 '미확인'으로만 채워지고, 그 미확인이 '아직 못 찾았다'인지
  // '애초에 교섭 노출이 없다'인지 구분되지 않는다.
  const [universe, historical, current] = await Promise.all([
    readFile(new URL("../data/company-universe.json", import.meta.url), "utf8"),
    readFile(new URL("../data/historical-fact-seed.json", import.meta.url), "utf8"),
    readFile(new URL("../data/current-2026-fact-seed.json", import.meta.url), "utf8"),
  ]);

  const withRecords = new Set([
    ...JSON.parse(historical).records.map((record) => record.companyId),
    ...JSON.parse(current).records.map((record) => record.companyId),
  ]);

  const empty = JSON.parse(universe)
    .initialPublicTracking.map((company) => company.id)
    .filter((id) => !withRecords.has(id));
  assert.deepEqual(empty, [], `2021년 이후 근거가 한 건도 없는 추적 법인: ${empty.join(", ")}`);
});

test("카드에 찍힌 날짜가 목록 순서와 같은 값이다", async () => {
  // 두산에너빌리티는 대표 사건일이 2026-06-26이고 경과에 2026-08-24 총파업이 있다.
  // 정렬은 08-24로 하면서 카드에는 06-26을 찍으니, 08-21인 금호타이어보다 위에 있는
  // 카드가 더 오래된 날짜를 달고 있었다. 순서가 틀린 게 아니라 날짜 표기가 달랐다.
  const html = await (await render()).text();

  const rendered = [
    ...html.matchAll(
      // 화면 글자는 "1일 전 확인"처럼 상대 표기로 바뀌므로 절대 날짜를 담은 title로 읽는다.
      /class="case-card[^"]*"[\s\S]*?<strong title="([^"]+)"[\s\S]*?title="마지막 확인 ([\d.]+)"/g,
    ),
  ].map(([, name, date]) => ({ name, date }));
  assert.ok(rendered.length > 1, "카드가 두 개 이상 렌더돼야 비교할 수 있다");

  const historicalSeed = JSON.parse(
    await readFile(new URL("../data/historical-fact-seed.json", import.meta.url), "utf8"),
  );
  const year = Math.max(
    ...[...currentSeed.records, ...historicalSeed.records].map((record) => record.bargainingYear),
  );
  const expected = new Map();
  for (const record of [...currentSeed.records, ...historicalSeed.records]) {
    if (record.bargainingYear !== year) continue;
    const latest = (record.flowEvents ?? []).reduce(
      (newest, event) => (event.date > newest ? event.date : newest),
      record.eventDate,
    );
    const previous = expected.get(record.companyLegalName);
    if (!previous || latest > previous) expected.set(record.companyLegalName, latest);
  }

  const mismatched = rendered.filter(
    (card) => expected.has(card.name) && card.date !== expected.get(card.name).replaceAll("-", "."),
  );
  assert.deepEqual(
    mismatched.map((card) => `${card.name}: 카드 ${card.date} ≠ 정렬 ${expected.get(card.name)}`),
    [],
    "카드 날짜가 정렬 기준과 다르다",
  );

  // 표기가 같아지면 카드 날짜만 훑어도 내림차순이어야 한다.
  const dates = rendered.filter((card) => expected.has(card.name)).map((card) => card.date);
  const descending = [...dates].sort((left, right) => right.localeCompare(left));
  assert.deepEqual(dates, descending, `카드 날짜가 최신순이 아니다: ${dates.join(" → ")}`);
});

test("좁은 화면에서 날짜 줄이 상세 패널을 밀어내지 않는다", async () => {
  // 전환일을 한 줄에 붙들려고 넣은 flex-wrap: nowrap이 좁은 화면에서 이 줄의 최소 너비를
  // 600px 너머로 키웠다. 그 폭이 그리드 트랙을 밀어 상세 패널이 통째로 화면 밖으로
  // 잘렸다. 넓은 화면에서만 한 줄로 붙들고, 좁은 화면에서는 반드시 풀어 준다.
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  // 720px 블록은 파일에 여러 개다. 전부 모아서 본다.
  const mobileBlocks = [];
  for (let start = css.indexOf("@media (max-width: 720px)"); start !== -1;
       start = css.indexOf("@media (max-width: 720px)", start + 1)) {
    let depth = 0;
    for (let index = css.indexOf("{", start); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          mobileBlocks.push(css.slice(start, index + 1));
          break;
        }
      }
    }
  }
  assert.ok(mobileBlocks.length > 0, "720px 미디어 블록이 있어야 한다");

  const rule = mobileBlocks
    .map((block) => block.match(/\.timeline-span\s*\{([^}]*)\}/))
    .find(Boolean);
  assert.ok(rule, "좁은 화면 규칙에 .timeline-span이 있어야 한다");
  assert.match(
    rule[1],
    /flex-wrap:\s*wrap/,
    "좁은 화면에서는 날짜 줄의 줄바꿈을 열어 둬야 한다",
  );
});

test("상세 패널이 화면에 붙들려 있다", async () => {
  // 목록이 3,000px을 넘는다. 아래쪽 카드를 눌렀을 때 상세가 화면 위 수천 px 지점에서
  // 바뀌면 사용자에게는 아무 일도 일어나지 않은 것으로 보인다.
  // 주석에도 overflow 이야기가 적혀 있으므로 선언만 남기고 본다.
  const css = (await readFile(new URL("../app/globals.css", import.meta.url), "utf8"))
    .replaceAll(/\/\*[\s\S]*?\*\//g, "");

  const baseRule = css.slice(0, css.indexOf("@media")).match(/\.case-detail\s*\{([^}]*)\}/);
  assert.ok(baseRule, "기본 규칙에 .case-detail이 있어야 한다");
  assert.match(baseRule[1], /position:\s*sticky/, "상세 패널은 sticky여야 한다");
  // 그리드 항목은 기본이 stretch다. 늘어난 채로는 sticky가 움직일 자리가 없다.
  assert.match(baseRule[1], /align-self:\s*start/, "sticky가 움직이려면 높이가 내용에 맞아야 한다");

  // overflow: hidden인 조상이 있으면 sticky는 뷰포트가 아니라 그 조상에 묶여 아무 일도
  // 하지 않는다. 가로만 자를 때는 스크롤 컨테이너를 만들지 않는 clip을 쓴다.
  const shell = css.match(/\.site-shell\s*\{([^}]*)\}/);
  assert.ok(shell, ".site-shell 규칙이 있어야 한다");
  assert.doesNotMatch(
    shell[1],
    /overflow(-y)?:\s*(hidden|auto|scroll)/,
    ".site-shell이 스크롤 컨테이너가 되면 상세 패널의 sticky가 죽는다",
  );
});

test("좁은 화면에서 상세 패널이 화면 폭 안에 머문다", async () => {
  // 1fr은 minmax(auto, 1fr)이다. auto 최소는 칸에 든 것의 min-content라, 상세 패널처럼
  // 안에 nowrap 텍스트를 품은 항목이 들어가면 한 칸짜리 격자가 화면보다 넓어진다.
  // 그러면 목록은 제 안에서 가로로 넘겨지는데 상세는 화면 밖으로 밀려 손이 닿지 않고,
  // 가로로 쓸면 페이지 전체가 딸려 움직인다.
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  const bare = [...css.matchAll(/grid-template-columns:\s*1fr\s*;/g)];
  assert.deepEqual(
    bare.map((match) => match[0]),
    [],
    "한 칸짜리 격자는 minmax(0, 1fr)로 적어야 칸이 화면 밖으로 벌어지지 않는다",
  );

  const mobileBlocks = [];
  for (let start = css.indexOf("@media (max-width: 720px)"); start !== -1;
       start = css.indexOf("@media (max-width: 720px)", start + 1)) {
    let depth = 0;
    for (let index = css.indexOf("{", start); index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          mobileBlocks.push(css.slice(start, index + 1));
          break;
        }
      }
    }
  }
  const mobile = mobileBlocks.join("\n");
  assert.ok(mobile.length > 0, "720px 미디어 블록이 있어야 한다");

  // 칸을 화면 폭에 묶어도 항목은 min-width: auto라 제 min-content만큼 칸을 넘어선다.
  const shrinkable = mobile.match(/\.case-list,\s*\.case-detail\s*\{([^}]*)\}/);
  assert.ok(shrinkable, "좁은 화면 규칙에 .case-list, .case-detail 묶음이 있어야 한다");
  assert.match(shrinkable[1], /min-width:\s*0/, "목록과 상세는 칸 안으로 줄어들 수 있어야 한다");

  const items = mobile.match(/\.detail-bottom-grid\s*>\s*\*[^{]*\{([^}]*)\}/);
  assert.ok(items, "좁은 화면 규칙에 상세 하단 격자 항목 규칙이 있어야 한다");
  assert.match(items[1], /min-width:\s*0/, "상세 하단 격자 항목도 칸 안으로 줄어들어야 한다");

  // 근거 제목을 한 줄 말줄임으로 두면 min-content가 380px을 넘어 위 규칙을 도로 무너뜨린다.
  const evidence = mobile.match(/\.evidence-row strong,\s*\.evidence-row span\s*\{([^}]*)\}/);
  assert.ok(evidence, "좁은 화면 규칙에 근거 줄 규칙이 있어야 한다");
  assert.match(evidence[1], /white-space:\s*normal/, "좁은 화면에서는 기사 제목이 줄바꿈되어야 한다");
});

test("11px보다 작은 글자를 쓰지 않는다", async () => {
  // 한글은 9~10px에서 형태 변별이 되지 않는다. 11px로 올려서 깨지는 라벨은 없어도 되는
  // 정보이므로 지운다.
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const tooSmall = [...css.matchAll(/font-size:\s*([0-9]+(?:\.[0-9]+)?)px/g)]
    .map(([, size]) => Number(size))
    .filter((size) => size < 11);
  assert.deepEqual(tooSmall, [], `11px 미만 글자가 있다: ${tooSmall.join(", ")}px`);
});

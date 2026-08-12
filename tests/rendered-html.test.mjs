import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { classifyArticle, validateConfiguration } from "../scripts/collect-news.mjs";

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
  assert.match(html, /2026-08-10.*기준 현황/);
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
  const html = await (await render()).text();

  assert.match(html, /수집 예정: 매일 06:30 KST/);
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

  // 수정 경로가 자동 수집보다 느슨해지지 않도록, 근거 URL과 수정자를 필수로 둔다.
  const source = await readFile(new URL("worker/index.ts", templateRoot), "utf8");
  assert.match(source, /근거 원문 URL은 http·https 주소로 입력 필요/);
  assert.match(source, /수정자 이름 입력 필요/);
  assert.match(source, /status: "PENDING"/);
  assert.match(source, /admin_code_verified_at/);
  // 관리 코드는 상수 시간 비교로만 확인하고 원문을 저장하지 않는다.
  assert.match(source, /hasSameSecret\(request\.headers\.get\("x-dashboard-admin-code"\)/);
  assert.doesNotMatch(source, /admin_code:\s*/);
});

test("교섭 경과와 종결·이월 상태를 함께 보여준다", async () => {
  // 이 화면은 현재 상태만 보는 도구가 아니다. 교착·조정 횟수, 쟁의 수준, 그리고 그 해에
  // 체결됐는지(또는 이듬해로 넘어갔는지)를 단계와 같이 읽을 수 있어야 한다.
  const html = await (await render()).text();

  assert.match(html, /flow-rollup/, "교섭 경과 누적 지표가 있어야 한다");
  assert.match(html, /교착·조정/);
  assert.match(html, /본교섭 기록/);
  assert.match(html, /settlement-chip settlement-(settled|continued_past_year|settlement_unconfirmed)/);

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
  assert.match(framework, /"S8"/);
  assert.match(config, /"scopeReviewAgent"/);
  assert.match(config, /"primary-union-scope-review"/);
  assert.match(config, /"authentication": "api-hub"/);
  assert.match(pipeline, /eligibleForStatusAggregation/);
  assert.match(pipeline, /requiresSourceVerification/);
  assert.match(pipeline, /X-NCP-APIGW-API-KEY-ID/);

  const seed = JSON.parse(historicalSeed);
  const current = JSON.parse(currentSeed);
  assert.equal(seed.trackingCompanies.length, 12);
  assert.equal(seed.coverage.length, 12);
  assert.ok(seed.records.length >= 44);
  assert.ok(seed.records.every((record) => record.scopeClassification === "PRIMARY_DIRECT_UNION"));
  assert.ok(seed.records.every((record) => record.includeInPrimaryDashboard === true));
  assert.ok(seed.records.every((record) => /^https?:\/\//.test(record.sourceUrl)));
  assert.ok(seed.records.every((record) => !record.sourceUrl.includes("example.invalid")));
  // 일일 자동 반영이 기준일을 앞으로 밀기 때문에 고정 날짜 대신 형식과 하한을 본다.
  assert.match(current.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(current.asOf >= "2026-08-10");
  assert.equal(current.records.length, 12);
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

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { classifyArticle, validateConfiguration } from "../scripts/collect-news.mjs";
import { resolveCurrentAsOf } from "../lib/collection-freshness.mjs";
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
  assert.match(html, new RegExp(`${expectedAsOf}.*기준 현황`));
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

test("교섭 단계 모델은 제목 옆에 두고 별도 섹션으로 두지 않는다", async () => {
  // 단계 축은 특정 회사의 좌표가 아니라 이 화면이 쓰는 축을 읽는 자리다. 그것만으로
  // 한 섹션과 메뉴 항목을 차지할 만큼의 내용이 아니어서 제목 옆으로 옮겼다.
  const html = await (await render()).text();

  assert.match(html, /hero-stage-model/, "단계 모델이 히어로에 있어야 한다");
  assert.match(html, /hero-stage-track/);

  // 10개 단계가 순서대로 다 나와야 축으로 읽힌다.
  for (const code of ["U", "S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]) {
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

  // 2026년 기준으로 S0·S2·S5·S8에는 공개 교섭현황이 없다. 잠금 표시가 실제로 나가야 한다.
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

  // 고정 순서로 되돌아가면 이 단언이 먼저 깨진다.
  const newest = [...lastUpdatedByName.entries()].sort((left, right) =>
    right[1].localeCompare(left[1]),
  )[0];
  assert.equal(rendered[0], newest[0]);
});

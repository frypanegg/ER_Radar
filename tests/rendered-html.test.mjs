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
  assert.match(html, /교섭 경과/);
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

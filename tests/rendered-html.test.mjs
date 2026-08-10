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

test("server-renders the collective-bargaining framework dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>노사교섭 레이더 \| 교섭상태 프레임워크<\/title>/);
  assert.match(html, /교섭사건 보드/);
  assert.match(html, /원청 직접고용/);
  assert.match(html, /교섭 단계별 조회/);
  assert.match(html, /S6/);
  assert.match(html, /원문 URL 주석/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site|loading skeleton/i);
});

test("keeps scope and source guards in the production-facing implementation", async () => {
  const [page, layout, config, framework, pipeline] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../data/source-config.json", import.meta.url), "utf8"),
    readFile(new URL("../data/negotiation-framework.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/collect-news.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(page, /"use client"/);
  assert.match(page, /원청 직접고용 확정 법인 검색/);
  assert.match(page, /교섭 단계별 조회/);
  assert.match(page, /하청·사내협력사·용역·파견/);
  assert.doesNotMatch(page, /SkeletonPreview/);
  assert.match(layout, /노사교섭 레이더 \| 교섭상태 프레임워크/);
  assert.match(layout, /social\/collective-bargaining-radar-og\.png/);
  assert.match(framework, /"S0"/);
  assert.match(framework, /"S8"/);
  assert.match(config, /"scopeReviewAgent"/);
  assert.match(config, /"primary-union-scope-review"/);
  assert.match(config, /"authentication": "api-hub"/);
  assert.match(pipeline, /eligibleForStatusAggregation/);
  assert.match(pipeline, /requiresSourceVerification/);
  assert.match(pipeline, /X-NCP-APIGW-API-KEY-ID/);

  await assert.rejects(access(new URL("app/_sites-preview", templateRoot)));
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

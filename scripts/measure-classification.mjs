#!/usr/bin/env node
// 분류기 성능을 네트워크 없이 재측정한다.
//
// docs/search-source-strategy.md가 요구하는 출처·분류 검증인데 그동안 측정 수단이
// 없었다. 그래서 "보수적이라 안전하다"와 "아무것도 반영되지 않는다"를 구분할 수
// 없었다. 실제로 감사 로그 5회 연속 반영 0건이었고, 원인은 범위 판정이 아니라
// 근거 등급 게이트였다.
//
// 저장된 후보 목록(public/data/news-candidates.json)의 기사 레코드를 그대로
// classifyArticle에 다시 통과시켜 깔때기(funnel)를 출력한다. 규칙을 고치기 전후에
// 같은 입력으로 돌려 비교하는 것이 이 파일의 목적이다.

import { readFile } from "node:fs/promises";
import { classifyArticle, validateConfiguration } from "./collect-news.mjs";

const root = new URL("../", import.meta.url);

const SCOPES = [
  "PRIMARY_DIRECT_UNION",
  "UNKNOWN_REVIEW",
  "SUBCONTRACTOR_UNION_EXCLUDED",
  "AFFILIATE_UNION_EXCLUDED",
  "MIXED_NEEDS_SPLIT",
];

/** 분류 결과 묶음에서 깔때기 지표를 뽑는다. 순수 함수라 테스트에서 그대로 쓴다. */
export function summarize(classifications) {
  const total = classifications.length;
  const scope = Object.fromEntries(SCOPES.map((name) => [name, 0]));
  const blockingTerms = {
    협약유형_미확인: 0,
    조정교착_기사: 0,
    인준가결_기사: 0,
    원문URL_없음: 0,
    복수법인: 0,
    법인매칭_검토필요: 0,
  };
  let eligible = 0;
  let parallelEligible = 0;
  let primaryBlocked = 0;

  for (const cl of classifications) {
    if (cl.scopeClassification in scope) scope[cl.scopeClassification] += 1;
    if (cl.eligibleForStatusAggregation) eligible += 1;
    if (cl.eligibleForParallelStateUpdate) parallelEligible += 1;

    if (cl.scopeClassification !== "PRIMARY_DIRECT_UNION") continue;
    if (cl.eligibleForStatusAggregation) continue;
    primaryBlocked += 1;

    const annotations = cl.annotations ?? {};
    if (!annotations.agreementType?.code) blockingTerms.협약유형_미확인 += 1;
    if (annotations.impasseReason) blockingTerms.조정교착_기사 += 1;
    if (annotations.ratification) blockingTerms.인준가결_기사 += 1;
    if (annotations.originalUrlStatus === "AGGREGATOR_ONLY") blockingTerms.원문URL_없음 += 1;
    if ((cl.reasonCodes ?? []).includes("multiple_companies")) blockingTerms.복수법인 += 1;
    if ((cl.companies ?? []).some((company) => company.needsReview)) {
      blockingTerms.법인매칭_검토필요 += 1;
    }
  }

  return { total, scope, eligible, parallelEligible, primaryBlocked, blockingTerms };
}

function formatPercent(count, total) {
  return total > 0 ? `${((count / total) * 100).toFixed(1)}%` : "-";
}

export function formatSummary(summary) {
  const lines = [];
  const { total } = summary;
  lines.push(`후보 기사: ${total}건`);
  lines.push("");
  lines.push("■ 범위 판정");
  for (const [name, count] of Object.entries(summary.scope)) {
    if (count === 0) continue;
    lines.push(`  ${name}: ${count}건 (${formatPercent(count, total)})`);
  }
  lines.push("");
  lines.push("■ 반영 가능성");
  lines.push(`  주 단계 변경 가능: ${summary.eligible}건 (${formatPercent(summary.eligible, total)})`);
  lines.push(
    `  병렬 상태만 갱신 가능: ${summary.parallelEligible}건 (${formatPercent(summary.parallelEligible, total)})`,
  );
  lines.push("");
  lines.push(`■ 직영으로 판정됐지만 막힌 ${summary.primaryBlocked}건의 차단 사유`);
  for (const [name, count] of Object.entries(summary.blockingTerms)) {
    if (count === 0) continue;
    lines.push(`  ${name.replaceAll("_", " ")}: ${count}건`);
  }
  return lines.join("\n");
}

async function main() {
  const config = JSON.parse(await readFile(new URL("data/source-config.json", root), "utf8"));
  validateConfiguration(config);

  const batch = JSON.parse(
    await readFile(new URL("public/data/news-candidates.json", root), "utf8"),
  );
  const articles = batch.articles ?? [];
  if (articles.length === 0) {
    console.log("측정할 후보가 없습니다. 먼저 수집기를 한 번 실행하세요.");
    return;
  }

  // 저장된 후보를 수집 당시 레코드 모양으로 되돌린다. 원문 검증 상태를 유지해야
  // 원문 URL 게이트가 운영과 같게 동작한다.
  const now = new Date();
  const classifications = articles.map((article) => {
    const record = {
      title: article.title,
      media: article.media,
      publishedAt: article.publishedAt,
      url: article.url,
      originalUrl: article.originalUrl,
      collectionSources: article.classification?.collectionSources ?? ["google-news-rss"],
      originCompanyIds: (article.classification?.companies ?? []).map((c) => c.companyId),
      ...(article.sourceVerification ? { sourceVerification: article.sourceVerification } : {}),
    };
    return classifyArticle(record, config, now, batch.batch?.targetYear ?? now.getFullYear())
      .classification;
  });

  const summary = summarize(classifications);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`기준 배치: ${batch.batch?.kstDate ?? "확인 불가"} · 주 수집원: ${batch.batch?.primarySource ?? "확인 불가"}`);
  console.log("");
  console.log(formatSummary(summary));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}

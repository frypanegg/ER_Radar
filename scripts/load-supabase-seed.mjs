#!/usr/bin/env node
// 검증된 공개 시드를 Supabase에 적재한다.
//
// 화면은 아직 정적 JSON을 읽는다. 이 스크립트는 같은 사실을 DB에 넣어, 과거 교섭의
// 단계별 경과를 누적 관리할 수 있게 만드는 첫 단계다. 순서는 법인 → 교섭 사건 →
// 사건별 경과이며, 자연키로 멱등하게 올린다.
//
// 안전 경계
//  - service_role 키는 RLS를 우회한다. 서버·로컬에서만 쓰고 절대 클라이언트에 두지 않는다.
//  - 공개 대상은 PRIMARY_DIRECT_UNION이고 includeInPrimaryDashboard인 레코드뿐이다.
//  - --dry-run은 네트워크를 쓰지 않고 payload만 검증한다. 실제 적재 전에 이걸로 확인한다.

import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

const BARGAINING_LEVEL = "ENTERPRISE";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경 변수가 필요합니다.`);
  return value;
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
}

/** 공개 가능한 레코드만 남긴다. 게이트는 화면·수집기와 같은 기준이다. */
export function publishableRecords(records) {
  return records.filter(
    (record) =>
      record.scopeClassification === "PRIMARY_DIRECT_UNION" &&
      record.includeInPrimaryDashboard === true &&
      record.coveredWorkerRelation !== "SUBCONTRACTOR_OR_NON_DIRECT",
  );
}

export function buildCompanyRows(trackingCompanies) {
  return trackingCompanies.map((company) => ({
    slug: company.id,
    legal_name: company.legalName,
    display_name: company.legalName.replace(/\s*주식회사\s*/g, " ").trim(),
    industry: company.industry,
    coverage_tier: company.tier,
  }));
}

export function buildCaseRow(record, companyIdBySlug) {
  const companyId = companyIdBySlug.get(record.companyId);
  const employerId = companyIdBySlug.get(record.directEmployerId ?? record.companyId);
  if (!companyId || !employerId) {
    throw new Error(`법인 식별자를 찾지 못했습니다: ${record.companyId}`);
  }
  return {
    company_id: companyId,
    direct_employer_company_id: employerId,
    bargaining_year: record.bargainingYear,
    agreement_type: record.agreementType,
    bargaining_level: BARGAINING_LEVEL,
    bargaining_unit_key: `${record.companyId}:${record.bargainingYear}:${record.agreementType}`,
    bargaining_unit_name: record.unionName,
    covered_worker_scope_key: "DIRECT_EMPLOYEES",
    covered_worker_scope_name: "해당 법인 직접고용 근로자",
    covered_worker_relation: "DIRECT",
    scope_classification: "PRIMARY_DIRECT_UNION",
  };
}

/**
 * 레코드 하나에서 사건 목록을 만든다. flowEvents가 있으면 그대로 쓰고, 없으면 결과
 * 한 컷만 사건으로 남긴다. 과거 기록의 빈 경과를 억지로 채우지 않는다.
 */
export function buildEventRows(record, ids) {
  const events = (record.flowEvents ?? []).length > 0
    ? record.flowEvents.map((event) => ({
        event_type: "STAGE_CONFIRMED",
        stage_after: event.stage,
        occurred_on: event.date,
        fact_summary: event.summary,
        source_url: event.sourceUrl ?? record.sourceUrl,
      }))
    : [{
        event_type: "RESULT_ONLY",
        stage_after: record.stage,
        occurred_on: record.eventDate,
        fact_summary: record.factSummary,
        source_url: record.sourceUrl,
      }];

  return events.map((event) => ({
    bargaining_case_id: ids.caseId,
    company_id: ids.companyId,
    direct_employer_company_id: ids.employerId,
    event_type: event.event_type,
    stage_after: event.stage_after,
    occurred_on: event.occurred_on,
    fact_summary: event.fact_summary,
    scope_classification: "PRIMARY_DIRECT_UNION",
    covered_worker_relation: "DIRECT",
    // 같은 사건을 두 번 넣지 않기 위한 자연키. 재실행해도 결과가 같아야 한다.
    dedupe_key: `${record.recordId ?? record.id}|${event.stage_after}|${event.occurred_on}|${event.source_url}`,
  }));
}

export function buildSourceRow(record) {
  return {
    original_url: record.sourceUrl,
    publisher_name: record.sourceName,
    source_type: "NEWS_ARTICLE",
    source_tier: record.sourceTier,
  };
}

async function postRows(baseUrl, key, table, rows, conflictTarget) {
  if (rows.length === 0) return [];
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/rest/v1/${table}`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      prefer: `return=representation,resolution=merge-duplicates`,
      ...(conflictTarget ? { "on-conflict": conflictTarget } : {}),
    },
    body: JSON.stringify(rows),
  });
  if (!response.ok) {
    throw new Error(`${table} 적재 실패 (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  return response.json();
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const [historical, current] = await Promise.all([
    readJson("data/historical-fact-seed.json"),
    readJson("data/current-2026-fact-seed.json"),
  ]);
  const records = publishableRecords([...historical.records, ...current.records]);
  const companyRows = buildCompanyRows(historical.trackingCompanies);

  console.log(`법인 ${companyRows.length}건 · 공개 가능 교섭 기록 ${records.length}건`);
  const timelineCount = records.filter((record) => (record.flowEvents ?? []).length > 0).length;
  console.log(`단계별 경과 보유 ${timelineCount}건 · 결과만 확인 ${records.length - timelineCount}건`);

  if (dryRun) {
    // 네트워크 없이 payload 형태만 확인한다. 법인 식별자는 가짜 uuid로 대체한다.
    const fake = new Map(companyRows.map((row, index) => [row.slug, `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`]));
    let eventTotal = 0;
    for (const record of records) {
      const caseRow = buildCaseRow(record, fake);
      const eventRows = buildEventRows(record, {
        caseId: "00000000-0000-4000-8000-000000000000",
        companyId: caseRow.company_id,
        employerId: caseRow.direct_employer_company_id,
      });
      buildSourceRow(record);
      eventTotal += eventRows.length;
    }
    console.log(`검증 통과 · 생성될 사건 행 ${eventTotal}건`);
    console.log("실제 적재는 SUPABASE_URL·SUPABASE_SERVICE_ROLE_KEY를 설정한 뒤 --dry-run 없이 실행한다.");
    return;
  }

  const baseUrl = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const insertedCompanies = await postRows(baseUrl, key, "tracked_companies", companyRows, "slug");
  const companyIdBySlug = new Map(insertedCompanies.map((row) => [row.slug, row.id]));

  let eventTotal = 0;
  for (const record of records) {
    const caseRow = buildCaseRow(record, companyIdBySlug);
    const [insertedCase] = await postRows(
      baseUrl,
      key,
      "bargaining_cases",
      [caseRow],
      "bargaining_unit_key",
    );
    await postRows(baseUrl, key, "sources", [buildSourceRow(record)], "original_url");
    const eventRows = buildEventRows(record, {
      caseId: insertedCase.id,
      companyId: caseRow.company_id,
      employerId: caseRow.direct_employer_company_id,
    });
    await postRows(baseUrl, key, "bargaining_events", eventRows, "dedupe_key");
    eventTotal += eventRows.length;
  }

  console.log(`적재 완료 · 교섭 사건 ${records.length}건 · 경과 행 ${eventTotal}건`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    await main();
  } catch (error) {
    // 설정 누락은 사용자가 고칠 문제다. 스택 트레이스 대신 무엇이 없는지만 알린다.
    console.error(error instanceof Error ? error.message : String(error));
    console.error("먼저 node scripts/load-supabase-seed.mjs --dry-run 으로 payload를 확인하세요.");
    process.exitCode = 1;
  }
}

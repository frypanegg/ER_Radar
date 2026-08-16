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

// 시드의 관찰군 표기와 스키마의 허용값이 다르다. 여기서만 옮긴다.
const COVERAGE_TIER_BY_SEED_TIER = { T1: "CORE", T2: "EXPANDED", T3: "WATCH" };

/**
 * 사람이 검증한 사실만 공개 상태로 올린다. 제목 기반 자동 수집 기록은 같은 등급이
 * 아니므로 검토 대기로 넣고 공개하지 않는다.
 */
function publicationState(record) {
  const verified = record.factualStatus === "VERIFIED_SOURCE";
  return {
    // 스키마의 공개 CHECK는 include_in_primary_dashboard까지 함께 켜져 있어야 통과한다.
    // 원청 직접고용 게이트를 DB에서 한 번 더 확인하는 구조다.
    include_in_primary_dashboard: true,
    verification_status: verified ? "VERIFIED" : "NEEDS_REVIEW",
    is_published: verified,
  };
}

// 주 단계에서 사건 상태를 옮긴다. 체결은 합의, 이행은 이행 중, 나머지는 진행 중이다.
const CASE_STATUS_BY_STAGE = { S7: "AGREED" };

/**
 * 같은 값이 환경에 따라 다른 이름으로 들어온다. 수집기가 NAVER 자격증명에서 쓰는 방식과
 * 같이 별칭을 허용해, 운영자가 파일의 키 이름을 바꾸지 않아도 되게 한다.
 */
function requireEnv(names) {
  const candidates = Array.isArray(names) ? names : [names];
  for (const name of candidates) {
    const value = process.env[name];
    if (value) return value.trim();
  }
  throw new Error(`${candidates.join(" 또는 ")} 환경 변수가 필요합니다.`);
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
    coverage_tier: COVERAGE_TIER_BY_SEED_TIER[company.tier] ?? "WATCH",
    // 추적 목록의 12개 법인은 사람이 확정한 대상이다.
    verification_status: "VERIFIED",
    is_published: true,
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
    primary_stage: record.stage,
    stage_observed_at: `${record.eventDate}T00:00:00Z`,
    case_status: CASE_STATUS_BY_STAGE[record.stage] ?? "OPEN",
    current_fact_summary: record.factSummary,
    latest_event_on: record.eventDate,
    scope_evidence_url: record.scopeEvidenceUrl ?? null,
    scope_evidence_summary: record.directEmploymentEvidence ?? null,
    scope_review_rule_version: record.scopeRuleVersion ?? null,
    source_tier: record.sourceTier,
    confidence_score: record.confidence,
    ...publicationState(record),
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
    source_tier: record.sourceTier,
    ...publicationState(record),
    // 같은 사건을 두 번 넣지 않기 위한 자연키. 재실행해도 결과가 같아야 한다.
    dedupe_key: `${record.recordId ?? record.id}|${event.stage_after}|${event.occurred_on}|${event.source_url}`,
  }));
}

/**
 * 출처를 교섭 사건에 연결하는 주석 행. anon의 sources 정책이 이 연결의 존재를 요구하므로,
 * 이걸 만들지 않으면 익명 사용자에게 출처가 하나도 보이지 않는다. 정확히 하나의 대상만
 * 지정해야 한다는 CHECK가 있어 bargaining_case_id만 채운다.
 */
export function buildSourceAnnotationRow(record, sourceId, caseId) {
  const verified = record.factualStatus === "VERIFIED_SOURCE";
  return {
    source_id: sourceId,
    bargaining_case_id: caseId,
    annotation_type: "FACT",
    annotation_field: "stage",
    // 기사 본문을 복제하지 않는다. 무엇을 확인했는지만 한 줄로 남긴다.
    fact_note: `${record.sourceName} 보도 기준 ${record.stage} 확인 · ${record.eventDate}`,
    is_published: verified,
    verification_status: verified ? "VERIFIED" : "NEEDS_REVIEW",
    confidence_score: record.confidence,
    verified_at: verified ? `${record.eventDate}T00:00:00Z` : null,
  };
}

export function buildSourceRow(record) {
  return {
    original_url: record.sourceUrl,
    publisher_name: record.sourceName,
    // 스키마가 허용하는 값은 OFFICIAL_EMPLOYER·OFFICIAL_UNION·PUBLIC_AGENCY·
    // COURT_OR_COMMISSION·NEWS·OTHER다. 시드의 근거는 대부분 언론 보도다.
    source_type: "NEWS",
    headline: record.title,
    source_published_at: `${record.eventDate}T00:00:00Z`,
    source_tier: record.sourceTier,
    confidence_score: record.confidence,
    verification_status: record.factualStatus === "VERIFIED_SOURCE" ? "VERIFIED" : "NEEDS_REVIEW",
    is_published: record.factualStatus === "VERIFIED_SOURCE",
  };
}

/**
 * source_annotations에는 유니크 제약이 없어 업서트를 걸 수 없다. 스키마를 다시 바꾸게 하는
 * 대신, 같은 연결이 이미 있으면 건너뛴다. 재실행해도 중복이 쌓이지 않아야 한다.
 */
async function ensureAnnotation(baseUrl, key, row) {
  const query =
    `${baseUrl.replace(/\/$/, "")}/rest/v1/source_annotations` +
    `?select=id&source_id=eq.${row.source_id}&bargaining_case_id=eq.${row.bargaining_case_id}&limit=1`;
  const existing = await fetch(query, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (existing.ok) {
    const rows = await existing.json();
    if (Array.isArray(rows) && rows.length > 0) return 0;
  }
  const inserted = await postRows(baseUrl, key, "source_annotations", [row]);
  return inserted.length;
}

async function postRows(baseUrl, key, table, rows, conflictTarget) {
  if (rows.length === 0) return [];
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/rest/v1/${table}`);
  // PostgREST는 업서트 충돌 대상을 쿼리 파라미터로 받는다. 헤더로 보내면 무시되고
  // 중복 키 오류가 난다. 재실행 가능성이 이 파라미터에 달려 있다.
  if (conflictTarget) url.searchParams.set("on_conflict", conflictTarget);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      prefer: "return=representation,resolution=merge-duplicates",
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

  const baseUrl = requireEnv(["SUPABASE_URL", "SUPABASE_PJT_URL", "SUPABASE_PROJECT_URL"]);
  const key = requireEnv(["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"]);

  const insertedCompanies = await postRows(baseUrl, key, "tracked_companies", companyRows, "slug");
  const companyIdBySlug = new Map(insertedCompanies.map((row) => [row.slug, row.id]));

  let eventTotal = 0;
  let annotationTotal = 0;
  for (const record of records) {
    const caseRow = buildCaseRow(record, companyIdBySlug);
    const [insertedCase] = await postRows(
      baseUrl,
      key,
      "bargaining_cases",
      [caseRow],
      "company_id,bargaining_year,agreement_type,bargaining_unit_key,covered_worker_scope_key",
    );
    const [insertedSource] = await postRows(
      baseUrl,
      key,
      "sources",
      [buildSourceRow(record)],
      "original_url",
    );
    const eventRows = buildEventRows(record, {
      caseId: insertedCase.id,
      companyId: caseRow.company_id,
      employerId: caseRow.direct_employer_company_id,
    });
    await postRows(baseUrl, key, "bargaining_events", eventRows, "bargaining_case_id,dedupe_key");
    eventTotal += eventRows.length;

    // 출처를 사건에 연결한다. 이 연결이 없으면 anon에게 출처가 보이지 않는다.
    if (insertedSource?.id) {
      annotationTotal += await ensureAnnotation(
        baseUrl,
        key,
        buildSourceAnnotationRow(record, insertedSource.id, insertedCase.id),
      );
    }
  }

  console.log(`적재 완료 · 교섭 사건 ${records.length}건 · 경과 행 ${eventTotal}건 · 출처 주석 ${annotationTotal}건`);
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

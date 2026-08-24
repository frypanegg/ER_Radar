#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CURRENT_YEAR = 2026;
const REQUIRED_FIELDS = [
  "companyId",
  "companyLegalName",
  "bargainingYear",
  "agreementType",
  "stage",
  "eventDate",
  "title",
  "factSummary",
  "unionName",
  "directEmployerId",
  "coveredWorkerRelation",
  "directEmploymentEvidence",
  "sourceUrl",
  "sourceName",
  "sourceTier",
  "confidence",
  "scopeClassification",
  "includeInPrimaryDashboard",
  "annotation",
  "flowEvents",
];
const STAGE_CODES = new Set(["U", "S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
const AGREEMENT_TYPES = new Set(["WAGE", "CBA", "INTEGRATED", "SUPPLEMENTAL"]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(path) {
  return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function validDate(value) {
  return /^2026-\d{2}-\d{2}$/.test(value);
}

/**
 * 협약유형이 그 레코드의 근거로 뒷받침되는지 판정한다.
 *
 * 협약유형은 화면 필터의 축인데 지금까지 근거 검증 없이 값만 채워져 있었다. 실제로
 * 현대모비스는 근거 제목이 "2026년 단체교섭 5차 본교섭"뿐인데 통합 임단협으로 기록돼
 * 있었다. "단체교섭"은 교섭 일반을 가리키는 포괄 표현이므로 임금 포함 여부를 증명하지
 * 못한다.
 *
 * 판정은 제목·요약 텍스트만 본다. 새 사실을 만들지 않고, 근거가 없으면 없다고 말한다.
 *
 * 보는 텍스트는 "유형을 정한 근거"이지 "가장 최근 기사"가 아니다. 협약유형은 그 해
 * 교섭 라운드의 성격이라 한 번 정해지면 바뀌지 않는데, 레코드의 title·factSummary는
 * 일일 수집이 새 기사로 매일 덮어쓴다. 진행 기사 제목은 유형을 다시 말해 주지 않는다.
 * 실제로 2026-08-15에 현대자동차 임금협상 레코드가 "현대차 노사, 한 달여 만에 교섭
 * 재개"라는 제목으로 갱신되면서 임금 근거가 사라졌고, 그 하나 때문에 그날 수집분
 * 전체가 되돌려졌다. 그래서 유형을 정한 시점의 문장을 agreementTypeEvidence에 고정해
 * 두고, 있으면 그것을 본다. 없는 레코드(사람이 쓴 기존 시드)는 제목·요약으로 본다.
 */
export function assessAgreementTypeEvidence(record) {
  const evidence =
    record.agreementTypeEvidence ?? `${record.title ?? ""} ${record.factSummary ?? ""}`;
  const hasWageTerm = /임금\s*(?:협약|협상|교섭|인상)/.test(evidence);
  const hasCollectiveTerm = /단체\s*(?:협약|교섭)/.test(evidence);
  const hasIntegrated =
    /임금\s*[·]?\s*단체|임단협|임금\s*및\s*단체/.test(evidence) ||
    // "2024년 단체교섭·임금협상 잠정합의안"처럼 두 축이 따로 적힌 경우도 통합 교섭이다.
    (hasWageTerm && hasCollectiveTerm);
  const hasWageOnly = hasWageTerm;
  const hasCollectiveAgreement = /단체\s*협약/.test(evidence);
  // "단체교섭"은 임금·단체를 모두 포괄할 수 있어 단독으로는 유형을 특정하지 못한다.
  const hasGenericBargainingOnly =
    /단체\s*교섭/.test(evidence) && !hasIntegrated && !hasCollectiveAgreement && !hasWageOnly;

  const supported = {
    INTEGRATED: hasIntegrated,
    WAGE: hasWageOnly && !hasIntegrated,
    CBA: hasCollectiveAgreement && !hasIntegrated,
    SUPPLEMENTAL: /보충\s*협약|특별\s*협약/.test(evidence),
  }[record.agreementType] ?? false;

  return {
    supported,
    reason: supported
      ? "evidence_matches_declared_type"
      : hasGenericBargainingOnly
        ? "generic_collective_bargaining_term_only"
        : "no_agreement_type_signal_in_evidence",
  };
}

export function validateCurrentRecord(record, index, companyIds) {
  for (const field of REQUIRED_FIELDS) {
    assert(record[field] !== undefined && record[field] !== null && record[field] !== "", `records[${index}]에 ${field}가 필요합니다.`);
  }
  assert(companyIds.has(record.companyId), `records[${index}]의 알 수 없는 법인 ID: ${record.companyId}`);
  assert(record.bargainingYear === CURRENT_YEAR, `records[${index}]의 bargainingYear는 ${CURRENT_YEAR}이어야 합니다.`);
  assert(AGREEMENT_TYPES.has(record.agreementType), `records[${index}]의 agreementType이 허용되지 않습니다.`);
  assert(STAGE_CODES.has(record.stage) && record.stage !== "U", `records[${index}]의 stage는 확인된 U 이외 단계여야 합니다.`);
  assert(validDate(record.eventDate), `records[${index}]의 eventDate는 2026년 YYYY-MM-DD여야 합니다.`);
  assert(isHttpUrl(record.sourceUrl) && !record.sourceUrl.includes("example.invalid"), `records[${index}]의 sourceUrl은 실제 HTTP(S) 원문이어야 합니다.`);
  assert(record.scopeClassification === "PRIMARY_DIRECT_UNION", `records[${index}]는 원청 직접고용 노조 교섭만 포함할 수 있습니다.`);
  assert(record.includeInPrimaryDashboard === true, `records[${index}]는 공개 대시보드 포함 플래그가 true여야 합니다.`);
  assert(record.directEmployerId === record.companyId, `records[${index}]의 직접사용자 법인 ID가 대상 법인과 일치해야 합니다.`);
  assert(record.coveredWorkerRelation === "DIRECT", `records[${index}]의 적용 근로자 관계는 DIRECT여야 합니다.`);
  assert(typeof record.directEmploymentEvidence === "string" && record.directEmploymentEvidence.trim().length >= 12, `records[${index}]에는 직접고용 범위 근거가 필요합니다.`);
  // 고정된 협약유형 근거는 선택 항목이지만, 있다면 빈 문자열이어서는 안 된다.
  // 빈 값이 들어가면 제목·요약으로 되돌아가지 않고 근거가 없는 것으로 판정된다.
  assert(record.agreementTypeEvidence === undefined || (typeof record.agreementTypeEvidence === "string" && record.agreementTypeEvidence.trim()), `records[${index}]의 agreementTypeEvidence는 비어 있지 않은 문자열이어야 합니다.`);
  assert(Number.isFinite(record.confidence) && record.confidence >= 0 && record.confidence <= 1, `records[${index}]의 confidence는 0~1이어야 합니다.`);
  assert(Array.isArray(record.flowEvents) && record.flowEvents.length > 0, `records[${index}]에는 하나 이상의 교섭 경과가 필요합니다.`);

  record.flowEvents.forEach((flow, flowIndex) => {
    assert(validDate(flow.date), `records[${index}].flowEvents[${flowIndex}]의 date는 2026년 YYYY-MM-DD여야 합니다.`);
    assert(STAGE_CODES.has(flow.stage), `records[${index}].flowEvents[${flowIndex}]의 stage가 허용되지 않습니다.`);
    assert(typeof flow.label === "string" && flow.label.trim(), `records[${index}].flowEvents[${flowIndex}]의 label이 필요합니다.`);
    assert(typeof flow.summary === "string" && flow.summary.trim(), `records[${index}].flowEvents[${flowIndex}]의 summary가 필요합니다.`);
    assert(!flow.sourceUrl || isHttpUrl(flow.sourceUrl), `records[${index}].flowEvents[${flowIndex}]의 sourceUrl은 HTTP(S) URL이어야 합니다.`);
  });
}

function normalizeRecord(record) {
  return {
    ...record,
    id: record.id ?? `${record.companyId}:2026:${record.agreementType}:${record.eventDate}`,
    factualStatus: "VERIFIED_SOURCE",
    scopeRuleVersion: record.scopeRuleVersion ?? "1.1.0",
    originalUrl: record.sourceUrl,
    flowEvents: [...record.flowEvents].sort((left, right) => left.date.localeCompare(right.date)),
  };
}

export function buildCurrentSeed({ companyUniverse, groupResults, asOf }) {
  const trackingCompanies = companyUniverse.initialPublicTracking;
  const companyIds = new Set(trackingCompanies.map((company) => company.id));
  const candidates = groupResults.flatMap((group) => group.records ?? []);
  const records = candidates.filter((record) =>
    record.scopeClassification === "PRIMARY_DIRECT_UNION" && record.includeInPrimaryDashboard === true,
  );
  const withheld = groupResults.flatMap((group) => group.withheld ?? group.withheldRecords ?? []);
  const auditRecords = groupResults.flatMap((group) => group.auditRecords ?? []);

  records.forEach((record, index) => validateCurrentRecord(record, index, companyIds));

  const keys = new Set();
  for (const record of records) {
    const key = `${record.companyId}|${record.agreementType}|${record.eventDate}|${record.sourceUrl}`;
    assert(!keys.has(key), `중복된 2026년 교섭 기록입니다: ${key}`);
    keys.add(key);
  }

  const normalizedRecords = records
    .map(normalizeRecord)
    .sort((left, right) => right.eventDate.localeCompare(left.eventDate) || left.companyLegalName.localeCompare(right.companyLegalName, "ko-KR"));

  return {
    schemaVersion: 1,
    title: "추적 법인 2026년 교섭현황",
    locale: "ko-KR",
    asOf,
    coverageYear: CURRENT_YEAR,
    publicationPolicy: {
      primaryUnionScope: "원청 법인 직접고용 노조 교섭만 공개 데이터에 포함한다.",
      currentStatus: "최신 원문에서 발생 사실이 확인된 단계만 표시하고, 기사 없음은 미착수로 추정하지 않는다.",
      sourceDisclosure: "각 교섭 기록은 원문 URL, 직접고용 범위 근거, 기사로 확인된 교섭 경과를 보존한다.",
    },
    records: normalizedRecords,
    withheld,
    auditRecords,
    coverage: trackingCompanies.map((company) => ({
      companyId: company.id,
      companyLegalName: company.legalName,
      status: normalizedRecords.some((record) => record.companyId === company.id) ? "VERIFIED_CURRENT" : "WITHHELD_OR_UNVERIFIED",
    })),
    researchSummary: {
      trackedCompanyCount: trackingCompanies.length,
      publishedPrimaryDirectUnionRecords: normalizedRecords.length,
      withheldForScopeOrEvidenceReview: withheld.length,
      quarantinedIndirectOrMixedCandidates: auditRecords.length,
    },
  };
}

async function main() {
  const inputPaths = [
    "data/current-2026-group-a.json",
    "data/current-2026-group-b.json",
    "data/current-2026-group-c.json",
    "data/current-2026-group-d.json",
  ].map((path) => resolve(PROJECT_ROOT, path));
  const [companyUniverse, ...groupResults] = await Promise.all([
    readJson(resolve(PROJECT_ROOT, "data/company-universe.json")),
    ...inputPaths.map(readJson),
  ]);
  const seed = buildCurrentSeed({ companyUniverse, groupResults, asOf: "2026-08-10" });
  const outputPath = resolve(PROJECT_ROOT, "data/current-2026-fact-seed.json");
  await writeFile(outputPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
  console.log(`2026년 검증 교섭 기록 ${seed.records.length}건을 ${outputPath}에 기록했습니다.`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

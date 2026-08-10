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
const STAGE_CODES = new Set(["U", "S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]);
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
    title: "초기 추적 12개사 2026년 교섭현황",
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

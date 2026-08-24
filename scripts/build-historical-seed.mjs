#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const START_YEAR = 2021;
const END_YEAR = 2025;
const REQUIRED_RECORD_FIELDS = [
  "companyId",
  "companyLegalName",
  "bargainingYear",
  "agreementType",
  "stage",
  "eventDate",
  "title",
  "factSummary",
  "unionName",
  "directEmploymentEvidence",
  "sourceUrl",
  "sourceName",
  "sourceTier",
  "confidence",
  "scopeClassification",
  "includeInPrimaryDashboard",
  "annotation",
];

const STAGE_CODES = new Set(["U", "S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"]);

/** U는 좌표 미확인이라 가장 앞, S0~S7은 숫자 순서를 그대로 쓴다. */
function stageRank(stage) {
  if (!stage || stage === "U") return -1;
  const rank = Number.parseInt(stage.slice(1), 10);
  return Number.isFinite(rank) ? rank : -1;
}
const AGREEMENT_TYPES = new Set(["WAGE", "CBA", "INTEGRATED", "SUPPLEMENTAL"]);

function readArgs(argv) {
  const options = {
    inputPaths: [
      resolve(PROJECT_ROOT, "data/historical-research-group-a.json"),
      resolve(PROJECT_ROOT, "data/historical-research-group-b.json"),
      resolve(PROJECT_ROOT, "data/historical-research-group-c.json"),
    ],
    outputPath: resolve(PROJECT_ROOT, "data/historical-fact-seed.json"),
    asOf: "2026-08-10",
  };
  let customInputs = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      options.outputPath = resolve(process.cwd(), argv[index + 1] ?? "");
      index += 1;
    } else if (argument === "--as-of") {
      options.asOf = argv[index + 1] ?? options.asOf;
      index += 1;
    } else if (argument === "--input") {
      if (!customInputs) {
        options.inputPaths = [];
        customInputs = true;
      }
      options.inputPaths.push(resolve(process.cwd(), argv[index + 1] ?? ""));
      index += 1;
    } else if (argument !== "--help") {
      throw new Error(`알 수 없는 옵션입니다: ${argument}`);
    }
  }

  return options;
}

async function readJson(path) {
  return JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function validateHistoricalRecord(record, index, companyIds) {
  for (const field of REQUIRED_RECORD_FIELDS) {
    assert(record[field] !== undefined && record[field] !== null && record[field] !== "", `records[${index}]에 ${field}가 필요합니다.`);
  }
  assert(companyIds.has(record.companyId), `records[${index}]의 알 수 없는 회사 ID: ${record.companyId}`);
  assert(Number.isInteger(record.bargainingYear) && record.bargainingYear >= START_YEAR && record.bargainingYear <= END_YEAR, `records[${index}]의 bargainingYear는 ${START_YEAR}~${END_YEAR}여야 합니다.`);
  assert(AGREEMENT_TYPES.has(record.agreementType), `records[${index}]의 agreementType이 허용되지 않습니다.`);
  assert(STAGE_CODES.has(record.stage), `records[${index}]의 stage가 허용되지 않습니다.`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(record.eventDate), `records[${index}]의 eventDate는 YYYY-MM-DD여야 합니다.`);
  assert(isHttpUrl(record.sourceUrl), `records[${index}]의 sourceUrl은 실제 HTTP(S) URL이어야 합니다.`);
  assert(!record.sourceUrl.includes("example.invalid"), `records[${index}]의 예시 URL은 공개 초기 데이터에 사용할 수 없습니다.`);
  assert(record.scopeClassification === "PRIMARY_DIRECT_UNION", `records[${index}]는 원청 직접고용 사건만 포함할 수 있습니다.`);
  assert(record.includeInPrimaryDashboard === true, `records[${index}]는 대시보드 포함 플래그가 true여야 합니다.`);
  assert(record.directEmployerId === record.companyId, `records[${index}]의 직접사용자 법인 ID가 대상 법인과 일치해야 합니다.`);
  assert(Number.isFinite(record.confidence) && record.confidence >= 0 && record.confidence <= 1, `records[${index}]의 confidence는 0~1이어야 합니다.`);
}

function normalizeRecord(record) {
  return {
    ...record,
    id: record.recordId ?? record.id ?? `${record.companyId}:${record.bargainingYear}:${record.agreementType}:${record.eventDate}:${record.sourceUrl}`,
    factualStatus: "VERIFIED_SOURCE",
    scopeRuleVersion: record.scopeRuleVersion ?? "1.1.0",
    originalUrl: record.sourceUrl,
  };
}

function normalizeScopeContract(record) {
  if (
    record.scopeClassification === "PRIMARY_DIRECT_UNION" &&
    record.includeInPrimaryDashboard === true
  ) {
    return {
      ...record,
      // 과거 조사 초안이 명시적인 직접고용 판정만 남긴 경우에도, 판정 자체를
      // 바꾸지 않고 공통 계약 필드를 채워 후속 적재에서 같은 게이트를 적용한다.
      directEmployerId: record.directEmployerId ?? record.companyId,
      coveredWorkerRelation: record.coveredWorkerRelation ?? "DIRECT",
    };
  }
  return record;
}

export function buildSeed({ companyUniverse, groupResults, asOf }) {
  const trackedCompanies = companyUniverse.initialPublicTracking;
  const companyIds = new Set(trackedCompanies.map((company) => company.id));
  const allResearchRecords = groupResults
    .flatMap((result) => result.records ?? [])
    .map(normalizeScopeContract);
  const records = allResearchRecords.filter(
    (record) => record.scopeClassification === "PRIMARY_DIRECT_UNION" && record.includeInPrimaryDashboard === true,
  );
  const auditRecords = groupResults.flatMap((result) => result.auditRecords ?? []);

  assert(records.length > 0, "검증된 과거 사실 레코드가 없습니다.");
  records.forEach((record, index) => validateHistoricalRecord(record, index, companyIds));

  const uniqueRecordIds = new Set();
  for (const record of records) {
    const uniqueKey = `${record.companyId}|${record.bargainingYear}|${record.agreementType}|${record.eventDate}|${record.sourceUrl}`;
    assert(!uniqueRecordIds.has(uniqueKey), `중복된 과거 사실 레코드입니다: ${uniqueKey}`);
    uniqueRecordIds.add(uniqueKey);
  }

  const normalizedRecords = records
    .map(normalizeRecord)
    .sort((left, right) => right.eventDate.localeCompare(left.eventDate) || left.companyLegalName.localeCompare(right.companyLegalName, "ko-KR"));

  const coverage = trackedCompanies.map((company) => {
    const companyRecords = normalizedRecords.filter((record) => record.companyId === company.id);
    const verifiedYears = [...new Set(companyRecords.map((record) => record.bargainingYear))].sort();
    return {
      companyId: company.id,
      companyLegalName: company.legalName,
      verifiedYears,
      unverifiedYears: Array.from({ length: END_YEAR - START_YEAR + 1 }, (_, index) => START_YEAR + index).filter((year) => !verifiedYears.includes(year)),
      verifiedEventCount: companyRecords.length,
    };
  });

  return {
    schemaVersion: 1,
    title: "추적 법인 과거 교섭 사실 데이터",
    locale: "ko-KR",
    asOf,
    coveragePeriod: { startYear: START_YEAR, endYear: END_YEAR },
    publicationPolicy: {
      primaryUnionScope: "원청 법인 직접고용 노조 사건만 공개 데이터에 포함한다.",
      missingEvidence: "근거 미확인은 미착수나 타결로 추정하지 않고 미검증 연도로 남긴다.",
      sourceDisclosure: "각 사실 레코드는 원문 URL과 범위 검토 근거를 보존한다.",
    },
    trackingCompanies: trackedCompanies,
    records: normalizedRecords,
    researchSummary: {
      totalCompanyYearSlots: trackedCompanies.length * (END_YEAR - START_YEAR + 1),
      sourceRecordsReviewed: allResearchRecords.length,
      publishedPrimaryDirectUnionRecords: normalizedRecords.length,
      withheldForScopeOrEvidenceReview: coverage.reduce((sum, item) => sum + item.unverifiedYears.length, 0),
      quarantinedIndirectOrMixedCandidates: auditRecords.length,
    },
    coverage,
  };
}

/**
 * 과거 교섭의 단계별 경과를 시드 레코드에 병합한다.
 *
 * 과거 44건은 결과 한 컷만 확인된 상태로 출발했다. 상견례·본교섭·교착·조정·쟁의 일정은
 * 조사해서 채워야 하고, 채운 만큼만 화면에 나타나야 한다. 그래서 병합은 검증을 통과한
 * 사건만 받아들이고, 무엇이 비었는지 커버리지로 보고한다.
 */
export function mergeFlowEvents(records, flowEventInput) {
  const events = flowEventInput?.events ?? [];
  const byRecordId = new Map(records.map((record) => [record.recordId ?? record.id, record]));
  const problems = [];
  const grouped = new Map();

  events.forEach((event, index) => {
    const at = `events[${index}]`;
    const target = byRecordId.get(event.recordId);
    if (!target) {
      problems.push(`${at}: recordId '${event.recordId}'에 해당하는 과거 기록이 없습니다.`);
      return;
    }
    if (!STAGE_CODES.has(event.stage)) {
      problems.push(`${at}: stage '${event.stage}'는 허용되지 않습니다.`);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(event.date ?? "")) {
      problems.push(`${at}: date는 YYYY-MM-DD 형식이어야 합니다.`);
      return;
    }
    // 교섭연도보다 이른 사건은 다른 해의 교섭이다. 이듬해로 넘어가는 것은 이월이므로 허용한다.
    if (Number(event.date.slice(0, 4)) < target.bargainingYear) {
      problems.push(`${at}: ${event.date}는 교섭연도 ${target.bargainingYear}보다 이릅니다.`);
      return;
    }
    if (typeof event.sourceUrl !== "string" || !/^https?:\/\//.test(event.sourceUrl)) {
      problems.push(`${at}: 근거 원문 URL이 없습니다. 근거 없는 경과는 넣지 않습니다.`);
      return;
    }
    if (!event.label || !event.summary) {
      problems.push(`${at}: label과 summary가 모두 필요합니다.`);
      return;
    }

    const list = grouped.get(event.recordId) ?? [];
    // 같은 사건이 두 번 들어오면 하나만 남긴다. 한 기사가 상견례부터 조인까지 전체 일정을
    // 요약하는 경우가 많으므로, 원문 URL만으로 묶으면 그중 한 건만 남는다. 날짜·단계까지
    // 함께 봐야 같은 기사에서 여러 사건을 가져올 수 있다.
    const isSameEvent = (existing) =>
      existing.sourceUrl === event.sourceUrl &&
      existing.date === event.date &&
      existing.stage === event.stage;
    if (!list.some(isSameEvent)) {
      list.push({
        date: event.date,
        stage: event.stage,
        label: event.label,
        summary: event.summary,
        sourceUrl: event.sourceUrl,
      });
    }
    grouped.set(event.recordId, list);
  });

  if (problems.length > 0) {
    throw new Error(`과거 교섭 경과 입력이 규칙을 위반했습니다:\n- ${problems.join("\n- ")}`);
  }

  const merged = records.map((record) => {
    const key = record.recordId ?? record.id;
    const list = grouped.get(key);
    if (!list || list.length === 0) return record;
    return {
      ...record,
      // 같은 날 두 사건이 있으면 단계 순위로 가른다. 잠정합의 가결과 조인식이 같은 날
      // 이뤄지는 일이 흔하고, 그때는 뒤 단계가 나중 일이다.
      flowEvents: [...list].sort(
        (left, right) =>
          left.date.localeCompare(right.date) || stageRank(left.stage) - stageRank(right.stage),
      ),
    };
  });

  const withTimeline = merged.filter((record) => (record.flowEvents ?? []).length > 0).length;
  return {
    records: merged,
    coverage: {
      recordsWithTimeline: withTimeline,
      recordsResultOnly: merged.length - withTimeline,
      eventsMerged: events.length,
    },
  };
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  if (process.argv.includes("--help")) {
    console.log("사용법: node scripts/build-historical-seed.mjs [--as-of YYYY-MM-DD] [--output 경로] [--input 결과.json]");
    return;
  }

  const [companyUniverse, flowEventInput, ...groupResults] = await Promise.all([
    readJson(resolve(PROJECT_ROOT, "data/company-universe.json")),
    readJson(resolve(PROJECT_ROOT, "data/historical-flow-events.json")).catch(() => ({ events: [] })),
    ...options.inputPaths.map(readJson),
  ]);
  const seed = buildSeed({ companyUniverse, groupResults, asOf: options.asOf });

  const { records, coverage } = mergeFlowEvents(seed.records, flowEventInput);
  seed.records = records;
  seed.timelineCoverage = coverage;

  await writeFile(options.outputPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
  console.log(`초기 과거 사실 데이터 ${seed.records.length}건을 ${options.outputPath}에 기록했습니다.`);
  console.log(
    `단계별 경과: ${coverage.recordsWithTimeline}건 보유 · ${coverage.recordsResultOnly}건 결과만 확인 (병합한 사건 ${coverage.eventsMerged}건)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

// 일일 수집 결과 가운데 원문 URL까지 확인된 건만 공개 사실 시드에 반영한다.
//
// 이 스크립트는 새 법인을 만들지 않는다. 이미 원청 노조 범위 검토를 통과해 시드에
// 들어 있는 법인의 "사건 정보"(단계·일자·제목·원문)만 앞으로 민다. 노조명, 직접고용
// 범위 근거, 범위 증빙 URL은 기사 제목으로 추정할 수 없으므로 기존 값을 그대로 둔다.
//
// 반영 조건과 차단 사유는 모두 감사 로그에 남는다.

import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const CANDIDATES_PATH = resolve(PROJECT_ROOT, "public/data/news-candidates.json");
const SEED_PATH = resolve(PROJECT_ROOT, "data/current-2026-fact-seed.json");
const FRAMEWORK_PATH = resolve(PROJECT_ROOT, "data/negotiation-framework.json");
const AUDIT_PATH = resolve(PROJECT_ROOT, "data/daily-update-audit.json");
const RULE_VERSION = "1.0.0";
const MAX_AUDIT_RUNS = 60;

const HELP_TEXT = `
수집 결과를 공개 사실 시드에 반영

사용법:
  node scripts/apply-daily-update.mjs [옵션]

옵션:
  --dry-run           파일을 쓰지 않고 반영 계획만 출력
  --candidates <path> 수집 결과 JSON 경로
  --seed <path>       공개 사실 시드 JSON 경로
  --audit <path>      감사 로그 JSON 경로
  --help              도움말 출력

반영 조건:
  - 원청 노조 범위 검토 통과 (PRIMARY_DIRECT_UNION)
  - 원문 URL 확인 완료 (NAVER 직접 링크 또는 Google 링크 되돌리기 검증)
  - 상태 집계 후보 (eligibleForStatusAggregation)
  - 단일 법인 기사이고 주 단계가 U가 아님
  - 기존 기록보다 발생일이 늦음
`.trim();

function parseArguments(argv) {
  const options = {
    dryRun: false,
    help: false,
    candidatesPath: CANDIDATES_PATH,
    seedPath: SEED_PATH,
    auditPath: AUDIT_PATH,
  };
  const pathFlags = {
    "--candidates": "candidatesPath",
    "--seed": "seedPath",
    "--audit": "auditPath",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (pathFlags[argument]) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} 옵션에 값이 필요합니다.`);
      }
      options[pathFlags[argument]] = resolve(process.cwd(), value);
      index += 1;
    } else {
      throw new Error(`알 수 없는 옵션입니다: ${argument}`);
    }
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJsonAtomically(path, value) {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function kstDateKey(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function stageRanks(framework) {
  return new Map(
    framework.enums.primary_stage.map((stage) => [stage.code, stage.rank]),
  );
}

/**
 * 검증된 사실 기록을 추론 등급 기사로 되돌리지 않기 위한 게이트.
 * 체결·이행이 확인된 연도 기록은 같은 등급의 근거가 있을 때만 바뀐다.
 */
function blocksSettledRecord(existing, nextStage) {
  const settled = new Set(["S7", "S8"]);
  return (
    settled.has(existing.stage) &&
    existing.factualStatus === "VERIFIED_SOURCE" &&
    !settled.has(nextStage)
  );
}

/**
 * 단계를 뒤로 되돌리는 반영을 막는다.
 *
 * 파업·집회 기사는 교섭이 진행 중이라는 신호를 함께 담기 때문에, 이미 교착·조정(S4)로
 * 기록된 법인이 "노사 교섭 계속" 표현 하나로 본교섭(S3)으로 내려갈 수 있다. 실제로
 * 2026-08-11 후보에서 현대자동차가 그 경로에 걸렸다.
 *
 * 되돌림 자체가 틀린 것은 아니다. 잠정합의 부결이나 재교섭 결렬은 실제로 단계가
 * 내려간다. 그 경우들은 수집기가 예외 전이(exception_transition)나 명시적 교착·조정
 * 근거로 표시하므로, 그때만 허용한다.
 */
function blocksStageDowngrade(existing, article, ranks) {
  const nextStage = article.classification.statusCode;
  const currentRank = ranks.get(existing.stage);
  const nextRank = ranks.get(nextStage);
  if (typeof currentRank !== "number" || typeof nextRank !== "number") return false;
  if (nextRank >= currentRank) return false;

  const explicitDowngradeBasis = new Set([
    "exception_transition",
    "explicit_impasse_or_mediation",
    "explicit_state_signal",
  ]);
  return !explicitDowngradeBasis.has(article.classification.statusBasis);
}

function selectCandidate(article) {
  const classification = article.classification;
  if (!classification) return { ok: false, reason: "no_classification" };
  if (!classification.includeInPrimaryDashboard) {
    return { ok: false, reason: "scope_excluded" };
  }
  if (classification.scopeClassification !== "PRIMARY_DIRECT_UNION") {
    return { ok: false, reason: "scope_not_primary_direct_union" };
  }
  if (!classification.eligibleForStatusAggregation) {
    return { ok: false, reason: "not_eligible_for_status_aggregation" };
  }
  if (classification.requiresSourceVerification || !article.originalUrl) {
    return { ok: false, reason: "source_url_unverified" };
  }
  if (classification.companies.length !== 1) {
    return { ok: false, reason: "multiple_companies" };
  }
  if (classification.statusCode === "U") {
    return { ok: false, reason: "stage_unknown" };
  }
  if (classification.retainMainState) {
    return { ok: false, reason: "retain_main_state" };
  }
  return { ok: true, companyId: classification.companies[0].companyId };
}

function buildFlowEvent(article, eventDate) {
  return {
    date: eventDate,
    stage: article.classification.statusCode,
    label: article.classification.statusLabel ?? article.classification.statusName,
    // 기사 본문을 복제하지 않는다. 제목과 계산된 분류만 보존한다.
    summary: `${article.media} 보도 제목 기준 확인: ${article.title}`,
    sourceUrl: article.originalUrl,
  };
}

function applyArticleToRecord(record, article, eventDate) {
  const flowEvents = [...(record.flowEvents ?? [])];
  const alreadyRecorded = flowEvents.some(
    (event) => event.sourceUrl === article.originalUrl,
  );
  if (!alreadyRecorded) {
    flowEvents.push(buildFlowEvent(article, eventDate));
    flowEvents.sort((left, right) => left.date.localeCompare(right.date));
  }

  return {
    ...record,
    stage: article.classification.statusCode,
    eventDate,
    title: article.title,
    factSummary: `${article.media} 보도 제목 기준 ${
      article.classification.statusLabel ?? article.classification.statusName
    } 확인 · 원문 URL 검증 완료 · 본문 인용 없음`,
    sourceUrl: article.originalUrl,
    originalUrl: article.originalUrl,
    sourceName: article.media,
    sourceTier: article.classification.annotations?.sourceTier ?? "C",
    confidence: article.classification.confidence,
    annotation: `${kstDateKey(new Date())} 자동 수집 반영 · 제목 기반 분류 · 사람 검증 전 단계`,
    // 사람이 확인한 기록과 자동 수집 기록을 화면·감사에서 구분할 수 있게 남긴다.
    factualStatus: "AUTO_COLLECTED_TITLE_BASIS",
    autoUpdatedAt: new Date().toISOString(),
    flowEvents,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const [candidates, seed, framework] = await Promise.all([
    readJson(options.candidatesPath),
    readJson(options.seedPath),
    readJson(FRAMEWORK_PATH),
  ]);

  // 일부 쿼리가 실패한 partial 배치도 수집된 기사 자체는 유효하므로 반영을 허용한다.
  // 수집기가 한 번도 돌지 않은 not_collected 상태에서만 시드를 건드리지 않는다.
  const acceptedBatchStatuses = new Set(["complete", "partial"]);
  if (!acceptedBatchStatuses.has(candidates.batch?.status)) {
    console.log(
      `수집 배치 상태가 '${candidates.batch?.status ?? "unknown"}'입니다. 시드를 변경하지 않습니다.`,
    );
    return;
  }

  const ranks = stageRanks(framework);
  const recordsByCompany = new Map(
    seed.records.map((record) => [record.companyId, record]),
  );
  const applied = [];
  const skipped = [];

  // 법인별로 가장 최근 발행 기사 하나만 후보로 쓴다.
  const bestByCompany = new Map();
  for (const article of candidates.articles ?? []) {
    const selection = selectCandidate(article);
    if (!selection.ok) {
      skipped.push({
        title: article.title,
        url: article.originalUrl ?? article.url,
        reason: selection.reason,
      });
      continue;
    }
    const current = bestByCompany.get(selection.companyId);
    if (!current || Date.parse(article.publishedAt) > Date.parse(current.publishedAt)) {
      bestByCompany.set(selection.companyId, article);
    }
  }

  for (const [companyId, article] of bestByCompany) {
    const record = recordsByCompany.get(companyId);
    const eventDate = article.publishedAt.slice(0, 10);
    if (!record) {
      // 추적 목록에 없는 법인은 사람이 범위 검토를 거쳐 추가해야 한다.
      skipped.push({
        title: article.title,
        url: article.originalUrl,
        reason: "company_not_tracked",
      });
      continue;
    }
    if (eventDate <= record.eventDate) {
      skipped.push({
        title: article.title,
        url: article.originalUrl,
        reason: "not_newer_than_recorded_event",
      });
      continue;
    }
    const nextStage = article.classification.statusCode;
    if (!ranks.has(nextStage)) {
      skipped.push({
        title: article.title,
        url: article.originalUrl,
        reason: "unknown_stage_code",
      });
      continue;
    }
    if (blocksSettledRecord(record, nextStage)) {
      skipped.push({
        title: article.title,
        url: article.originalUrl,
        reason: "settled_record_needs_equal_grade_evidence",
      });
      continue;
    }
    if (blocksStageDowngrade(record, article, ranks)) {
      skipped.push({
        title: article.title,
        url: article.originalUrl,
        reason: "stage_downgrade_without_explicit_evidence",
      });
      continue;
    }

    const updated = applyArticleToRecord(record, article, eventDate);
    recordsByCompany.set(companyId, updated);
    applied.push({
      companyId,
      companyLegalName: record.companyLegalName,
      previousStage: record.stage,
      previousEventDate: record.eventDate,
      nextStage,
      nextEventDate: eventDate,
      sourceUrl: article.originalUrl,
      sourceName: article.media,
      confidence: article.classification.confidence,
    });
  }

  const runAt = new Date().toISOString();
  const runEntry = {
    runAt,
    kstDate: kstDateKey(new Date()),
    ruleVersion: RULE_VERSION,
    batchKstDate: candidates.batch?.kstDate ?? null,
    primarySource: candidates.batch?.primarySource ?? null,
    consideredArticles: (candidates.articles ?? []).length,
    appliedCount: applied.length,
    skippedCount: skipped.length,
    applied,
    // 차단 사유는 사유 코드별 건수로만 보존해 감사 로그가 무한히 커지지 않게 한다.
    skippedReasonCounts: skipped.reduce((counts, entry) => {
      counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
      return counts;
    }, {}),
  };

  console.log(
    `반영 ${applied.length}건 / 보류 ${skipped.length}건 (검토 기사 ${runEntry.consideredArticles}건)`,
  );
  for (const entry of applied) {
    console.log(
      `  ${entry.companyLegalName}: ${entry.previousStage}(${entry.previousEventDate}) → ${entry.nextStage}(${entry.nextEventDate}) ${entry.sourceUrl}`,
    );
  }
  for (const [reason, count] of Object.entries(runEntry.skippedReasonCounts)) {
    console.log(`  보류 ${reason}: ${count}건`);
  }

  if (options.dryRun) {
    console.log("--dry-run: 파일을 변경하지 않았습니다.");
    return;
  }

  const audit = await readJson(options.auditPath).catch(() => ({
    schemaVersion: 1,
    runs: [],
  }));
  audit.runs = [runEntry, ...(audit.runs ?? [])].slice(0, MAX_AUDIT_RUNS);
  await writeJsonAtomically(options.auditPath, audit);

  if (applied.length === 0) {
    console.log("반영할 사실 변경이 없어 시드를 그대로 둡니다.");
    return;
  }

  const nextSeed = {
    ...seed,
    asOf: kstDateKey(new Date()),
    records: seed.records.map(
      (record) => recordsByCompany.get(record.companyId) ?? record,
    ),
  };
  await writeJsonAtomically(options.seedPath, nextSeed);
  console.log(`시드 갱신 완료: ${options.seedPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`사실 반영 실패: ${error.message}`);
    process.exitCode = 1;
  });
}

export {
  applyArticleToRecord,
  blocksSettledRecord,
  blocksStageDowngrade,
  selectCandidate,
  stageRanks,
};

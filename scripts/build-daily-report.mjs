#!/usr/bin/env node
// 일일 수집 결과를 메일 한 통으로 만든다.
//
// 워크플로 로그를 열어보지 않아도 "오늘 수집이 됐는지, 무엇이 바뀌었는지"를 알 수
// 있어야 한다. 그래서 성공한 날뿐 아니라 실패한 날도, 그리고 수집이 아예 멈춘 날도
// 메일이 가도록 세 가지 모드를 만든다.
//
// 기사 본문은 담지 않는다. 제목·매체·발행일·원문 URL과 프로젝트가 계산한 분류만
// 쓴다(저장소의 수집 정책과 같은 경계).

import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

const STAGE_LABELS = {
  U: "미확인",
  S0: "준비 전",
  S1: "요구안 준비·확정",
  S2: "상견례·교섭 개시",
  S3: "본교섭 진행",
  S4: "교착·조정 경로",
  S5: "잠정합의",
  S6: "인준·서명 대기",
  S7: "최종 체결·발효",
  S8: "이행·분쟁",
};

function stageLabel(stage) {
  return stage ? `${stage} ${STAGE_LABELS[stage] ?? ""}`.trim() : "없음";
}

function formatCount(value) {
  return typeof value === "number" ? value.toLocaleString("ko-KR") : "확인 불가";
}

/**
 * 수집 결과 메일의 제목과 본문을 만든다. 파일·네트워크 접근이 없어 테스트에서
 * 그대로 호출한다.
 */
export function buildReport({
  mode = "daily",
  audit = null,
  batch = null,
  heartbeat = null,
  todayKstDate,
  runUrl = null,
  siteUrl = null,
  freshnessProblems = [],
}) {
  const lines = [];
  const run = audit?.runs?.[0] ?? null;
  const stats = batch?.stats ?? null;

  if (mode === "staleness") {
    const subject = `[노사교섭 레이더] 수집 지연 감지 · ${todayKstDate}`;
    lines.push("일일 수집이 예정대로 돌지 않았습니다.");
    lines.push("");
    for (const problem of freshnessProblems) lines.push(`- ${problem}`);
    lines.push("");
    lines.push(`마지막 실행(KST): ${heartbeat?.lastRunKstDate ?? "기록 없음"}`);
    lines.push(`마지막 실행 결과: ${heartbeat?.lastRunOutcome ?? "기록 없음"}`);
    lines.push("");
    lines.push("복구 방법");
    lines.push('  gh workflow run "일일 교섭현황 수집·반영" -f force=true');
    if (runUrl) lines.push(`\n감시 실행 로그: ${runUrl}`);
    return { subject, text: lines.join("\n") };
  }

  const failed = mode === "failure";
  const appliedCount = run?.appliedCount ?? 0;
  const subject = failed
    ? `[노사교섭 레이더] 수집 실패 · ${todayKstDate}`
    : `[노사교섭 레이더] ${todayKstDate} 수집 결과 · 반영 ${appliedCount}건`;

  if (failed) {
    lines.push("수집 또는 회귀 검증이 실패했습니다. 공개 데이터는 바뀌지 않았습니다.");
    lines.push("");
  }

  lines.push(`■ 오늘 요약 (${todayKstDate} KST)`);
  if (run) {
    lines.push(`  검토한 기사: ${formatCount(run.consideredArticles)}건`);
    lines.push(`  공개 시드 반영: ${formatCount(run.appliedCount)}건`);
    lines.push(`  보류: ${formatCount(run.skippedCount)}건`);
    lines.push(`  주 수집원: ${run.primarySource ?? "확인 불가"}`);
  } else {
    lines.push("  감사 기록이 없습니다. 수집이 시작되지 못했을 수 있습니다.");
  }

  if (appliedCount > 0) {
    // 감사 로그는 제목을 남기지 않는다. 같은 원문 URL을 가진 후보에서 제목을 찾아 붙인다.
    const titleByUrl = new Map(
      (batch?.articles ?? [])
        .filter((article) => article.originalUrl)
        .map((article) => [article.originalUrl, article.title]),
    );

    lines.push("");
    lines.push("■ 상태가 바뀐 교섭");
    for (const item of run.applied) {
      lines.push(`  · ${item.companyLegalName ?? item.companyId ?? "법인 미확인"}`);
      lines.push(`    단계: ${stageLabel(item.previousStage)} → ${stageLabel(item.nextStage)}`);
      if (item.nextEventDate) {
        lines.push(`    확인일: ${item.previousEventDate ?? "없음"} → ${item.nextEventDate}`);
      }
      const title = item.sourceUrl ? titleByUrl.get(item.sourceUrl) : null;
      if (title) lines.push(`    제목: ${title}`);
      if (item.sourceName) lines.push(`    매체: ${item.sourceName}`);
      if (typeof item.confidence === "number") lines.push(`    신뢰도: ${item.confidence}`);
      if (item.sourceUrl) lines.push(`    원문: ${item.sourceUrl}`);
      lines.push("");
    }
  } else if (!failed) {
    lines.push("");
    lines.push("■ 상태가 바뀐 교섭 없음");
    lines.push("  원문 확인과 원청 직접고용 범위 검토를 모두 통과한 새 사실이 없었습니다.");
    lines.push("  공개 화면의 단계는 그대로 유지됩니다(근거 없는 변경을 하지 않습니다).");
  }

  if (run?.skippedReasonCounts && Object.keys(run.skippedReasonCounts).length > 0) {
    lines.push("");
    lines.push("■ 보류 사유");
    for (const [reason, count] of Object.entries(run.skippedReasonCounts)) {
      lines.push(`  ${reason}: ${formatCount(count)}건`);
    }
  }

  if (stats) {
    lines.push("");
    lines.push("■ 수집 지표");
    lines.push(`  질의: ${formatCount(stats.totalQueries)}건 (실패 ${formatCount(stats.failedQueries)}건)`);
    lines.push(`  수신 기사: ${formatCount(stats.receivedItems)}건 → 중복·무관 제거 후 ${formatCount(stats.finalCandidates)}건`);
    if (stats.urlResolution) {
      const r = stats.urlResolution;
      lines.push(
        `  원문 URL 확인: 시도 ${formatCount(r.attempted)} · 검증 ${formatCount(r.verified)} · 실패 ${formatCount(r.failed)}`,
      );
    }
  }

  lines.push("");
  lines.push("■ 링크");
  if (siteUrl) lines.push(`  공개 대시보드: ${siteUrl}`);
  if (runUrl) lines.push(`  실행 로그: ${runUrl}`);
  lines.push("");
  lines.push("이 메일은 저장소에 이미 기록된 제목·매체·URL·분류만 담습니다. 기사 본문은 담지 않습니다.");

  return { subject, text: lines.join("\n") };
}

/** 한국어 제목이 깨지지 않도록 RFC 2047 encoded-word로 감싼다. */
export function encodeSubject(subject) {
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

/** curl이 그대로 업로드할 수 있는 RFC 5322 메시지를 만든다. */
export function buildMimeMessage({ from, to, subject, text, date = new Date() }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${date.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    // 줄바꿈·한글이 SMTP 경로에서 깨지지 않도록 본문도 base64로 보낸다.
    Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\n"),
    "",
  ].join("\r\n");
}

async function readJsonIfPresent(relativePath) {
  try {
    return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
  } catch {
    return null;
  }
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const mode = argValue("--mode", "daily");
  const outputPath = argValue("--out", "tmp/daily-report.eml");
  const from = argValue("--from", "");
  const to = argValue("--to", "");
  const runUrl = argValue("--run-url");
  const siteUrl = argValue("--site-url");
  const problems = argValue("--problems", "");

  const todayKstDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());

  const { subject, text } = buildReport({
    mode,
    audit: await readJsonIfPresent("data/daily-update-audit.json"),
    batch: await readJsonIfPresent("public/data/news-candidates.json"),
    heartbeat: await readJsonIfPresent("data/automation-heartbeat.json"),
    todayKstDate,
    runUrl,
    siteUrl,
    freshnessProblems: problems ? problems.split("\n").filter(Boolean) : [],
  });

  await writeFile(
    new URL(outputPath, root),
    buildMimeMessage({ from, to, subject, text }),
    "utf8",
  );

  console.log(`제목: ${subject}`);
  console.log(`수신: ${to}`);
  console.log(`본문 ${text.split("\n").length}줄 · ${outputPath}에 기록`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}

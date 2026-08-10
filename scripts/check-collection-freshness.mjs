#!/usr/bin/env node
// 일일 수집이 조용히 멈춘 상태를 실패로 드러낸다.
//
// 수집이 안 돌아도 워크플로 이력은 그냥 비어 있을 뿐이라 아무 신호가 없다.
// 2026-08-11 06:30 KST 예정분이 GitHub schedule 이벤트 유실로 실행되지 않았고,
// 그 사실을 사람이 화면을 보고 눈치챌 때까지 아무것도 알려주지 않았다.
//
// 저장소의 실행 흔적과, 선택적으로 공개 페이지까지 함께 확인한다. 둘을 같이 보는
// 이유는 수집이 성공해도 배포가 실패하면 공개 화면은 낡은 상태로 남기 때문이다.

import { readFile } from "node:fs/promises";

const HEARTBEAT_PATH = new URL("../data/automation-heartbeat.json", import.meta.url);

export function kstDate(instant) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(instant);
}

function dayDifference(fromKstDate, toKstDate) {
  const from = Date.parse(`${fromKstDate}T00:00:00Z`);
  const to = Date.parse(`${toKstDate}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/**
 * 실행 흔적과 공개 페이지의 신선도를 판정한다. 네트워크·파일 접근 없이 순수하게
 * 판단하므로 회귀 테스트에서 그대로 호출한다.
 */
export function evaluateFreshness({ heartbeat, todayKstDate, liveHtml = null }) {
  const problems = [];
  const lastRunKstDate = heartbeat?.lastRunKstDate ?? null;

  if (!lastRunKstDate) {
    problems.push("실행 흔적에 lastRunKstDate가 없습니다. 자동화가 한 번도 기록을 남기지 않았습니다.");
  } else {
    const lag = dayDifference(lastRunKstDate, todayKstDate);
    if (lag === null) {
      problems.push(`실행 흔적의 날짜를 해석할 수 없습니다: ${lastRunKstDate}`);
    } else if (lag > 0) {
      problems.push(
        `마지막 수집이 ${lastRunKstDate}입니다. 오늘(${todayKstDate}) 기준 ${lag}일 지연됐습니다.`,
      );
    }
  }

  if (heartbeat?.lastRunOutcome && heartbeat.lastRunOutcome !== "success") {
    problems.push(`마지막 실행 결과가 ${heartbeat.lastRunOutcome}입니다.`);
  }

  // 공개 페이지는 배포된 번들에 실행 흔적을 담고 있다. 저장소가 최신인데 페이지가
  // 낡았다면 수집이 아니라 배포가 끊긴 것이므로 구분해서 알린다.
  if (liveHtml !== null && lastRunKstDate) {
    if (!liveHtml.includes(lastRunKstDate)) {
      problems.push(
        `공개 페이지에 마지막 수집일(${lastRunKstDate})이 없습니다. 수집은 됐지만 배포가 반영되지 않았을 수 있습니다.`,
      );
    }
  }

  return { fresh: problems.length === 0, problems, lastRunKstDate, todayKstDate };
}

async function fetchLiveHtml(url) {
  try {
    const response = await fetch(url, { headers: { accept: "text/html" } });
    if (!response.ok) return { html: null, error: `HTTP ${response.status}` };
    return { html: await response.text(), error: null };
  } catch (error) {
    return { html: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const liveIndex = process.argv.indexOf("--live");
  const liveUrl = liveIndex >= 0 ? process.argv[liveIndex + 1] : null;

  const heartbeat = JSON.parse(await readFile(HEARTBEAT_PATH, "utf8"));
  const todayKstDate = kstDate(new Date());

  let liveHtml = null;
  if (liveUrl) {
    const { html, error } = await fetchLiveHtml(liveUrl);
    if (error) {
      // 공개 페이지 조회 실패 자체는 수집 신선도와 별개다. 경고로 남기고 판정은 계속한다.
      console.log(`::warning::공개 페이지를 확인하지 못했습니다(${liveUrl}): ${error}`);
    }
    liveHtml = html;
  }

  const result = evaluateFreshness({ heartbeat, todayKstDate, liveHtml });

  console.log(`오늘(KST): ${result.todayKstDate}`);
  console.log(`마지막 수집(KST): ${result.lastRunKstDate ?? "없음"}`);
  console.log(`마지막 실행 결과: ${heartbeat.lastRunOutcome ?? "없음"} · 트리거: ${heartbeat.lastRunTrigger ?? "없음"}`);

  if (result.fresh) {
    console.log("일일 수집이 최신입니다.");
    return;
  }

  for (const problem of result.problems) {
    console.log(`::error::${problem}`);
  }
  console.log(
    "복구: gh workflow run \"일일 교섭현황 수집·반영\" -f force=true 로 즉시 수집하고, " +
      "schedule 이벤트가 계속 유실되면 저장소 밖 트리거(Cloudflare Cron)로 옮긴다.",
  );
  process.exitCode = 1;
}

// 테스트에서 import할 때는 실행하지 않는다.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}

// 교섭 사건 하나의 "경과"를 기록에서 파생한다.
//
// 이 대시보드는 현재 상태만 보는 도구가 아니다. 한 해의 교섭이 상견례에서 조인까지
// 어떤 일정으로 흘렀는지, 교착·조정이 몇 번 있었는지, 쟁의가 어느 수준까지 갔는지를
// 같이 봐야 한다. 그리고 그 해에 체결되지 않았다면 이듬해까지 이어졌을 수 있다.
//
// 파생은 저장된 사실에서만 계산한다. 없는 경과를 만들어내지 않고, 확인되지 않은
// 이월을 확정으로 말하지 않는다.

export type FlowEvent = {
  date: string;
  stage: string;
  label: string;
  summary?: string;
  sourceUrl?: string;
};

export type IndustrialActionLevel =
  | "NONE"
  | "VOTE_ANNOUNCED"
  | "VOTE_PASSED"
  | "RIGHT_SECURED"
  | "PARTIAL_STRIKE"
  | "FULL_STRIKE";

const INDUSTRIAL_ACTION_ORDER: IndustrialActionLevel[] = [
  "NONE",
  "VOTE_ANNOUNCED",
  "VOTE_PASSED",
  "RIGHT_SECURED",
  "PARTIAL_STRIKE",
  "FULL_STRIKE",
];

export const INDUSTRIAL_ACTION_LABELS: Record<IndustrialActionLevel, string> = {
  NONE: "쟁의행위 확인 없음",
  VOTE_ANNOUNCED: "쟁의행위 투표 공고",
  VOTE_PASSED: "쟁의행위 찬반투표 가결",
  RIGHT_SECURED: "파업권 확보",
  PARTIAL_STRIKE: "부분파업",
  FULL_STRIKE: "전면파업",
};

/** 종결 상태. 이월은 근거가 있을 때만 확정으로 말한다. */
export type SettlementStatus = "SETTLED" | "CONTINUED_PAST_YEAR" | "SETTLEMENT_UNCONFIRMED";

export type CaseHistory = {
  timeline: FlowEvent[];
  hasTimeline: boolean;
  impasseCount: number;
  bargainingRoundCount: number;
  industrialActionLevel: IndustrialActionLevel;
  ratificationVote: string | null;
  laborBoard: string | null;
  settlement: {
    status: SettlementStatus;
    label: string;
    detail: string;
    spannedIntoYear: number | null;
  };
};

function textOf(record: HistoryInput) {
  return [record.factSummary, ...(record.flowEvents ?? []).map((event) => `${event.label} ${event.summary ?? ""}`)]
    .filter(Boolean)
    .join(" ");
}

function levelFromText(text: string): IndustrialActionLevel {
  let level: IndustrialActionLevel = "NONE";
  const raise = (candidate: IndustrialActionLevel) => {
    if (INDUSTRIAL_ACTION_ORDER.indexOf(candidate) > INDUSTRIAL_ACTION_ORDER.indexOf(level)) {
      level = candidate;
    }
  };
  if (/(?:쟁의행위|파업)\s*(?:찬반)?투표\s*공고|쟁의행위\s*투표\s*공고/.test(text)) raise("VOTE_ANNOUNCED");
  if (/(?:쟁의행위|파업)\s*찬반투표.{0,10}(?:가결|찬성)/.test(text)) raise("VOTE_PASSED");
  if (/(?:파업권|쟁의권)\s*(?:확보|획득)|조정\s*(?:불성립|중지)/.test(text)) raise("RIGHT_SECURED");
  if (/부분\s*파업|경고\s*파업|시한부\s*파업/.test(text)) raise("PARTIAL_STRIKE");
  if (/전면\s*파업|총파업/.test(text)) raise("FULL_STRIKE");
  return level;
}

/** 찬반투표율은 원문에 숫자가 있을 때만 표시한다. 추정하지 않는다. */
function ratificationVoteFromText(text: string): string | null {
  const match = text.match(/(\d{1,3}(?:\.\d)?)\s*%\s*(?:찬성|가결)|(?:찬성|가결)[^0-9]{0,12}(\d{1,3}(?:\.\d)?)\s*%/);
  if (!match) return null;
  const rate = match[1] ?? match[2];
  return rate ? `${rate}% 찬성` : null;
}

function laborBoardFromText(text: string): string | null {
  if (/조정\s*불성립/.test(text)) return "노동위원회 조정 불성립";
  if (/조정\s*중지/.test(text)) return "노동위원회 조정 중지";
  if (/조정\s*기간\s*연장/.test(text)) return "노동위원회 조정기간 연장";
  if (/(?:중노위|지노위|중앙노동위원회|지방노동위원회|노동위원회).{0,12}조정\s*신청/.test(text)) {
    return "노동위원회 조정 신청";
  }
  if (/(?:중노위|지노위|중앙노동위원회|노동위원회)/.test(text)) return "노동위원회 절차 확인";
  return null;
}

export type HistoryInput = {
  stage: string;
  eventDate: string;
  bargainingYear: number;
  factSummary?: string;
  flowEvents?: FlowEvent[];
};

/** U는 좌표 미확인이라 가장 앞, S0~S7은 숫자 순서를 그대로 쓴다. */
export function stageRankOf(stage: string) {
  if (!stage || stage === "U") return -1;
  const rank = Number.parseInt(stage.slice(1), 10);
  return Number.isFinite(rank) ? rank : -1;
}

/**
 * 같은 날 두 사건이 있으면 날짜만으로는 순서가 정해지지 않는다. 잠정합의 가결과 조인식이
 * 같은 날 이뤄지는 일이 흔하고(삼성전자 2025-03-05), 그때는 뒤 단계가 나중 일이다.
 * 날짜가 같으면 단계 순위로 가른다.
 */
export function compareEventsAscending(left: FlowEvent, right: FlowEvent) {
  return left.date.localeCompare(right.date) || stageRankOf(left.stage) - stageRankOf(right.stage);
}

export function deriveCaseHistory(record: HistoryInput): CaseHistory {
  const timeline = [...(record.flowEvents ?? [])].sort(compareEventsAscending);
  const text = textOf(record);
  const eventYear = Number.parseInt(record.eventDate.slice(0, 4), 10);
  const settled = record.stage === "S7";
  const spannedIntoYear =
    Number.isFinite(eventYear) && eventYear > record.bargainingYear ? eventYear : null;

  let settlement: CaseHistory["settlement"];
  if (settled) {
    settlement = {
      status: "SETTLED",
      label: spannedIntoYear ? `${spannedIntoYear}년에 체결` : "해당 연도에 체결",
      detail: spannedIntoYear
        ? `${record.bargainingYear}년 교섭이 ${spannedIntoYear}년까지 이어져 체결됐다.`
        : "조인·서명 근거가 확인된 교섭이다.",
      spannedIntoYear,
    };
  } else if (spannedIntoYear) {
    // 기록 자체가 이듬해 사건이므로 이월은 추정이 아니라 확인된 사실이다.
    settlement = {
      status: "CONTINUED_PAST_YEAR",
      label: `${spannedIntoYear}년까지 진행 확인`,
      detail: `${record.bargainingYear}년 교섭이 ${spannedIntoYear}년까지 이어졌고, 아직 조인·서명 근거는 확인되지 않았다.`,
      spannedIntoYear,
    };
  } else {
    settlement = {
      status: "SETTLEMENT_UNCONFIRMED",
      label: "체결 확인 못 함",
      detail:
        "조인·서명 근거를 확인하지 못했다. 이후 체결됐는지, 이듬해까지 교섭이 이어졌는지는 이 기록만으로 판단하지 않는다.",
      spannedIntoYear: null,
    };
  }

  return {
    timeline,
    hasTimeline: timeline.length > 0,
    impasseCount: timeline.filter((event) => event.stage === "S4").length,
    bargainingRoundCount: timeline.filter((event) => event.stage === "S3").length,
    industrialActionLevel: levelFromText(text),
    ratificationVote: ratificationVoteFromText(text),
    laborBoard: laborBoardFromText(text),
    settlement,
  };
}

/**
 * 경과에서 사람이 먼저 보는 항목만 골라 짧은 목록으로 만든다. 근거가 없는 항목은
 * 넣지 않는다. 빈 배열이면 화면이 "확인된 이슈 없음"을 표시한다.
 */
export function issueHighlights(history: CaseHistory): string[] {
  const items: string[] = [];
  if (history.impasseCount > 0) items.push(`교착·조정 ${history.impasseCount}회 확인`);
  if (history.industrialActionLevel !== "NONE") {
    items.push(`쟁의 최고 수준: ${INDUSTRIAL_ACTION_LABELS[history.industrialActionLevel]}`);
  }
  if (history.ratificationVote) items.push(`찬반투표 ${history.ratificationVote}`);
  if (history.laborBoard) items.push(history.laborBoard);
  if (history.bargainingRoundCount > 0) items.push(`본교섭 기록 ${history.bargainingRoundCount}회`);
  return items;
}

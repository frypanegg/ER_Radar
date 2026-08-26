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

/**
 * 단계 구간 하나. 같은 단계가 이어진 동안을 한 덩어리로 묶는다.
 */
export type StageSegment = {
  stage: string;
  /** 이 단계로 넘어온 날. 앞 구간의 끝이기도 하다. */
  startDate: string;
  /** 다음 단계로 넘어간 날. 마지막 구간은 기준일이 끝이다. */
  endDate: string;
  /** 구간 길이(일). 같은 날 전환한 구간도 차트에서 사라지지 않도록 최소 1이다. */
  days: number;
  /** 전체 기간에서 이 구간이 차지하는 비율(%). */
  share: number;
  /** 이 구간에 묶인 사건들. 근거 링크는 여기서 꺼낸다. */
  events: FlowEvent[];
  /** 지금 머무르는 구간인지. 화면의 "현재" 표시가 이 값을 쓴다. */
  isCurrent: boolean;
};

export type StageTimeline = {
  segments: StageSegment[];
  startDate: string;
  endDate: string;
  totalDays: number;
};

function daysBetween(from: string, to: string) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/**
 * 사건 목록을 단계 구간으로 접는다.
 *
 * 지금까지 상세 화면은 사건을 한 줄씩 그대로 나열했다. 같은 단계를 확인한 기사가
 * 며칠 간격으로 계속 들어오기 때문에 "본교섭 진행"만 다섯 줄씩 쌓였고, 정작 알고 싶은
 * 것 — 어느 단계에 얼마나 머물렀고 언제 넘어갔는지 — 은 그 사이에 묻혔다.
 *
 * 그래서 연속된 같은 단계를 한 구간으로 묶는다. 되돌아간 단계는 합치지 않고 새 구간을
 * 연다. 기아 2026년처럼 S3에서 S4로 갔다가 다시 S3으로 돌아온 교섭은 세 구간이 되고,
 * 그 왕복 자체가 읽혀야 하는 사실이다.
 *
 * asOf는 마지막 구간의 끝이다. 진행 중인 교섭은 오늘까지, 끝난 연도는 마지막 사건까지다.
 */
export function buildStageTimeline(
  events: FlowEvent[] | undefined,
  { asOf }: { asOf: string },
): StageTimeline | null {
  const sorted = [...(events ?? [])].sort(compareEventsAscending);
  if (sorted.length === 0) return null;

  const grouped: { stage: string; events: FlowEvent[] }[] = [];
  for (const event of sorted) {
    const last = grouped[grouped.length - 1];
    if (last && last.stage === event.stage) last.events.push(event);
    else grouped.push({ stage: event.stage, events: [event] });
  }

  const startDate = sorted[0].date;
  // 마지막 사건이 기준일보다 뒤일 수 있다. 그때는 사건 날짜가 끝이다. 기준일을 그냥
  // 믿으면 길이가 음수가 된다.
  const lastEventDate = sorted[sorted.length - 1].date;
  const endDate = asOf > lastEventDate ? asOf : lastEventDate;

  const bounds = grouped.map((group, index) => {
    const from = group.events[0].date;
    const to = index + 1 < grouped.length ? grouped[index + 1].events[0].date : endDate;
    return { ...group, from, to, days: Math.max(1, daysBetween(from, to)) };
  });

  const totalDays = bounds.reduce((sum, bound) => sum + bound.days, 0);

  return {
    segments: bounds.map((bound, index) => ({
      stage: bound.stage,
      startDate: bound.from,
      endDate: bound.to,
      days: bound.days,
      share: totalDays > 0 ? (bound.days / totalDays) * 100 : 0,
      events: bound.events,
      isCurrent: index === bounds.length - 1,
    })),
    startDate,
    endDate,
    totalDays: Math.max(1, daysBetween(startDate, endDate)),
  };
}

/**
 * 연도 겹쳐보기.
 *
 * 연도 칩은 화면을 갈아끼울 뿐이라 "작년 이맘때 대비 진도"를 볼 수 없었다. 같은 법인의
 * 여러 해를 같은 시간축 위에 겹치면 그 비교가 열린다. 이 대시보드가 다른 곳에서 얻을 수
 * 없는 것을 주는 자리다.
 *
 * 축은 교섭연도 1월 1일부터 이듬해 2월 말까지 14개월이다. 12개월로 끊으면 12월에 타결하는
 * 철도나 이듬해 2월에 타결하는 은행이 축 밖으로 밀려난다.
 */
const YEAR_TRACK_AXIS_DAYS = 425;

export type YearTrackPoint = {
  date: string;
  stage: string;
  label: string;
  /** 축 위의 위치(%). */
  offset: number;
};

export type YearTrack = {
  year: number;
  stage: string;
  agreementType: string;
  /** 잠정합의 이상이 확인된 날. 없으면 null. */
  settledOn: string | null;
  settledOffset: number | null;
  points: YearTrackPoint[];
  startOffset: number;
  endOffset: number;
};

export type YearTrackInput = {
  bargainingYear: number;
  agreementType: string;
  stage: string;
  eventDate: string;
  title: string;
  flowEvents?: FlowEvent[];
};

function axisOffset(year: number, date: string) {
  const days = daysBetween(`${year}-01-01`, date);
  return Math.min(100, Math.max(0, (days / YEAR_TRACK_AXIS_DAYS) * 100));
}

/** 잠정합의 이상으로 올라선 첫 사건. 대표 사건만 보면 경과에 남은 더 이른 타결을 놓친다. */
function findSettlement(record: YearTrackInput) {
  const settledEvent = [...(record.flowEvents ?? [])]
    .sort(compareEventsAscending)
    .find((event) => stageRankOf(event.stage) >= stageRankOf("S5"));
  if (settledEvent) return settledEvent.date;
  return stageRankOf(record.stage) >= stageRankOf("S5") ? record.eventDate : null;
}

export function buildYearTracks(records: YearTrackInput[]): YearTrack[] {
  return records
    .map((record) => {
      const events = [...(record.flowEvents ?? [])].sort(compareEventsAscending);
      const dates = events.length > 0 ? events.map((event) => event.date) : [record.eventDate];
      const points: YearTrackPoint[] = (events.length > 0
        ? events
        : [{ date: record.eventDate, stage: record.stage, label: record.title, summary: "", sourceUrl: "" }]
      ).map((event) => ({
        date: event.date,
        stage: event.stage,
        label: event.label,
        offset: axisOffset(record.bargainingYear, event.date),
      }));
      const settledOn = findSettlement(record);

      return {
        year: record.bargainingYear,
        stage: record.stage,
        agreementType: record.agreementType,
        settledOn,
        settledOffset: settledOn ? axisOffset(record.bargainingYear, settledOn) : null,
        points,
        startOffset: axisOffset(record.bargainingYear, dates[0]),
        endOffset: axisOffset(record.bargainingYear, dates[dates.length - 1]),
      };
    })
    .sort((left, right) => right.year - left.year);
}

/**
 * 예년 타결 시기.
 *
 * 단체협약 만료일은 기사에 적히지 않아 33건 가운데 한 건도 확보하지 못했다. 관행으로
 * 추정해 채우는 것은 이 대시보드의 전제를 깬다. 대신 지금까지 관측된 타결 월을 그대로
 * 요약한다. 추정이 아니라 확인된 사실의 요약이므로 원칙과 부딪히지 않으면서 다음 교섭
 * 시기를 가늠하게 해 준다.
 */
export type SettlementSeason = {
  months: number[];
  label: string;
  years: number[];
};

export function summarizeSettlementSeason(
  tracks: YearTrack[],
  { excludeYear }: { excludeYear?: number } = {},
): SettlementSeason | null {
  const settled = tracks.filter(
    (track) => track.settledOn && track.year !== excludeYear,
  );
  if (settled.length < 2) return null;

  const months = settled.map((track) => Number(track.settledOn!.slice(5, 7)));
  const unique = [...new Set(months)].sort((left, right) => left - right);
  const min = Math.min(...months);
  const max = Math.max(...months);
  return {
    months: unique,
    label: min === max ? `${min}월` : `${min}~${max}월`,
    years: settled.map((track) => track.year).sort((left, right) => left - right),
  };
}

/** 직전 확인 연도와의 타결 시점 차이. 같은 축 위의 날짜 차이로만 말한다. */
export function compareSettlementPace(tracks: YearTrack[], year: number) {
  const current = tracks.find((track) => track.year === year);
  if (!current?.settledOn) return null;
  const previous = tracks.find((track) => track.year < year && track.settledOn);
  if (!previous?.settledOn) return null;

  const currentDay = daysBetween(`${current.year}-01-01`, current.settledOn);
  const previousDay = daysBetween(`${previous.year}-01-01`, previous.settledOn);
  const diff = currentDay - previousDay;
  if (diff === 0) return { previousYear: previous.year, days: 0, label: "같은 시점" };
  const weeks = Math.round(Math.abs(diff) / 7);
  const size = weeks >= 1 ? `${weeks}주` : `${Math.abs(diff)}일`;
  return {
    previousYear: previous.year,
    days: diff,
    label: diff > 0 ? `${size} 늦음` : `${size} 빠름`,
  };
}


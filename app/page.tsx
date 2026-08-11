"use client";

import { type FormEvent, useMemo, useState, useSyncExternalStore } from "react";
import {
  Activity,
  ArrowRight,
  CalendarDays,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  FileCheck2,
  Filter,
  Landmark,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react";
import framework from "../data/negotiation-framework.json";
import historicalSeed from "../data/historical-fact-seed.json";
import currentSeed from "../data/current-2026-fact-seed.json";
import automationHeartbeat from "../data/automation-heartbeat.json";
import {
  compareEventsAscending,
  deriveCaseHistory,
  INDUSTRIAL_ACTION_LABELS,
  issueHighlights,
  type CaseHistory,
} from "./bargaining-history";

type AgreementFilter = "ALL" | "WAGE" | "INTEGRATED" | "CBA" | "SUPPLEMENTAL" | "UNKNOWN";
type AgreementType = Exclude<AgreementFilter, "ALL">;
type BargainingFlowEvent = {
  date: string;
  stage: string;
  label: string;
  summary: string;
  sourceUrl?: string;
};
type HistoricalRecord = {
  id: string;
  companyId: string;
  companyLegalName: string;
  directEmployerId: string;
  bargainingYear: number;
  agreementType: Exclude<AgreementType, "UNKNOWN">;
  stage: string;
  eventDate: string;
  title: string;
  factSummary: string;
  unionName: string;
  directEmploymentEvidence: string;
  scopeEvidenceUrl?: string;
  sourceUrl: string;
  sourceName: string;
  sourceTier: "S" | "A" | "B" | "C";
  confidence: number;
  scopeClassification: "PRIMARY_DIRECT_UNION";
  coveredWorkerRelation: "DIRECT";
  includeInPrimaryDashboard: true;
  annotation: string;
  flowEvents?: BargainingFlowEvent[];
};
type TrackingCompany = {
  id: string;
  legalName: string;
  tier: string;
  industry: string;
};

type CaseExample = {
  id: string;
  name: string;
  subtitle: string;
  agreementType: AgreementType;
  agreementLabel: string;
  yearType: string;
  stage: string;
  reason: string;
  lastConfirmed: string;
  verifiedAt: string;
  freshness: string;
  confidence: number;
  sourceTier: "S" | "A" | "B" | "C";
  scope: string;
  round?: string;
  majorityUnion: "O" | "X" | "확인중";
  unionMembers: string;
  history: CaseHistory | null;
  issueSummary: string[];
  breakdownReason: string[];
  voteChangeSummary: string[];
  evidence: { date: string; title: string; source: string; tier: "S" | "A" | "B" | "C" }[];
  sourceAnnotations: { event: string; sourceUrl: string; note: string }[];
  flowEvents: BargainingFlowEvent[];
  next: string;
};

const stageMeta = framework.enums.primary_stage.map((stage) => ({
  code: stage.code,
  label: stage.label,
  shortLabel: stage.short_label,
  description: stage.description,
  rank: stage.rank,
}));

const stageByCode = new Map(stageMeta.map((stage) => [stage.code, stage]));

const historicalRecords = historicalSeed.records as HistoricalRecord[];
const currentRecords = currentSeed.records as HistoricalRecord[];
const bargainingRecords = [...historicalRecords, ...currentRecords];
const trackingCompanies = historicalSeed.trackingCompanies as TrackingCompany[];
const lastCollectionKstDate = automationHeartbeat.lastRunKstDate ?? null;
const lastCollectionOutcome = automationHeartbeat.lastRunOutcome ?? null;

// 시드의 기준일은 사실을 마지막으로 검증한 날이고, 수집 흔적은 마지막으로 확인한 날이다.
// 둘을 나란히 쓰면 한 화면에 다른 날짜가 두 개 보인다. 수집이 성공한 날은 그날까지 사실이
// 확인된 것이므로, 수집일이 더 늦으면 그것을 기준일로 쓴다.
const seedAsOf = currentSeed.asOf ?? "2026-08-10";
const currentAsOf =
  lastCollectionOutcome === "success" && lastCollectionKstDate && lastCollectionKstDate > seedAsOf
    ? lastCollectionKstDate
    : seedAsOf;
const currentYear = Number(currentAsOf.slice(0, 4));
const availableYears = Array.from(
  new Set([...bargainingRecords.map((record) => record.bargainingYear), currentYear]),
).sort((left, right) => right - left);
const defaultYear = availableYears[0] ?? historicalSeed.coveragePeriod.endYear;

const agreementLabels: Record<AgreementType, string> = {
  WAGE: "임금협상",
  INTEGRATED: "통합 임단협",
  CBA: "단체협약",
  SUPPLEMENTAL: "특별·보충협약",
  UNKNOWN: "유형 미확인",
};

function formatDate(date: string) {
  return date.replaceAll("-", ".");
}

// 보는 시점의 KST 날짜. 서버 렌더·프리렌더 시점의 날짜를 굳혀 두면 캐시된 HTML이
// "오늘 수집 완료"를 틀리게 말할 수 있으므로, 브라우저 시계로만 판단한다.
// useSyncExternalStore의 서버 스냅샷을 null로 두어 하이드레이션 불일치를 피한다.
const emptySubscribe = () => () => {};

function readTodayKstDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

// 수집이 멈춰도 화면이 그대로면 사람은 멈춘 걸 알 수 없다. 마지막 수집일을 보는
// 시점의 KST 날짜와 비교해 지연을 드러낸다.
function describeCollectionLag(lastKstDate: string | null, todayKstDate: string) {
  if (!lastKstDate) return { tone: "stale" as const, text: "수집 기록 없음" };

  const lagDays = Math.round(
    (Date.parse(`${todayKstDate}T00:00:00Z`) - Date.parse(`${lastKstDate}T00:00:00Z`)) / 86_400_000,
  );

  if (Number.isNaN(lagDays)) return { tone: "stale" as const, text: "수집 기록 확인 불가" };
  if (lastCollectionOutcome && lastCollectionOutcome !== "success") {
    return { tone: "stale" as const, text: `마지막 수집 실패 (${lastKstDate})` };
  }
  if (lagDays <= 0) return { tone: "fresh" as const, text: `오늘 수집 완료 (${lastKstDate} KST)` };
  if (lagDays === 1) return { tone: "warn" as const, text: `마지막 수집 ${lastKstDate} · 1일 지연` };
  return { tone: "stale" as const, text: `마지막 수집 ${lastKstDate} · ${lagDays}일 지연` };
}

function getYearLabel(year: number) {
  return year === currentYear ? `${year}년 현재` : `${year}년`;
}

// ── 공개 사실의 출처: DB 우선, 정적 시드 폴백 ─────────────────────────────
//
// 번들에 담긴 정적 시드로 먼저 그리고, Worker가 Supabase에서 읽어온 공개 행이 도착하면
// 그걸로 갈아탄다. DB가 비었거나 연결이 끊겨도 화면이 비지 않는다.
//
// DB가 채우는 것은 단계·확인일·요약·경과다. 제목·원문 URL처럼 화면 표시에만 쓰는 필드는
// 시드 값을 유지한다. 두 곳의 값이 다르면 DB를 사실로 본다(수정 요청이 반영되는 곳이다).
type PublishedFact = {
  companyId: string;
  bargainingYear: number;
  stage: string;
  eventDate: string;
  factSummary: string;
  sourceTier: string;
  confidence: number;
  flowEvents: { date: string; stage: string; label: string; summary: string }[];
};

type FactSource = { source: string; facts: PublishedFact[] | null };

let factSnapshot: FactSource = { source: "seed", facts: null };
let factFetchStarted = false;
const factListeners = new Set<() => void>();

function loadPublishedFacts() {
  if (factFetchStarted) return;
  factFetchStarted = true;
  fetch("/api/published-facts")
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      if (!payload || !Array.isArray(payload.records) || payload.records.length === 0) return;
      factSnapshot = { source: payload.source ?? "database", facts: payload.records };
      for (const listener of factListeners) listener();
    })
    .catch(() => {
      // 조회 실패는 화면을 비우지 않는다. 정적 시드로 계속 그린다.
    });
}

function subscribeFacts(onChange: () => void) {
  factListeners.add(onChange);
  loadPublishedFacts();
  return () => factListeners.delete(onChange);
}

const seedFactSnapshot: FactSource = { source: "seed", facts: null };

/** 같은 법인·연도의 DB 값으로 시드 레코드를 덮어쓴다. 없는 연도는 시드 그대로 둔다. */
function applyPublishedFacts(records: HistoricalRecord[], facts: PublishedFact[] | null) {
  if (!facts || facts.length === 0) return records;
  const byKey = new Map(facts.map((fact) => [`${fact.companyId}:${fact.bargainingYear}`, fact]));
  return records.map((record) => {
    const fact = byKey.get(`${record.companyId}:${record.bargainingYear}`);
    if (!fact) return record;
    return {
      ...record,
      stage: fact.stage || record.stage,
      eventDate: fact.eventDate || record.eventDate,
      factSummary: fact.factSummary || record.factSummary,
      sourceTier: (fact.sourceTier as HistoricalRecord["sourceTier"]) || record.sourceTier,
      confidence: typeof fact.confidence === "number" ? fact.confidence : record.confidence,
      flowEvents: fact.flowEvents?.length
        ? fact.flowEvents.map((event) => ({
            date: event.date,
            stage: event.stage,
            label: event.label || stageByCode.get(event.stage)?.label || event.stage,
            summary: event.summary,
          }))
        : record.flowEvents,
    };
  });
}

// 목록 카드에서는 법인 형태 표기를 떼어 이름이 한 줄에 들어오게 한다. 데이터와 상세
// 화면은 법적 실명을 그대로 유지한다.
function shortCompanyName(legalName: string) {
  return legalName
    .replace(/\s*주식회사\s*/g, " ")
    .replace(/\s*\(주\)\s*/g, " ")
    .trim();
}

// 서술형 한 덩어리는 읽히지 않는다. 문장과 " · " 구분자를 기준으로 끊어 글머리 기호로
// 보여준다. 원문 문장을 다시 쓰지 않고 그대로 나누기만 한다.
function toBulletPoints(text: string) {
  return text
    .split(/(?<=다\.)\s+|\s+·\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function getBargainingCases(
  year: number,
  records: HistoricalRecord[] = bargainingRecords,
): CaseExample[] {
  return trackingCompanies.map((company) => {
    const record = records
      .filter((candidate) => candidate.companyId === company.id && candidate.bargainingYear === year)
      .sort((left, right) => right.eventDate.localeCompare(left.eventDate))[0];

    if (!record) {
      return {
        id: `${company.id}-${year}-unverified`,
        name: company.legalName,
        subtitle: "원청 노조 교섭 근거 미확인",
        agreementType: "UNKNOWN",
        agreementLabel: agreementLabels.UNKNOWN,
        yearType: `${year}년 · 미확인`,
        stage: "U",
        reason: `${year}년 법인·원청 노조·교섭단위를 함께 식별하는 원문 미확보`,
        lastConfirmed: "—",
        verifiedAt: "—",
        freshness: "근거 보강 대기",
        confidence: 0,
        sourceTier: "C",
        scope: "원청 노조 교섭 근거 미확인 · 공개 단계 갱신 금지",
        majorityUnion: "확인중",
        unionMembers: "공개 근거 미확인",
        history: null,
        issueSummary: ["원청 노조 범위와 해당 연도 교섭 기록을 한 원문에서 함께 확인한 뒤에만 쟁점 표시"],
        breakdownReason: ["결렬 여부 추정 금지"],
        voteChangeSummary: ["찬반투표·최종안·기존 대비 변경을 확인한 원문 없음"],
        evidence: [{ date: "—", title: "공개 가능한 원청 노조 사실 없음", source: "검증 보류", tier: "C" }],
        sourceAnnotations: [],
        flowEvents: [],
        next: "법인명·원청 노조 적용범위·교섭 사실·원문 URL 동시 확인 전까지 상태 변경 없음",
      };
    }

    // 범위 증빙은 공개 대상 판정에만 쓰는 내부 근거다. 화면에서는 교섭 사실을 확인한
    // 원문만 보여준다. 판정 자체는 수집 단계의 필수 게이트로 그대로 남아 있다.
    const sourceAnnotations = [
      { event: record.title, sourceUrl: record.sourceUrl, note: `${record.sourceName} · ${formatDate(record.eventDate)} · ${record.annotation}` },
    ];
    const evidence = [
      { date: record.eventDate.slice(5).replace("-", "."), title: record.title, source: record.sourceName, tier: record.sourceTier },
    ];

    return {
      id: record.id,
      name: record.companyLegalName,
      subtitle: record.unionName,
      agreementType: record.agreementType,
      agreementLabel: agreementLabels[record.agreementType],
      yearType: `${year}년 ${agreementLabels[record.agreementType]}`,
      stage: record.stage,
      reason: record.factSummary,
      lastConfirmed: formatDate(record.eventDate),
      verifiedAt: formatDate(record.eventDate),
      freshness: record.bargainingYear === currentYear ? `${currentAsOf} 기준 현재 현황` : "과거 사실 초기 데이터",
      confidence: record.confidence,
      sourceTier: record.sourceTier,
      scope: `원청 노조 · ${record.unionName}`,
      round: record.stage === "S7" ? "조인·체결 확인" : record.stage === "S6" ? "찬반·인준 확인" : "원문 교섭 확인",
      majorityUnion: "확인중",
      unionMembers: "공개 근거 미확인",
      history: deriveCaseHistory(record),
      issueSummary: toBulletPoints(record.factSummary),
      breakdownReason: toBulletPoints(
        `${record.bargainingYear === currentYear ? "현재 확인한 기사" : "이 초기 기록"}에 확인된 결렬 사유 없음 · 원문 명시 시에만 별도 쟁점 갱신`,
      ),
      voteChangeSummary:
        record.stage === "S6" || record.stage === "S7"
          ? toBulletPoints(record.factSummary)
          : toBulletPoints("찬반투표·최종안의 기존 대비 변경 · 확인된 원문 있을 때만 표시"),
      evidence,
      sourceAnnotations,
      flowEvents: record.flowEvents?.length
        ? record.flowEvents
        : [{
            date: record.eventDate,
            stage: record.stage,
            label: "확인된 핵심 경과",
            summary: record.factSummary,
            sourceUrl: record.sourceUrl,
          }],
      next: "다음 일일 수집 · 원문 추가 확인, 조합원 수·대표성, 쟁점·최종안 변경 분리 검증",
    };
  });
}

const filters: { id: AgreementFilter; label: string }[] = [
  { id: "ALL", label: "전체 교섭" },
  { id: "WAGE", label: "임금협상" },
  { id: "INTEGRATED", label: "통합 임단협" },
  { id: "CBA", label: "단체협약" },
  { id: "SUPPLEMENTAL", label: "특별·보충" },
  { id: "UNKNOWN", label: "유형 미확인" },
];

const pipeline = [
  { icon: Search, title: "뉴스 후보 수집", text: "법인명·임단협·교섭·잠정합의 등 5개 의도로 후보 수집" },
  { icon: Database, title: "사실 단위 정규화", text: "URL·제목·발행일 결합 · 예정과 발생 구분" },
  { icon: ShieldCheck, title: "근거 등급 판정", text: "출처·명시성·교차 확인으로 신뢰도 산출" },
  { icon: Activity, title: "상태 안전 반영", text: "검증된 이벤트만 주 단계·병렬 배지 갱신" },
];

const guardrails = [
  {
    label: "찬반투표 가결",
    meaning: "파업 개시 아님",
    description: "투표 결과·예고·실제 쟁의행위 각각 별도 이벤트로 기록",
  },
  {
    label: "잠정합의",
    meaning: "최종 체결 아님",
    description: "인준·서명·발효 확인 후에만 최종 체결 단계 표시",
  },
  {
    label: "새 기사 없음",
    meaning: "미착수 아님",
    description: "기존 확정 상태 유지 · 신선도 배지로만 경과 표시",
  },
  {
    label: "하청·용역·파견 노조 사례",
    meaning: "원청 노조 현황에서 제외",
    description: "원청 노조로 확인되지 않은 원청 상대 교섭 · 보드 합산 제외 · 별도 검토함 분리",
  },
];

function getTierLabel(tier: "S" | "A" | "B" | "C") {
  return {
    S: "S · 공적·협약 원문",
    A: "A · 당사자 공식",
    B: "B · 교차 확인 언론",
    C: "C · 검토 후보",
  }[tier];
}

function StagePill({ stage }: { stage: string }) {
  const meta = stageByCode.get(stage);
  return <span className={`stage-pill stage-${stage.toLowerCase()}`}>{meta?.shortLabel ?? stage}</span>;
}


function RadarMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "radar-mark radar-mark-compact" : "radar-mark"} aria-hidden="true">
      <span className="radar-sweep" />
      <span className="radar-beam" />
      <span className="radar-core" />
    </span>
  );
}

export default function Home() {
  const [activeFilter, setActiveFilter] = useState<AgreementFilter>("ALL");
  const [selectedYear, setSelectedYear] = useState(defaultYear);
  const [selectedId, setSelectedId] = useState(() => getBargainingCases(defaultYear)[0]?.id ?? "");
  const [showAllStages, setShowAllStages] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [stageFocus, setStageFocus] = useState("ALL");
  const [isAddCompanyOpen, setIsAddCompanyOpen] = useState(false);
  const [companyRequest, setCompanyRequest] = useState({
    companyLegalName: "",
    industry: "",
    websiteUrl: "",
    rationale: "",
    adminCode: "",
  });
  const [companyRequestMessage, setCompanyRequestMessage] = useState("");
  const [isSubmittingCompanyRequest, setIsSubmittingCompanyRequest] = useState(false);
  // 크롤링 결과가 실제와 다를 때 사람이 고치는 경로. 접수와 공개는 분리한다.
  const [isCorrectionOpen, setIsCorrectionOpen] = useState(false);
  const [correction, setCorrection] = useState({
    fieldName: "stage",
    proposedValue: "",
    evidenceUrl: "",
    reason: "",
    editorName: "",
    adminCode: "",
  });
  const [correctionMessage, setCorrectionMessage] = useState("");
  const [isSubmittingCorrection, setIsSubmittingCorrection] = useState(false);
  const todayKstDate = useSyncExternalStore(emptySubscribe, readTodayKstDate, () => null);
  const collectionLag = useMemo(
    () => (todayKstDate ? describeCollectionLag(lastCollectionKstDate, todayKstDate) : null),
    [todayKstDate],
  );
  // DB 공개 행이 도착하면 그것으로 갈아탄다. 서버 스냅샷은 시드이므로 하이드레이션이 어긋나지 않는다.
  const factState = useSyncExternalStore(
    subscribeFacts,
    () => factSnapshot,
    () => seedFactSnapshot,
  );
  const activeRecords = useMemo(
    () => applyPublishedFacts(bargainingRecords, factState.facts),
    [factState],
  );
  const caseExamples = useMemo(
    () => getBargainingCases(selectedYear, activeRecords),
    [selectedYear, activeRecords],
  );

  const visibleCases = useMemo(
    () => {
      const normalizedSearch = searchTerm.trim().toLocaleLowerCase("ko-KR");
      return caseExamples.filter((item) => {
        const matchesAgreement = activeFilter === "ALL" || item.agreementType === activeFilter;
        const matchesStage = stageFocus === "ALL" || item.stage === stageFocus;
        const searchTarget = `${item.name} ${item.subtitle} ${item.yearType} ${item.agreementLabel}`.toLocaleLowerCase("ko-KR");
        const matchesSearch = !normalizedSearch || searchTarget.includes(normalizedSearch);
        return matchesAgreement && matchesStage && matchesSearch;
      });
    },
    [activeFilter, caseExamples, searchTerm, stageFocus],
  );

  const selectedCase =
    visibleCases.find((item) => item.id === selectedId) ?? visibleCases[0] ?? caseExamples[0];
  const selectedStage = stageByCode.get(selectedCase.stage) ?? stageMeta[0];
  const selectedIssues = selectedCase.history ? issueHighlights(selectedCase.history) : [];
  const activeStageIndex = stageMeta.findIndex((stage) => stage.code === selectedCase.stage);
  const displayStages = showAllStages ? stageMeta : stageMeta.slice(0, 6);

  async function submitCompanyRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCompanyRequestMessage("");
    setIsSubmittingCompanyRequest(true);
    try {
      const response = await fetch("/api/company-requests", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dashboard-admin-code": companyRequest.adminCode,
        },
        body: JSON.stringify({
          companyLegalName: companyRequest.companyLegalName,
          industry: companyRequest.industry,
          websiteUrl: companyRequest.websiteUrl,
          rationale: companyRequest.rationale,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setCompanyRequestMessage(result.error ?? "요청 접수 실패 · 입력값 확인 필요");
        return;
      }
      setCompanyRequestMessage(result.message ?? "추적 기업 추가 요청 접수 완료");
      setCompanyRequest((current) => ({ ...current, companyLegalName: "", industry: "", websiteUrl: "", rationale: "", adminCode: "" }));
    } catch {
      setCompanyRequestMessage("네트워크 오류 발생 · 잠시 후 재시도");
    } finally {
      setIsSubmittingCompanyRequest(false);
    }
  }

  // 수정 대상의 기존값을 화면에서 그대로 보여주고 같은 값을 서버로도 보낸다. 이전값을
  // 남겨야 되돌릴 수 있고, 무엇이 어떻게 바뀌는지 검토자가 판단할 수 있다.
  const correctionPreviousValue = (() => {
    const record = bargainingRecords.find((candidate) => candidate.id === selectedCase.id);
    if (!record) return "";
    switch (correction.fieldName) {
      case "stage": return record.stage;
      case "eventDate": return record.eventDate;
      case "agreementType": return record.agreementType;
      case "unionName": return record.unionName;
      case "title": return record.title;
      case "factSummary": return record.factSummary;
      case "sourceUrl": return record.sourceUrl;
      case "flowEvents": return `경과 ${record.flowEvents?.length ?? 0}건`;
      default: return "";
    }
  })();

  async function submitCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmittingCorrection(true);
    setCorrectionMessage("");
    try {
      const record = bargainingRecords.find((candidate) => candidate.id === selectedCase.id);
      const response = await fetch("/api/record-corrections", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dashboard-admin-code": correction.adminCode,
        },
        body: JSON.stringify({
          targetRecordId: selectedCase.id,
          companyIdKey: record?.companyId ?? "",
          companyLegalName: selectedCase.name,
          bargainingYear: record?.bargainingYear ?? selectedYear,
          fieldName: correction.fieldName,
          previousValue: correctionPreviousValue,
          proposedValue: correction.proposedValue,
          evidenceUrl: correction.evidenceUrl,
          reason: correction.reason,
          editorName: correction.editorName,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setCorrectionMessage(result.error ?? "수정 요청 접수 실패 · 입력값 확인 필요");
        return;
      }
      setCorrectionMessage(result.message ?? "기록 수정 요청 접수 완료");
      setCorrection((current) => ({ ...current, proposedValue: "", evidenceUrl: "", reason: "", adminCode: "" }));
    } catch {
      setCorrectionMessage("네트워크 오류 발생 · 잠시 후 재시도");
    } finally {
      setIsSubmittingCorrection(false);
    }
  }

  return (
    <main className="site-shell">
      <section className="top-band" aria-label="서비스 안내">
        <div className="container top-band-inner">
          {/* 기준일은 같은 행 오른쪽의 마지막 수집 표시가 이미 담당한다. 여기서 한 번 더
              쓰면 같은 줄에 날짜가 두 번 나온다. */}
          <p><Sparkles size={14} aria-hidden="true" /> 대한민국 주요 제조업의 단체교섭 현황을 모니터링합니다 · 원청 노조 교섭만 수록</p>
          <p>
            <Clock3 size={14} aria-hidden="true" /> 수집 예정: 매일 06:30 KST · 법인별 1회
            {lastCollectionKstDate ? (
              <span className={`collection-state collection-state-${collectionLag?.tone ?? "idle"}`}>
                {collectionLag?.text ?? `마지막 수집 ${lastCollectionKstDate} KST`}
              </span>
            ) : null}
          </p>
        </div>
      </section>

      {/* 상단 바에는 메뉴만 왼쪽으로 두고, 서비스 이름은 히어로의 제목 자리로 옮긴다.
          같은 이름을 두 줄에 반복하지 않고 제목 한 곳에서만 크게 보여주기 위한 배치다. */}
      <header className="site-header">
        <div className="container header-inner header-inner-left">
          <nav className="header-nav" aria-label="주요 섹션">
            <a href="#board">교섭현황</a>
            <a href="#framework">단계 프레임워크</a>
            <a href="#collection">수집 원칙</a>
          </nav>
          <button className="header-link header-action" type="button" onClick={() => { setCompanyRequestMessage(""); setIsAddCompanyOpen(true); }}>
            추적 기업 추가 <Plus size={15} />
          </button>
        </div>
      </header>

      <section className="hero compact-hero" id="overview">
        <div className="container hero-grid compact-hero-grid">
          <div className="hero-copy">
            <h1 className="hero-brand">
              <RadarMark />
              <span>노사교섭 <strong>레이더</strong></span>
            </h1>
            <p className="hero-description">
              원청 노조의 임금협상과 단체교섭 <strong>주 단계</strong>와 교섭·조정·쟁의·타결의 <strong>상태</strong>를 함께 읽는 대시보드
            </p>
            <p className="hero-footnote"><CircleAlert size={15} /> 교섭 단계 · 완료율 아닌 기사 원문으로 확인한 현재 좌표</p>
          </div>
        </div>
      </section>

      <section className="dashboard-section" id="board">
        <div className="container">
          <div className="section-heading dashboard-heading">
            <div>
              <p className="section-kicker">교섭현황 · 검증 데이터</p>
              <h2>교섭현황 대시보드</h2>
            </div>
            <div className="dashboard-actions">
              <div className="data-health" aria-label="데이터 상태 설명">
                <span className="health-light" aria-hidden="true" />
                <span>
                  {currentAsOf} 기준 · 검증 교섭 기록 {activeRecords.length}건 · {getYearLabel(selectedYear)} 조회
                  <b className={`fact-source fact-source-${factState.source}`}>
                    {factState.source === "seed" ? "내장 데이터" : "DB 연결"}
                  </b>
                </span>
              </div>
              <button className="board-add-company" type="button" onClick={() => { setCompanyRequestMessage(""); setIsAddCompanyOpen(true); }}>
                <Plus size={15} /> 추적 기업 추가
              </button>
            </div>
          </div>

          <div className="scope-guard" role="note">
            <ShieldCheck size={17} aria-hidden="true" />
            <p><strong>포함:</strong> 원청 노조의 교섭 기록 · <strong>제외:</strong> 하청·사내협력사·용역·파견 노조의 원청 상대 교섭 → 원청 노조 현황 합산·표시 제외, 별도 검토 대상 분리</p>
          </div>

          <div className="year-filter-bar" aria-label="연도별 교섭현황 조회">
            <div className="year-filter-label"><CalendarDays size={16} /> 연도별 교섭현황</div>
            <div className="year-filter-options" role="tablist" aria-label="교섭 연도 선택">
              {availableYears.map((year) => (
                <button
                  className={selectedYear === year ? "year-filter-chip active" : "year-filter-chip"}
                  key={year}
                  type="button"
                  role="tab"
                  aria-selected={selectedYear === year}
                  onClick={() => {
                    setSelectedYear(year);
                    setSelectedId(getBargainingCases(year)[0]?.id ?? "");
                  }}
                >
                  {getYearLabel(year)}
                </button>
              ))}
            </div>
            <span className="year-filter-note">2026년은 최신 기사 기준, 이전 연도는 기록된 교섭 경과를 함께 표시</span>
          </div>

          <div className="filter-bar" aria-label="협약 유형 필터">
            <div className="filter-main">
              <div className="filter-label"><Filter size={15} /> 협약 범위</div>
              <div className="filter-options" role="tablist" aria-label="협약 범위 선택">
                {filters.map((filter) => (
                  <button
                    className={activeFilter === filter.id ? "filter-chip active" : "filter-chip"}
                    key={filter.id}
                    onClick={() => {
                      setActiveFilter(filter.id);
                      const next = caseExamples.find((item) => filter.id === "ALL" || item.agreementType === filter.id);
                      if (next) setSelectedId(next.id);
                    }}
                    role="tab"
                    aria-selected={activeFilter === filter.id}
                    type="button"
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="company-search">
              <Search size={16} aria-hidden="true" />
              <span className="sr-only">원청 노조 확정 법인 검색</span>
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                type="search"
                placeholder="원청 노조 확정 법인 검색"
                aria-label="원청 노조 확정 법인 검색"
              />
            </label>
          </div>

          <div className="stage-filter-bar" aria-label="교섭 단계별 조회">
            <div className="stage-filter-label"><Activity size={15} /> 교섭 단계별 조회</div>
            <div className="stage-filter-options" role="tablist" aria-label="주 단계 선택">
              <button
                className={stageFocus === "ALL" ? "stage-filter-chip active" : "stage-filter-chip"}
                type="button"
                role="tab"
                aria-selected={stageFocus === "ALL"}
                onClick={() => setStageFocus("ALL")}
              >
                전체
              </button>
              {stageMeta.map((stage) => (
                <button
                  className={stageFocus === stage.code ? "stage-filter-chip active" : "stage-filter-chip"}
                  key={stage.code}
                  type="button"
                  role="tab"
                  aria-selected={stageFocus === stage.code}
                  onClick={() => {
                    setStageFocus(stage.code);
                    const next = caseExamples.find((item) => item.stage === stage.code && (activeFilter === "ALL" || item.agreementType === activeFilter));
                    if (next) setSelectedId(next.id);
                  }}
                >
                  <small>{stage.code}</small> {stage.shortLabel}
                </button>
              ))}
            </div>
          </div>

          <div className="case-layout">
            <div className="case-list" role="list" aria-label="검증된 교섭현황 목록">
              {visibleCases.length === 0 && (
                <div className="empty-result" role="status">
                  <Search size={20} aria-hidden="true" />
                  <strong>조건에 맞는 원청 노조 교섭 기록 없음</strong>
                  <span>원청 노조로 확인된 교섭 기록만 검색 결과 노출</span>
                  <button type="button" onClick={() => { setSearchTerm(""); setStageFocus("ALL"); }}>검색·단계 필터 초기화</button>
                </div>
              )}
              {visibleCases.map((item) => {
                const isActive = selectedCase.id === item.id;
                const meta = stageByCode.get(item.stage);
                return (
                  <button
                    key={item.id}
                    className={isActive ? "case-card active" : "case-card"}
                    onClick={() => setSelectedId(item.id)}
                    type="button"
                    aria-pressed={isActive}
                  >
                    <span className="case-card-top">
                      <span className="case-type">{item.yearType}</span>
                      <StagePill stage={item.stage} />
                    </span>
                    {/* 목록은 어느 법인을 고를지 판단할 최소 정보만 담는다. 교섭 단계 상세,
                        참여노조 과반, 선거, 근거 등급은 오른쪽 상세에서 모두 보여준다. */}
                    <span className="case-card-title-row">
                      {/* 카드에서는 법인 형태 표기를 떼어 읽기 좋게 하고, 법적 실명은
                          제목 속성으로 남긴다. 실명 표기 원칙을 잃지 않기 위한 것이다. */}
                      <strong title={item.name}>{shortCompanyName(item.name)}</strong>
                      <ChevronRight size={17} aria-hidden="true" />
                    </span>
                    <span className="case-card-subtitle">{item.subtitle}</span>
                    <span className="case-card-footer">
                      <span>{meta?.label ?? "단계 미확인"}</span>
                      <span>검증 {item.verifiedAt}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <article className="case-detail" aria-live="polite">
              <div className="case-detail-header">
                <div>
                  <p className="detail-overline">{selectedYear === currentYear ? "선택한 현재 교섭현황" : "선택한 과거 교섭 기록"}</p>
                  <h3>{selectedCase.name}</h3>
                  <p>{selectedCase.subtitle}</p>
                </div>
                <div className="detail-header-side">
                  <div className="confidence-card" title={getTierLabel(selectedCase.sourceTier)}>
                    <span>근거 신뢰도</span>
                    <strong>{Math.round(selectedCase.confidence * 100)}<small>%</small></strong>
                    <em>{getTierLabel(selectedCase.sourceTier)}</em>
                  </div>
                  {/* 크롤링 기록이 실제와 다를 때 고칠 경로. 접수는 검토 대기로만 남는다. */}
                  <button
                    className="record-correction-button"
                    type="button"
                    onClick={() => { setCorrectionMessage(""); setIsCorrectionOpen(true); }}
                    disabled={!bargainingRecords.some((candidate) => candidate.id === selectedCase.id)}
                  >
                    <FileCheck2 size={14} /> 기록 수정 요청
                  </button>
                </div>
              </div>

              <div className="status-spotlight">
                <div className="spotlight-stage"><StagePill stage={selectedCase.stage} /></div>
                <div>
                  <p>{selectedYear === currentYear ? "현재 주 단계" : "해당 연도 최종 확인 단계"}</p>
                  <h4>{selectedStage.label}</h4>
                  {/* 그 해에 체결됐는지, 이듬해까지 이어졌는지를 단계와 같이 읽어야 한다.
                      이월은 기록 일자가 교섭연도를 넘긴 경우에만 확정으로 말한다. */}
                  {selectedCase.history && (
                    <span
                      className={`settlement-chip settlement-${selectedCase.history.settlement.status.toLowerCase()}`}
                      title={selectedCase.history.settlement.detail}
                    >
                      {selectedCase.history.settlement.label}
                    </span>
                  )}
                  <span>{selectedCase.reason}</span>
                </div>
              </div>

              <section className="bargaining-flow" aria-label="교섭 경과">
                <div className="subsection-title"><span>교섭 경과</span><small>기사 원문에서 확인된 발생·확인 순서</small></div>
                {/* 경과가 몇 건이든 먼저 누적 지표를 보여준다. 단계 하나만 남은 과거
                    기록에서는 "무엇이 없는지"가 그 자체로 정보다. */}
                {selectedCase.history && (
                  <div className="flow-rollup">
                    <span>교착·조정 <strong>{selectedCase.history.impasseCount}회</strong></span>
                    <span>본교섭 기록 <strong>{selectedCase.history.bargainingRoundCount}회</strong></span>
                    <span>
                      쟁의 <strong>{INDUSTRIAL_ACTION_LABELS[selectedCase.history.industrialActionLevel]}</strong>
                    </span>
                    <span>{selectedCase.history.settlement.label}</span>
                  </div>
                )}
                {/* 목록은 최신 일정이 위로 온다. 지금 어디까지 왔는지가 먼저 읽혀야 한다.
                    누적 지표는 위의 flow-rollup이 담으므로 순서를 뒤집어도 셈은 그대로다. */}
                {selectedCase.flowEvents.length === 0 ? (
                  <p className="flow-empty">해당 연도 교섭 경과 표시에 필요한 원청 노조 근거 미확보</p>
                ) : (
                  <ol className="flow-list">
                    {[...selectedCase.flowEvents]
                      .sort((left, right) => compareEventsAscending(right, left))
                      .map((flow, index) => (
                      <li className="flow-item" key={`${flow.date}-${flow.label}-${index}`}>
                        <time>{formatDate(flow.date)}</time>
                        <span className="flow-dot" aria-hidden="true" />
                        <div>
                          <div className="flow-title"><StagePill stage={flow.stage} /><strong>{flow.label}</strong></div>
                          <p>{flow.summary}</p>
                          {flow.sourceUrl && <a href={flow.sourceUrl} target="_blank" rel="noreferrer">원문 보기</a>}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                {selectedCase.history?.settlement.status === "CONTINUED_PAST_YEAR" && (
                  <p className="flow-carryover-note">
                    {selectedCase.history.settlement.detail} 이후 경과는 {selectedCase.history.settlement.spannedIntoYear}년
                    이후 기록에서 이어 확인한다.
                  </p>
                )}
                {selectedCase.history && !selectedCase.history.hasTimeline && (
                  <p className="flow-coverage-note">
                    이 연도는 결과만 확인된 기록이다. 상견례·본교섭·교착·쟁의 일정은 원문 근거를 확보하는
                    대로 순서대로 채운다. 2026년 이후 교섭은 매일 수집이 경과를 자동으로 누적한다.
                  </p>
                )}
              </section>

              <div className="detail-meta-grid">
                <div><span>교섭 범위</span><strong>{selectedCase.scope}</strong></div>
                <div><span>마지막 검증</span><strong>{selectedCase.verifiedAt} · {selectedCase.freshness}</strong></div>
                <div><span>현재 국면</span><strong>{selectedCase.round ?? "교섭 확인 대기"}</strong></div>
              </div>

              {/* 참여노조 과반·조합원 수는 12개 법인 전부 근거가 없어 항상 "확인중"·"공개 근거
                  미확인"만 표시됐다. 값이 없는 칸을 늘어놓기보다 근거를 확보한 뒤 되살린다.
                  과반 판정 기준(참여노조 조합원 분모)은 docs/negotiation-framework.md에 남아 있다. */}
              <div className="identity-facts" aria-label="교섭 기본 정보">
                <div><span>올해 협상유형</span><strong>{selectedCase.yearType}</strong></div>
                {/* 노조 선거 단독 항목은 이슈로 보기 어렵다. 쟁의 경과·찬반투표·노동위원회
                    판단처럼 실제로 교섭을 움직인 사실을 한 칸에 모아 보여준다. */}
                <div className="identity-issues">
                  <span>이슈</span>
                  {selectedIssues.length === 0 ? (
                    <strong>확인된 이슈 없음</strong>
                  ) : (
                    <ul className="identity-issue-list">
                      {selectedIssues.map((issue) => <li key={issue}>{issue}</li>)}
                    </ul>
                  )}
                </div>
              </div>

              {/* 병렬 상태 행은 주 단계에서 그대로 파생된 값만 보여줘서 정보가 늘지 않았다.
                  교섭을 움직인 사실은 위의 이슈 칸과 교섭 경과가 담는다. */}

              <div className="detail-bottom-grid">
                <div className="evidence-list">
                  <div className="subsection-title"><span>확인 근거</span><small>검증에 사용한 원문</small></div>
                  {selectedCase.evidence.map((evidence) => (
                    <div className="evidence-row" key={`${evidence.date}-${evidence.title}`}>
                      <time>{evidence.date}</time>
                      <div><strong>{evidence.title}</strong><span>{evidence.source}</span></div>
                      <b className={`tier tier-${evidence.tier.toLowerCase()}`}>{evidence.tier}</b>
                    </div>
                  ))}
                </div>
                <div className="next-check">
                  <Landmark size={19} aria-hidden="true" />
                  <span>다음 확인 포인트</span>
                  <p>{selectedCase.next}</p>
                </div>
              </div>

              <div className="case-inspection-grid">
                <section className="inspection-card">
                  <div className="subsection-title"><span>쟁점 요약</span><small>교섭 단위별 분리 기록</small></div>
                  <ul className="inspection-list">
                    {selectedCase.issueSummary.map((point) => <li key={point}>{point}</li>)}
                  </ul>
                </section>
                <section className="inspection-card">
                  <div className="subsection-title"><span>결렬 사유</span><small>추정 금지</small></div>
                  <ul className="inspection-list">
                    {selectedCase.breakdownReason.map((point) => <li key={point}>{point}</li>)}
                  </ul>
                </section>
                <section className="inspection-card inspection-vote">
                  <div className="subsection-title"><span>찬반투표·최종안 변경</span><small>기존·전년 대비</small></div>
                  <ul className="inspection-list">
                    {selectedCase.voteChangeSummary.map((point) => <li key={point}>{point}</li>)}
                  </ul>
                </section>
              </div>

              <section className="source-annotations" aria-label="원문 URL 주석">
                <div className="subsection-title"><span>원문 URL 주석</span><small>검증에 사용한 실제 원문</small></div>
                {selectedCase.sourceAnnotations.length === 0 && <p className="source-annotation-empty">공개 가능한 원문·원청 노조 범위 근거 추가 확인 중</p>}
                {selectedCase.sourceAnnotations.map((annotation) => (
                  <div className="source-annotation" key={annotation.sourceUrl}>
                    <strong>{annotation.event}</strong>
                    <a href={annotation.sourceUrl} target="_blank" rel="noreferrer"><code>{annotation.sourceUrl}</code></a>
                    <span>{annotation.note}</span>
                  </div>
                ))}
              </section>
            </article>
          </div>
        </div>
      </section>

      <section className="framework-section" id="framework">
        <div className="container">
          <div className="section-heading framework-heading">
            <div>
              <p className="section-kicker">상태 모델</p>
              <h2>단계는 정렬 좌표,<br />진행률 아님</h2>
            </div>
            <div className="framework-note">
              <span className="note-symbol">≠</span>
              <p><strong>예외 경로 허용</strong> · 조정 후 재교섭, 잠정합의 부결 후 교착, 인준 뒤 서명 대기 = 각각 다른 상태</p>
            </div>
          </div>

          <div className="stage-board" aria-label="주 단계 모델">
            <div className="stage-board-intro">
              <div><span className="small-label">선택 교섭현황의 현재 좌표</span><strong><StagePill stage={selectedCase.stage} /> {selectedStage.label}</strong></div>
              <div className="axis-controls">
                <span className="no-progress-label">단계 축으로 교섭현황 탐색 · 완료율 없음</span>
                {stageFocus !== "ALL" && <button type="button" onClick={() => setStageFocus("ALL")}>전체 단계 보기</button>}
              </div>
            </div>
            <ol className="stage-track" aria-label="주 단계로 교섭현황 좁혀 보기">
              {stageMeta.map((stage, index) => {
                const isCurrent = stage.code === selectedCase.stage;
                const isPast = activeStageIndex > index && stage.code !== "U";
                const isFocused = stageFocus === stage.code;
                return (
                  <li
                    className={`stage-point ${isCurrent ? "current" : ""} ${isPast ? "contextual" : ""} ${isFocused ? "focused" : ""}`}
                    key={stage.code}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setStageFocus((current) => current === stage.code ? "ALL" : stage.code);
                        const next = caseExamples.find((item) => item.stage === stage.code && (activeFilter === "ALL" || item.agreementType === activeFilter));
                        if (next) setSelectedId(next.id);
                      }}
                      aria-pressed={isFocused}
                      aria-label={`${stage.label} 단계로 교섭현황 보기`}
                    >
                      <span className="stage-dot" aria-hidden="true" />
                      <span className="stage-code">{stage.code}</span>
                      <strong>{stage.shortLabel}</strong>
                      <small>{stage.code === "U" ? "근거 대기" : stage.code === "S4" ? "재교섭 가능" : stage.code === "S6" ? "부결 시 되돌아감" : ""}</small>
                    </button>
                  </li>
                );
              })}
            </ol>
            <div className="stage-caption">
              <Activity size={16} />
              <p>현재 단계 기준 = <strong>가장 최근의 고신뢰 발생 이벤트</strong> · 예정 일정은 주 단계 미확정</p>
            </div>
          </div>

          <div className="stage-dictionary">
            {displayStages.map((stage) => (
              <article className="dictionary-card" key={stage.code}>
                <span className="dictionary-code">{stage.code}</span>
                <h3>{stage.label}</h3>
                <p>{stage.description}</p>
              </article>
            ))}
          </div>
          <button className="show-stages-button" type="button" onClick={() => setShowAllStages((current) => !current)}>
            {showAllStages ? "단계 요약하기" : "나머지 단계 4개 보기"}
            <ChevronRight className={showAllStages ? "rotated" : ""} size={17} aria-hidden="true" />
          </button>
        </div>
      </section>

      <section className="collection-section" id="collection">
        <div className="container collection-layout">
          <div className="collection-copy">
            <p className="section-kicker">일일 수집 설계</p>
            <h2>매일 한 번,<br /><em>사실부터</em> 축적</h2>
            <p>
              법인별 수집 하루 1회 제한 · 1단계 <strong>원청 노조 교섭 여부 검증</strong> · 기사 원문 복제 대신 제목·링크·발행 정보와 짧은 사실 요약 보존으로 상태 변경 근거 추적
            </p>
            <div className="collection-timing">
              <CalendarDays size={20} aria-hidden="true" />
              <div><strong>매일 06:30 KST</strong><span>법인별 1회 · 실패 시 이전 확정 상태 보존</span></div>
            </div>
          </div>
          <div className="pipeline" aria-label="일일 수집 처리 흐름">
            {pipeline.map((step, index) => {
              const Icon = step.icon;
              return (
                <div className="pipeline-step" key={step.title}>
                  <span className="pipeline-number">0{index + 1}</span>
                  <span className="pipeline-icon"><Icon size={19} aria-hidden="true" /></span>
                  <div><h3>{step.title}</h3><p>{step.text}</p></div>
                  {index < pipeline.length - 1 && <span className="pipeline-arrow" aria-hidden="true">↓</span>}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="guardrail-section">
        <div className="container">
          <div className="section-heading compact-heading">
            <div>
              <p className="section-kicker">해석 안전장치</p>
              <h2>상태를 과장하지 않는 규칙</h2>
            </div>
            <p>예정·주장·발생·정정 = 서로 다른 신호</p>
          </div>
          <div className="guardrail-grid">
            {guardrails.map((item) => (
              <article className="guardrail-card" key={item.label}>
                <span className="guardrail-icon"><FileCheck2 size={18} aria-hidden="true" /></span>
                <p>{item.label}</p>
                <h3>{item.meaning}</h3>
                <span>{item.description}</span>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="principle-banner">
        <div className="container principle-inner">
          <div className="principle-icon"><UsersRound size={23} aria-hidden="true" /></div>
          <p><strong>원청 노조 검증 게이트 통과 교섭만 표시</strong> · 하청·사내협력사·용역·파견 노조의 원청 상대 교섭은 원청 노조 현황 합산 제외</p>
          <a href="#board">교섭현황으로 돌아가기 <ArrowRight size={15} /></a>
        </div>
      </section>

      {isCorrectionOpen && (
        <div className="company-request-backdrop">
          <section className="company-request-dialog" role="dialog" aria-modal="true" aria-labelledby="record-correction-title">
            <div className="company-request-heading">
              <div>
                <p>운영자 수정</p>
                <h2 id="record-correction-title">기록 수정 요청</h2>
              </div>
              <button className="dialog-close" type="button" aria-label="기록 수정 요청 창 닫기" onClick={() => setIsCorrectionOpen(false)}><X size={18} /></button>
            </div>
            <p className="company-request-intro">
              {selectedCase.name} · {selectedYear}년 기록 · 근거 원문과 수정자를 함께 남기고 검토 후 공개 반영
            </p>
            <form className="company-request-form" onSubmit={submitCorrection}>
              <label>
                <span>수정 항목 <b>필수</b></span>
                <select
                  value={correction.fieldName}
                  onChange={(event) => setCorrection((current) => ({ ...current, fieldName: event.target.value }))}
                >
                  <option value="stage">주 단계</option>
                  <option value="eventDate">확인일</option>
                  <option value="agreementType">협약유형</option>
                  <option value="unionName">노조명</option>
                  <option value="title">기록 제목</option>
                  <option value="factSummary">사실 요약</option>
                  <option value="sourceUrl">원문 URL</option>
                  <option value="flowEvents">교섭 경과</option>
                </select>
              </label>
              <label>
                <span>기존값</span>
                <input value={correctionPreviousValue} readOnly aria-readonly="true" />
              </label>
              <label>
                <span>수정값 <b>필수</b></span>
                <textarea required maxLength={2000} rows={2} value={correction.proposedValue} onChange={(event) => setCorrection((current) => ({ ...current, proposedValue: event.target.value }))} placeholder="예: S7" />
              </label>
              <label>
                <span>근거 원문 URL <b>필수</b></span>
                <input type="url" required maxLength={500} value={correction.evidenceUrl} onChange={(event) => setCorrection((current) => ({ ...current, evidenceUrl: event.target.value }))} placeholder="https://" />
              </label>
              <label>
                <span>수정 사유 <b>필수</b></span>
                <textarea required maxLength={800} rows={2} value={correction.reason} onChange={(event) => setCorrection((current) => ({ ...current, reason: event.target.value }))} placeholder="무엇이 실제와 다른지" />
              </label>
              <label>
                <span>수정자 <b>필수</b></span>
                <input required maxLength={80} value={correction.editorName} onChange={(event) => setCorrection((current) => ({ ...current, editorName: event.target.value }))} placeholder="표시할 이름" />
              </label>
              <label>
                <span>운영 관리 코드 <b>필수</b></span>
                <input type="password" required value={correction.adminCode} onChange={(event) => setCorrection((current) => ({ ...current, adminCode: event.target.value }))} autoComplete="off" placeholder="서버에만 보관되는 코드" />
              </label>
              <p className="company-request-security">수정자·수정 시각·이전값·이후값·근거 URL을 함께 기록 · 관리 코드 원문 미저장 · 검토 전 공개 반영 없음</p>
              {correctionMessage && <p className="company-request-message" role="status">{correctionMessage}</p>}
              <div className="company-request-actions">
                <button className="dialog-cancel" type="button" onClick={() => setIsCorrectionOpen(false)}>취소</button>
                <button className="dialog-submit" type="submit" disabled={isSubmittingCorrection}>{isSubmittingCorrection ? "요청 저장 중…" : "수정 요청 보내기"}</button>
              </div>
            </form>
          </section>
        </div>
      )}

      {isAddCompanyOpen && (
        <div className="company-request-backdrop">
          <section className="company-request-dialog" role="dialog" aria-modal="true" aria-labelledby="company-request-title">
            <div className="company-request-heading">
              <div>
                <p>운영자 요청</p>
                <h2 id="company-request-title">추적 기업 추가</h2>
              </div>
              <button className="dialog-close" type="button" aria-label="추적 기업 추가 창 닫기" onClick={() => setIsAddCompanyOpen(false)}><X size={18} /></button>
            </div>
            <p className="company-request-intro">법인 실명·참고 근거 제출 → 원청 노조 범위 검토 통과 후에만 추적 목록 반영</p>
            <form className="company-request-form" onSubmit={submitCompanyRequest}>
              <label>
                <span>법인 실명 <b>필수</b></span>
                <input required minLength={2} maxLength={120} value={companyRequest.companyLegalName} onChange={(event) => setCompanyRequest((current) => ({ ...current, companyLegalName: event.target.value }))} placeholder="예: 주식회사 ○○" />
              </label>
              <label>
                <span>산업 분야</span>
                <input maxLength={80} value={companyRequest.industry} onChange={(event) => setCompanyRequest((current) => ({ ...current, industry: event.target.value }))} placeholder="예: 자동차부품" />
              </label>
              <label>
                <span>참고 URL</span>
                <input type="url" maxLength={500} value={companyRequest.websiteUrl} onChange={(event) => setCompanyRequest((current) => ({ ...current, websiteUrl: event.target.value }))} placeholder="https://" />
              </label>
              <label>
                <span>추가 사유</span>
                <textarea maxLength={800} value={companyRequest.rationale} onChange={(event) => setCompanyRequest((current) => ({ ...current, rationale: event.target.value }))} placeholder="산업 영향, 원청 노조 교섭 노출도 등" rows={3} />
              </label>
              <label>
                <span>운영 관리 코드 <b>필수</b></span>
                <input type="password" required value={companyRequest.adminCode} onChange={(event) => setCompanyRequest((current) => ({ ...current, adminCode: event.target.value }))} autoComplete="off" placeholder="서버에만 보관되는 코드" />
              </label>
              <p className="company-request-security">관리 코드 원문 미저장 · 요청은 검토 대기 상태로만 접수</p>
              {companyRequestMessage && <p className="company-request-message" role="status">{companyRequestMessage}</p>}
              <div className="company-request-actions">
                <button className="dialog-cancel" type="button" onClick={() => setIsAddCompanyOpen(false)}>취소</button>
                <button className="dialog-submit" type="submit" disabled={isSubmittingCompanyRequest}>{isSubmittingCompanyRequest ? "요청 저장 중…" : "추가 요청 보내기"}</button>
              </div>
            </form>
          </section>
        </div>
      )}

      <footer className="site-footer">
        <div className="container footer-inner">
          <div><a className="brand footer-brand" href="#overview"><RadarMark compact /> 노사교섭 <strong>레이더</strong></a><p>한국 대기업 임금·단체교섭 현황을 위한 상태 프레임워크</p></div>
          <div className="footer-meta"><span>프레임워크 v1.0</span><span>·</span><span>법률·연구 기반 설계</span><span>·</span><span>{currentAsOf} 기준 현황</span></div>
        </div>
      </footer>
    </main>
  );
}

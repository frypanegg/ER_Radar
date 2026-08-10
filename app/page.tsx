"use client";

import { type FormEvent, useMemo, useState } from "react";
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
  electionIssue: string;
  issueSummary: string;
  breakdownReason: string;
  voteChangeSummary: string;
  overlays: { label: string; tone: BadgeTone; group: string }[];
  evidence: { date: string; title: string; source: string; tier: "S" | "A" | "B" | "C" }[];
  sourceAnnotations: { event: string; sourceUrl: string; note: string }[];
  flowEvents: BargainingFlowEvent[];
  next: string;
};

type BadgeTone = "blue" | "purple" | "orange" | "green" | "gray" | "red";

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
const currentAsOf = currentSeed.asOf ?? "2026-08-10";
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

function getYearLabel(year: number) {
  return year === currentYear ? `${year}년 현재` : `${year}년`;
}

function stageOverlay(stage: string): { label: string; tone: BadgeTone; group: string }[] {
  if (stage === "S7" || stage === "S8") return [{ label: "조인·체결 확인", tone: "green", group: "합의·인준" }];
  if (stage === "S6") return [{ label: "찬반·인준 확인", tone: "green", group: "합의·인준" }];
  if (stage === "S5") return [{ label: "잠정합의 확인", tone: "green", group: "합의·인준" }];
  if (stage === "S4") return [{ label: "교착·조정 확인", tone: "orange", group: "조정·쟁의" }];
  return [{ label: "원청 직접고용 근거 보강", tone: "orange", group: "근거 품질" }];
}

function getBargainingCases(year: number): CaseExample[] {
  return trackingCompanies.map((company) => {
    const record = bargainingRecords
      .filter((candidate) => candidate.companyId === company.id && candidate.bargainingYear === year)
      .sort((left, right) => right.eventDate.localeCompare(left.eventDate))[0];

    if (!record) {
      return {
        id: `${company.id}-${year}-unverified`,
        name: company.legalName,
        subtitle: `${year}년 원청 직접고용 교섭 근거 미확인`,
        agreementType: "UNKNOWN",
        agreementLabel: agreementLabels.UNKNOWN,
        yearType: `${year}년 · 미확인`,
        stage: "U",
        reason: `${year}년의 법인·직접고용 노조·교섭단위를 함께 식별하는 원문을 아직 확보하지 못했습니다. 미착수나 타결로 추정하지 않습니다.`,
        lastConfirmed: "—",
        verifiedAt: "—",
        freshness: "근거 보강 대기",
        confidence: 0,
        sourceTier: "C",
        scope: "원청 직접고용 교섭 근거 미확인 · 공개 단계 갱신 금지",
        majorityUnion: "확인중",
        unionMembers: "공개 근거 미확인",
        electionIssue: "공개 근거 미확인",
        issueSummary: "직접고용 범위와 해당 연도 교섭 기록을 한 원문에서 함께 확인한 뒤에만 쟁점으로 표시합니다.",
        breakdownReason: "결렬 여부를 추정하지 않습니다.",
        voteChangeSummary: "찬반투표·최종안·기존 대비 변경을 확인한 원문이 없습니다.",
        overlays: [{ label: "공개 근거 미확인", tone: "gray", group: "근거 품질" }],
        evidence: [{ date: "—", title: "공개 가능한 원청 직접고용 사실 없음", source: "검증 보류", tier: "C" }],
        sourceAnnotations: [],
        flowEvents: [],
        next: "법인명, 직접고용 적용범위, 교섭사실과 원문 URL이 함께 확인될 때까지 상태를 바꾸지 않습니다.",
      };
    }

    const sourceAnnotations = [
      { event: record.title, sourceUrl: record.sourceUrl, note: `${record.sourceName} · ${formatDate(record.eventDate)} · ${record.annotation}` },
      ...(record.scopeEvidenceUrl && record.scopeEvidenceUrl !== record.sourceUrl
        ? [{ event: "직접고용 범위 증빙", sourceUrl: record.scopeEvidenceUrl, note: record.directEmploymentEvidence }]
        : []),
    ];
    const evidence = [
      { date: record.eventDate.slice(5).replace("-", "."), title: record.title, source: record.sourceName, tier: record.sourceTier },
      ...(record.scopeEvidenceUrl && record.scopeEvidenceUrl !== record.sourceUrl
        ? [{ date: "범위", title: "원청 직접고용 범위 증빙", source: "교섭 범위 검토", tier: "A" as const }]
        : []),
    ];

    return {
      id: record.id,
      name: record.companyLegalName,
      subtitle: `${year}년 ${agreementLabels[record.agreementType]} · ${record.unionName}`,
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
      scope: `원청 법인 직접고용 · ${record.unionName}`,
      round: record.stage === "S7" ? "조인·체결 확인" : record.stage === "S6" ? "찬반·인준 확인" : "원문 교섭 확인",
      majorityUnion: "확인중",
      unionMembers: "공개 근거 미확인",
      electionIssue: "공개 근거 미확인",
      issueSummary: `${record.bargainingYear === currentYear ? "현재 확인 요약" : "과거 기록 요약"}: ${record.factSummary}`,
      breakdownReason: `${record.bargainingYear === currentYear ? "현재 확인한 기사" : "이 초기 기록"}에는 확인된 결렬 사유가 없습니다. 원문에 명시된 경우에만 별도 쟁점으로 갱신합니다.`,
      voteChangeSummary: record.stage === "S6" || record.stage === "S7"
        ? `원문 확인: ${record.factSummary}`
        : "찬반투표·최종안의 기존 대비 변경은 확인된 원문이 있을 때만 표시합니다.",
      overlays: stageOverlay(record.stage),
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
      next: "다음 일일 수집에서는 원문 추가 확인, 조합원 수·대표성, 쟁점·최종안 변경을 분리 검증합니다.",
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
  { icon: Search, title: "뉴스 후보 수집", text: "법인명·임단협·교섭·잠정합의 등 5개 의도로 후보를 모읍니다." },
  { icon: Database, title: "사실 단위 정규화", text: "URL·제목·발행일을 묶고, 예정과 발생을 구분합니다." },
  { icon: ShieldCheck, title: "근거 등급 판정", text: "출처·명시성·교차 확인으로 신뢰도를 계산합니다." },
  { icon: Activity, title: "상태 안전 반영", text: "검증된 이벤트만 주 단계와 병렬 배지를 갱신합니다." },
];

const guardrails = [
  {
    label: "찬반투표 가결",
    meaning: "파업 개시가 아닙니다",
    description: "투표 결과, 예고, 실제 쟁의행위는 별도의 이벤트로 남깁니다.",
  },
  {
    label: "잠정합의",
    meaning: "최종 체결이 아닙니다",
    description: "인준·서명·발효를 통과해야 최종 체결 단계로 표시합니다.",
  },
  {
    label: "새 기사 없음",
    meaning: "미착수가 아닙니다",
    description: "기존 확정 상태는 유지하고, 신선도 배지로만 경과를 알립니다.",
  },
  {
    label: "하청·용역·파견 노조 사례",
    meaning: "원청 노조 현황에서 제외",
    description: "직접고용이 확인되지 않은 원청 상대 교섭은 이 보드에 합산하지 않고 별도 검토함으로 분리합니다.",
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

function OverlayBadge({ label, tone }: { label: string; tone: BadgeTone }) {
  return <span className={`overlay-badge overlay-${tone}`}>{label}</span>;
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
  const caseExamples = useMemo(() => getBargainingCases(selectedYear), [selectedYear]);

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
        setCompanyRequestMessage(result.error ?? "요청을 접수하지 못했습니다. 입력값을 확인해 주세요.");
        return;
      }
      setCompanyRequestMessage(result.message ?? "추적 기업 추가 요청을 접수했습니다.");
      setCompanyRequest((current) => ({ ...current, companyLegalName: "", industry: "", websiteUrl: "", rationale: "", adminCode: "" }));
    } catch {
      setCompanyRequestMessage("네트워크 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setIsSubmittingCompanyRequest(false);
    }
  }

  return (
    <main className="site-shell">
      <section className="top-band" aria-label="서비스 안내">
        <div className="container top-band-inner">
          <p><Sparkles size={14} aria-hidden="true" /> {currentAsOf} 기준 현황 · 원청 법인 직접고용 노조 교섭만 다룹니다</p>
          <p><Clock3 size={14} aria-hidden="true" /> 수집 설계 기준: 매일 06:30 KST · 법인별 1회</p>
        </div>
      </section>

      <header className="site-header">
        <div className="container header-inner">
          <a className="brand" href="#overview" aria-label="노사교섭 레이더 처음으로">
            <RadarMark />
            <span>노사교섭 <strong>레이더</strong></span>
          </a>
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
            <div className="eyebrow"><span className="pulse-dot" /> 초기 추적 12개사 · 2021–2026 교섭 기록</div>
            <h1>대한민국 주요 제조업의<br />단체 교섭 현황을 모니터링 합니다.</h1>
            <p className="hero-description">
              원청 노동조합의 임금협상과 단체교섭 <strong>주 단계</strong>와 교섭·조정·쟁의·타결의 <strong>상태</strong>를 함께 읽는 대시보드
            </p>
            <p className="hero-footnote"><CircleAlert size={15} /> 교섭 단계는 완료율이 아니라, 기사 원문으로 확인된 현재 좌표입니다.</p>
          </div>
        </div>
      </section>

      <section className="dashboard-section" id="board">
        <div className="container">
          <div className="section-heading dashboard-heading">
            <div>
              <p className="section-kicker">교섭현황 · 검증 데이터</p>
              <h2>교섭현황 대시보드</h2>
              <p><strong>원청 직접고용이 확인된 노조</strong>만, 법인 × 교섭연도 × 협약유형 × 교섭단위 × 적용범위의 교섭 기록으로 봅니다. 미확인 연도는 미착수·타결로 추정하지 않습니다.</p>
            </div>
            <div className="dashboard-actions">
              <div className="data-health" aria-label="데이터 상태 설명">
                <span className="health-light" aria-hidden="true" />
                <span>{currentAsOf} 기준 · 검증 교섭 기록 {bargainingRecords.length}건 · {getYearLabel(selectedYear)} 조회</span>
              </div>
              <button className="board-add-company" type="button" onClick={() => { setCompanyRequestMessage(""); setIsAddCompanyOpen(true); }}>
                <Plus size={15} /> 추적 기업 추가
              </button>
            </div>
          </div>

          <div className="scope-guard" role="note">
            <ShieldCheck size={17} aria-hidden="true" />
            <p><strong>포함:</strong> 원청 법인에 직접 고용된 노조의 교섭 기록. <strong>제외:</strong> 하청·사내협력사·용역·파견 노조의 원청 상대 교섭은 원청 노조 현황에 합산·표시하지 않으며, 별도 검토 대상으로 분리합니다.</p>
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
              <span className="sr-only">원청 직접고용 확정 법인 검색</span>
              <input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                type="search"
                placeholder="직접고용 확정 법인 검색"
                aria-label="원청 직접고용 확정 법인 검색"
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
                  <strong>직접고용이 확인된 교섭 기록을 찾지 못했습니다.</strong>
                  <span>원청 직접고용이 확인된 교섭 기록만 검색 결과로 보여줍니다.</span>
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
                      <span className="case-type">{item.yearType} · {item.agreementLabel}</span>
                      <StagePill stage={item.stage} />
                    </span>
                    <span className="case-card-title-row">
                      <strong>{item.name}</strong><ChevronRight size={17} aria-hidden="true" />
                    </span>
                    <span className="case-card-subtitle">{item.subtitle}</span>
                    <span className="case-card-stage">{meta?.label}</span>
                    <span className="case-badges">
                      {item.overlays.slice(0, 2).map((overlay) => (
                        <OverlayBadge key={overlay.label} label={overlay.label} tone={overlay.tone} />
                      ))}
                    </span>
                    <span className="case-facts">
                      <span title="교섭창구 참여노조 조합원 기준입니다. 대표교섭노조 여부나 직접고용 전체 대비 가입률과 다릅니다.">참여노조 과반 <b className={`majority-${item.majorityUnion === "O" ? "yes" : item.majorityUnion === "X" ? "no" : "pending"}`}>{item.majorityUnion}</b></span>
                      <span>조합원 {item.unionMembers}</span>
                    </span>
                    <span className="election-snippet">선거: {item.electionIssue}</span>
                    <span className="case-card-footer">
                      <span>검증 {item.verifiedAt}</span>
                      <span className="confidence-inline">신뢰도 {Math.round(item.confidence * 100)}%</span>
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
                <div className="confidence-card" title={getTierLabel(selectedCase.sourceTier)}>
                  <span>근거 신뢰도</span>
                  <strong>{Math.round(selectedCase.confidence * 100)}<small>%</small></strong>
                  <em>{getTierLabel(selectedCase.sourceTier)}</em>
                </div>
              </div>

              <div className="status-spotlight">
                <div className="spotlight-stage"><StagePill stage={selectedCase.stage} /></div>
                <div>
                  <p>{selectedYear === currentYear ? "현재 주 단계" : "해당 연도 최종 확인 단계"}</p>
                  <h4>{selectedStage.label}</h4>
                  <span>{selectedCase.reason}</span>
                </div>
              </div>

              <section className="bargaining-flow" aria-label="교섭 경과">
                <div className="subsection-title"><span>교섭 경과</span><small>기사 원문에서 확인된 발생·확인 순서</small></div>
                {selectedCase.flowEvents.length === 0 ? (
                  <p className="flow-empty">해당 연도 교섭 경과를 보여 줄 정도의 원청 직접고용 근거가 아직 확보되지 않았습니다.</p>
                ) : (
                  <ol className="flow-list">
                    {selectedCase.flowEvents.map((flow, index) => (
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
                {selectedCase.flowEvents.length === 1 && selectedYear !== currentYear && (
                  <p className="flow-coverage-note">초기 데이터에서 검증된 핵심 경과입니다. 앞선 과정은 원문 근거를 추가 확보하면 순서대로 이어서 표시합니다.</p>
                )}
              </section>

              <div className="detail-meta-grid">
                <div><span>교섭 범위</span><strong>{selectedCase.scope}</strong></div>
                <div><span>마지막 검증</span><strong>{selectedCase.verifiedAt} · {selectedCase.freshness}</strong></div>
                <div><span>현재 국면</span><strong>{selectedCase.round ?? "교섭 확인 대기"}</strong></div>
              </div>

              <div className="identity-facts" aria-label="교섭 기본 정보">
                <div><span>올해 협상유형</span><strong>{selectedCase.yearType}</strong></div>
                <div title="교섭창구 참여노조 조합원 기준입니다. 대표교섭노조 여부나 직접고용 전체 대비 가입률과 다릅니다."><span>참여노조 과반</span><strong className={`majority-${selectedCase.majorityUnion === "O" ? "yes" : selectedCase.majorityUnion === "X" ? "no" : "pending"}`}>{selectedCase.majorityUnion}</strong></div>
                <div><span>조합원 수</span><strong>{selectedCase.unionMembers}</strong></div>
                <div><span>노조 선거 이슈</span><strong>{selectedCase.electionIssue}</strong></div>
              </div>
              <p className="majority-definition">※ 참여노조 과반은 <strong>교섭창구 참여노조 조합원 기준</strong>입니다. 대표교섭노조 여부와 직접고용 전체 대비 가입률은 별도 필드로 기록하며 서로 대체하지 않습니다.</p>

              <div className="overlay-area">
                <div className="subsection-title"><span>병렬 상태</span><small>주 단계와 독립적으로 함께 표시</small></div>
                <div className="overlay-groups">
                  {selectedCase.overlays.map((overlay) => (
                    <div className="overlay-line" key={`${overlay.group}-${overlay.label}`}>
                      <small>{overlay.group}</small>
                      <OverlayBadge label={overlay.label} tone={overlay.tone} />
                    </div>
                  ))}
                </div>
              </div>

              <div className="detail-bottom-grid">
                <div className="evidence-list">
                  <div className="subsection-title"><span>확인 근거</span><small>원문·범위 증빙</small></div>
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
                  <p>{selectedCase.issueSummary}</p>
                </section>
                <section className="inspection-card">
                  <div className="subsection-title"><span>결렬 사유</span><small>추정 금지</small></div>
                  <p>{selectedCase.breakdownReason}</p>
                </section>
                <section className="inspection-card inspection-vote">
                  <div className="subsection-title"><span>찬반투표·최종안 변경</span><small>기존·전년 대비</small></div>
                  <p>{selectedCase.voteChangeSummary}</p>
                </section>
              </div>

              <section className="source-annotations" aria-label="원문 URL 주석">
                <div className="subsection-title"><span>원문 URL 주석</span><small>검증에 사용한 실제 원문</small></div>
                {selectedCase.sourceAnnotations.length === 0 && <p className="source-annotation-empty">공개 가능한 원문과 직접고용 범위 근거를 추가 확인 중입니다.</p>}
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
              <h2>단계는 정렬 좌표이고,<br />진행률이 아닙니다.</h2>
            </div>
            <div className="framework-note">
              <span className="note-symbol">≠</span>
              <p><strong>예외 경로를 허용합니다.</strong> 조정 후 재교섭, 잠정합의 부결 후 교착, 인준 뒤 서명 대기는 모두 서로 다른 상태입니다.</p>
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
              <p>현재 단계는 <strong>가장 최근의 고신뢰 발생 이벤트</strong>를 기준으로 선택합니다. 예정된 일정은 주 단계를 확정하지 않습니다.</p>
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
            <h2>매일 한 번,<br /><em>사실부터</em> 쌓습니다.</h2>
            <p>
              법인별 수집은 하루 1회로 제한합니다. 먼저 원청 법인 <strong>직접고용 노조 교섭인지 검증</strong>하고, 기사 원문을 복제하는 대신 제목·링크·발행 정보와 짧은 사실 요약을 보존해 상태 변경의 근거를 추적합니다.
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
            <p>예정·주장·발생·정정은 같은 신호가 아닙니다.</p>
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
          <p><strong>원청 직접고용 검증 게이트를 먼저 통과한 노조 교섭만 표시</strong>합니다. 하청·사내협력사·용역·파견 노조의 원청 상대 교섭은 원청 노조 현황에 합산하지 않습니다.</p>
          <a href="#board">교섭현황으로 돌아가기 <ArrowRight size={15} /></a>
        </div>
      </section>

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
            <p className="company-request-intro">법인 실명과 참고 근거를 보내면, 원청 직접고용 노조 범위 검토를 통과한 뒤에만 추적 목록에 반영합니다.</p>
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
                <textarea maxLength={800} value={companyRequest.rationale} onChange={(event) => setCompanyRequest((current) => ({ ...current, rationale: event.target.value }))} placeholder="산업 영향, 직접고용 노조 교섭 노출도 등" rows={3} />
              </label>
              <label>
                <span>운영 관리 코드 <b>필수</b></span>
                <input type="password" required value={companyRequest.adminCode} onChange={(event) => setCompanyRequest((current) => ({ ...current, adminCode: event.target.value }))} autoComplete="off" placeholder="서버에만 보관되는 코드" />
              </label>
              <p className="company-request-security">관리 코드 원문은 저장하지 않으며, 요청은 검토 대기 상태로만 접수됩니다.</p>
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

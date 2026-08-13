import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runScript = promisify(execFile);
const APPLY_SCRIPT = fileURLToPath(
  new URL("../scripts/apply-daily-update.mjs", import.meta.url),
);

import {
  extractPageTitle,
  extractResolvedUrl,
  extractSignature,
  isGoogleNewsUrl,
  titleOverlapRatio,
} from "../scripts/resolve-google-news.mjs";
import {
  applyArticleToRecord,
  blocksSettledRecord,
  blocksStageDowngrade,
  selectCandidate,
  stageRanks,
} from "../scripts/apply-daily-update.mjs";
import { classifyArticle, validateConfiguration } from "../scripts/collect-news.mjs";

/** 제목 하나를 실제 설정으로 분류한다. 원문 검증까지 통과한 기사로 취급한다. */
async function classifyTitle(
  title,
  companyId = "hyundai-motor",
  bargainingYear = 2026,
) {
  const config = JSON.parse(
    await readFile(new URL("../data/source-config.json", import.meta.url), "utf8"),
  );
  validateConfiguration(config);
  return classifyArticle(
    {
      title,
      media: "검증 매체",
      publishedAt: "2026-08-11T00:00:00.000Z",
      url: "https://news.google.com/rss/articles/CBMiTEST",
      originalUrl: "https://example.com/original",
      collectionSources: ["naver"],
      originCompanyIds: [companyId],
    },
    config,
    new Date("2026-08-11T00:00:00.000Z"),
    bargainingYear,
  ).classification;
}

function verifiedArticle(overrides = {}) {
  return {
    title: "현대자동차 2026년 임금협상 잠정합의",
    media: "연합뉴스",
    publishedAt: "2026-08-20T02:00:00.000Z",
    url: "https://news.google.com/rss/articles/CBMiTEST",
    originalUrl: "https://yna.co.kr/view/AKR20260820000000001",
    sourceVerification: { status: "RESOLVED_AND_REACHABLE" },
    classification: {
      statusCode: "S5",
      statusName: "잠정합의",
      statusLabel: "잠정합의",
      scopeClassification: "PRIMARY_DIRECT_UNION",
      includeInPrimaryDashboard: true,
      eligibleForStatusAggregation: true,
      requiresSourceVerification: false,
      retainMainState: false,
      confidence: 0.9,
      companies: [{ companyId: "hyundai-motor" }],
      annotations: { sourceTier: "C" },
      ...overrides.classification,
    },
    ...overrides,
  };
}

function seedRecord(overrides = {}) {
  return {
    recordId: "hyundai-motor-2026-wage",
    companyId: "hyundai-motor",
    companyLegalName: "현대자동차 주식회사",
    directEmployerId: "hyundai-motor",
    bargainingYear: 2026,
    agreementType: "WAGE",
    stage: "S4",
    eventDate: "2026-07-29",
    title: "현대자동차 2026년 임금협상 3차 부분파업",
    factSummary: "이전 요약",
    unionName: "전국금속노동조합 현대자동차지부",
    directEmploymentEvidence: "지속가능성보고서의 직접 고용인원 기준 근거",
    scopeEvidenceUrl: "https://org1.hyundai.com/report.pdf",
    sourceUrl: "https://mt.co.kr/previous",
    sourceName: "머니투데이",
    sourceTier: "B",
    confidence: 0.92,
    scopeClassification: "PRIMARY_DIRECT_UNION",
    coveredWorkerRelation: "DIRECT",
    includeInPrimaryDashboard: true,
    factualStatus: "VERIFIED_SOURCE",
    flowEvents: [
      {
        date: "2026-07-29",
        stage: "S4",
        label: "3차 부분파업 개시",
        summary: "이전 경과",
        sourceUrl: "https://mt.co.kr/previous",
      },
    ],
    ...overrides,
  };
}

test("google news 응답의 이중 이스케이프 URL을 잘리지 않게 되돌린다", () => {
  // 실제 batchexecute 응답 형태. `?idxno` 뒤가 \\u003d로 이스케이프되어 들어온다.
  const payload =
    ')]}\'\n\n[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.eroun.net/news/articleView.html?idxno\\\\u003d85080\\",1]",null,null,null,"generic"]]';
  assert.equal(
    extractResolvedUrl(payload),
    "https://www.eroun.net/news/articleView.html?idxno=85080",
  );
});

test("경로만 있는 URL과 구글 자기 링크를 구분해 되돌린다", () => {
  const payload =
    '[["wrb.fr","Fbv4je","[\\"garturlres\\",\\"https://www.yna.co.kr/view/AKR20260724076600061\\",1]"]]';
  assert.equal(
    extractResolvedUrl(payload),
    "https://www.yna.co.kr/view/AKR20260724076600061",
  );
  assert.equal(extractResolvedUrl('["https://news.google.com/rss/articles/CBMi"]'), null);
});

test("기사 페이지 서명 세 값을 모두 읽지 못하면 되돌리기를 시도하지 않는다", () => {
  const complete =
    '<c-wiz data-n-a-id="CBMiVkFV" data-n-a-ts="1786367899" data-n-a-sg="AZta1JYt"></c-wiz>';
  assert.deepEqual(extractSignature(complete), {
    id: "CBMiVkFV",
    timestamp: 1786367899,
    signature: "AZta1JYt",
  });
  assert.equal(
    extractSignature('<c-wiz data-n-a-id="CBMiVkFV" data-n-a-ts="1786367899"></c-wiz>'),
    null,
  );
});

test("제목 겹침 비율로 다른 기사에 붙은 URL을 걸러낸다", () => {
  const feedTitle = "기아 노조, 찬성 82%로 파업 가결";
  assert.equal(
    titleOverlapRatio(feedTitle, "기아 노조, 찬성 82%로 파업 가결 | 연합뉴스"),
    1,
  );
  assert.ok(
    titleOverlapRatio(feedTitle, "가족 여행에 제격인 국내 봄 여행지 3곳 추천") < 0.4,
  );
  // 상투어만 겹치는 경우를 같은 기사로 보지 않는다.
  assert.ok(titleOverlapRatio("속보 뉴스 오늘 기아 파업 가결", "속보 뉴스 오늘") < 0.4);
});

test("빈 페이지에서는 제목을 만들어내지 않는다", () => {
  assert.equal(extractPageTitle("<html><body></body></html>"), "");
  assert.match(
    extractPageTitle('<meta property="og:title" content="기아 노조 파업 가결">'),
    /기아 노조 파업 가결/,
  );
  assert.equal(isGoogleNewsUrl("https://news.google.com/rss/articles/CBMi"), true);
  assert.equal(isGoogleNewsUrl("https://yna.co.kr/view/AKR1"), false);
});

test("원문 URL이 검증되지 않은 후보는 공개 반영 대상에서 제외한다", () => {
  assert.equal(selectCandidate(verifiedArticle()).ok, true);

  const unverified = verifiedArticle();
  unverified.classification.requiresSourceVerification = true;
  assert.deepEqual(selectCandidate(unverified), {
    ok: false,
    reason: "source_url_unverified",
  });

  const noOriginal = verifiedArticle({ originalUrl: null });
  assert.equal(selectCandidate(noOriginal).reason, "source_url_unverified");
});

test("하청·복수법인·단계 미확인 기사는 자동 반영하지 않는다", () => {
  const subcontractor = verifiedArticle();
  subcontractor.classification.includeInPrimaryDashboard = false;
  assert.equal(selectCandidate(subcontractor).reason, "scope_excluded");

  const mixedScope = verifiedArticle();
  mixedScope.classification.scopeClassification = "MIXED_NEEDS_SPLIT";
  assert.equal(selectCandidate(mixedScope).reason, "scope_not_primary_direct_union");

  const twoCompanies = verifiedArticle();
  twoCompanies.classification.companies = [
    { companyId: "hyundai-motor" },
    { companyId: "kia" },
  ];
  assert.equal(selectCandidate(twoCompanies).reason, "multiple_companies");

  const unknownStage = verifiedArticle();
  unknownStage.classification.statusCode = "U";
  assert.equal(selectCandidate(unknownStage).reason, "stage_unknown");

  // 파업 투표 보도처럼 기존 상태를 유지해야 하는 신호는 단계를 바꾸지 않는다.
  const retain = verifiedArticle();
  retain.classification.retainMainState = true;
  assert.equal(selectCandidate(retain).reason, "retain_main_state");
});

test("DART 공시 필터가 실제 서식명을 잡는다", async () => {
  const { isLaborDisclosure, toIsoDate, disclosureViewerUrl, matchCorpCodes } = await import(
    "../scripts/collect-dart-disclosures.mjs"
  );

  // 처음에는 파업·쟁의 같은 말을 찾았고 12개 법인 전부 0건이 나왔다. 공시 제목은 표준
  // 서식명이라 사건을 그대로 쓰지 않는다. 실제로 잡아야 하는 것은 이 서식들이다.
  assert.equal(isLaborDisclosure("생산중단"), true);
  assert.equal(isLaborDisclosure("풍문또는보도에대한해명(미확정)"), true);
  assert.equal(isLaborDisclosure("영업정지"), true);
  // 무관한 공시는 후보에 넣지 않는다.
  assert.equal(isLaborDisclosure("임원ㆍ주요주주특정증권등소유상황보고서"), false);
  assert.equal(isLaborDisclosure("현금ㆍ현물배당결정"), false);
  assert.equal(isLaborDisclosure(undefined), false);

  // 접수일자는 시드의 date 형식과 맞춰야 병합할 수 있다.
  assert.equal(toIsoDate("20260724"), "2026-07-24");
  assert.equal(toIsoDate("2026-07-24"), null);
  assert.match(disclosureViewerUrl("20260724000123"), /^https:\/\/dart\.fss\.or\.kr\/dsaf001\/main\.do\?rcpNo=/);

  // 법인 매칭은 종목코드를 먼저 본다. 못 찾은 법인은 조용히 버리지 않고 보고한다.
  const entries = [
    { corpCode: "00164742", corpName: "현대자동차", stockCode: "005380" },
    { corpCode: "00999999", corpName: "없는회사", stockCode: "" },
  ];
  const { matched, unmatched } = matchCorpCodes(
    [
      { id: "hyundai-motor", legalName: "현대자동차 주식회사" },
      { id: "nowhere", legalName: "존재하지않는 주식회사" },
    ],
    entries,
    { "hyundai-motor": "005380" },
  );
  assert.equal(matched.length, 1);
  assert.equal(matched[0].corpCode, "00164742");
  assert.deepEqual(unmatched.map((c) => c.slug), ["nowhere"]);
});

test("과거 교섭 경과는 근거를 갖춘 사건만 병합된다", async () => {
  const { mergeFlowEvents } = await import("../scripts/build-historical-seed.mjs");
  const records = [
    { recordId: "posco-2023-integrated", companyId: "posco", bargainingYear: 2023, stage: "S6" },
  ];
  const good = {
    events: [
      {
        recordId: "posco-2023-integrated",
        date: "2023-11-09",
        stage: "S6",
        label: "조합원 찬반투표 가결",
        summary: "포스코노동조합이 잠정합의안을 조합원 투표로 가결했다.",
        sourceUrl: "https://example.com/a",
      },
      {
        recordId: "posco-2023-integrated",
        date: "2023-09-20",
        stage: "S4",
        label: "중노위 조정 신청",
        summary: "포스코노동조합이 중앙노동위원회에 조정을 신청했다.",
        sourceUrl: "https://example.com/b",
      },
    ],
  };

  const merged = mergeFlowEvents(records, good);
  assert.equal(merged.coverage.recordsWithTimeline, 1);
  // 날짜 순으로 정렬되어야 경과를 읽을 수 있다.
  assert.deepEqual(
    merged.records[0].flowEvents.map((event) => event.date),
    ["2023-09-20", "2023-11-09"],
  );

  // 근거 URL이 없는 경과는 받지 않는다. 수정·조사 경로가 자동 수집보다 느슨해지면 안 된다.
  assert.throws(
    () => mergeFlowEvents(records, { events: [{ ...good.events[0], sourceUrl: undefined }] }),
    /근거 원문 URL이 없습니다/,
  );
  // 교섭연도보다 이른 사건은 다른 해의 교섭이다.
  assert.throws(
    () => mergeFlowEvents(records, { events: [{ ...good.events[0], date: "2022-05-01" }] }),
    /교섭연도 2023보다 이릅니다/,
  );
  // 이듬해로 넘어가는 사건은 이월이므로 허용한다.
  assert.equal(
    mergeFlowEvents(records, { events: [{ ...good.events[0], date: "2024-03-02" }] })
      .coverage.recordsWithTimeline,
    1,
  );
  // 알 수 없는 대상·단계는 조용히 버리지 않고 실패로 알린다.
  assert.throws(() => mergeFlowEvents(records, { events: [{ ...good.events[0], recordId: "nope" }] }), /해당하는 과거 기록이 없습니다/);
  assert.throws(() => mergeFlowEvents(records, { events: [{ ...good.events[0], stage: "S9" }] }), /허용되지 않습니다/);

  // 같은 사건이 두 번 들어오면 하나만 남는다.
  const duplicated = mergeFlowEvents(records, { events: [good.events[0], good.events[0]] });
  assert.equal(duplicated.records[0].flowEvents.length, 1);

  // 한 기사가 여러 사건을 보도하는 경우는 흔하다. 원문이 같아도 날짜·단계가 다르면 남긴다.
  const oneArticleManyEvents = mergeFlowEvents(records, {
    events: [
      { ...good.events[0], date: "2023-09-20", stage: "S4", label: "조정 신청", summary: "조정을 신청했다." },
      { ...good.events[0], date: "2023-11-01", stage: "S5", label: "잠정합의", summary: "잠정합의안을 도출했다." },
      { ...good.events[0], date: "2023-11-09", stage: "S6", label: "가결", summary: "조합원 투표로 가결했다." },
    ],
  });
  assert.equal(oneArticleManyEvents.records[0].flowEvents.length, 3);
});

test("조합원 가결만으로 최종 체결(S7)로 올리지 않는다", async () => {
  // 문서 원칙: S6→S7은 조합원 가결이 아니라 서명·조인·발효 근거가 필요하다.
  // 2026-08-11 후보의 한국GM 기사가 가결만으로 S7로 올라가고 있었다.
  const ratified = await classifyTitle(
    "‘부분파업’ 벌였던 한국GM 노조, 올해 임단협 가결...56.5% 찬성",
    "gm-korea",
  );
  assert.notEqual(ratified.statusCode, "S7");

  // 조인·서명이 확인되면 그때 S7이 된다.
  const signed = await classifyTitle("한국GM 노조, 2026년 임단협 조인식...협약 체결", "gm-korea");
  assert.equal(signed.statusCode, "S7");
});

test("파업 찬반투표를 인준 투표로 읽지 않는다", async () => {
  // 제목 뒤쪽의 "임단협" 때문에 S6(인준·서명 대기) 패턴에 걸리면, 파업으로 가는
  // 상황이 타결 직전으로 표시된다.
  const strikeVote = await classifyTitle("현대차 노조, 오늘 파업 찬반투표...임단협 갈등 고조");
  assert.notEqual(strikeVote.statusCode, "S6");

  // 잠정합의안 인준 투표는 그대로 S6이어야 한다.
  const ratificationVote = await classifyTitle("현대차 노조, 잠정합의안 가결...인준 완료");
  assert.equal(ratificationVote.statusCode, "S6");
});

test("명시적 근거 없이 단계를 뒤로 되돌리지 않는다", async () => {
  const framework = JSON.parse(
    await readFile(new URL("../data/negotiation-framework.json", import.meta.url), "utf8"),
  );
  const ranks = stageRanks(framework);
  const impasseRecord = seedRecord({ stage: "S4" });

  // 파업 기사에 "노사 교섭 계속"이 붙으면 본교섭(S3) 신호가 잡혀 단계가 내려간다.
  const downgrade = verifiedArticle({
    classification: { statusCode: "S3", statusBasis: "concurrent_main_stage_signal" },
  });
  assert.equal(blocksStageDowngrade(impasseRecord, downgrade, ranks), true);

  // 재교섭·부결처럼 예외 전이로 표시된 하강은 실제 사실이므로 허용한다.
  const reopened = verifiedArticle({
    classification: { statusCode: "S3", statusBasis: "exception_transition" },
  });
  assert.equal(blocksStageDowngrade(impasseRecord, reopened, ranks), false);

  // 전진하는 반영은 막지 않는다.
  const forward = verifiedArticle({
    classification: { statusCode: "S5", statusBasis: "stage_mapping" },
  });
  assert.equal(blocksStageDowngrade(impasseRecord, forward, ranks), false);
});

test("정식 지부명이 없어도 배제 신호가 없으면 직영으로 보되 근거 등급을 낮춘다", async () => {
  // 한국 노동 보도는 "현대차 노조"처럼 약칭만 쓴다. 이것까지 격리하면 실제 직영
  // 교섭 기사의 79%가 검토 대기로 빠진다(2026-08-11 실측).
  const colloquial = await classifyTitle(
    "두산에너빌리티 노조, 임단협 노동위 조정 신청",
    "doosan-enerbility",
  );
  assert.equal(colloquial.scopeClassification, "PRIMARY_DIRECT_UNION");
  const scope = colloquial.companies.find((company) => company.companyId === "doosan-enerbility");
  assert.equal(scope.scopeEvidenceTier, "COMPANY_UNION_PHRASE_NO_EXCLUSION_SIGNAL");

  // 하청 신호가 하나라도 있으면 이 완화가 적용되지 않는다.
  const subcontracted = await classifyTitle(
    "두산에너빌리티 사내하청 노조, 원청에 교섭 요구",
    "doosan-enerbility",
  );
  assert.equal(subcontracted.scopeClassification, "SUBCONTRACTOR_UNION_EXCLUDED");

  // 정식 지부명이 있으면 더 강한 근거로 기록된다.
  const configured = await classifyTitle("금속노조 현대자동차지부, 임금협상 교섭 재개");
  const configuredScope = configured.companies.find(
    (company) => company.companyId === "hyundai-motor",
  );
  assert.equal(configuredScope.scopeEvidenceTier, "CONFIGURED_UNION_ALIAS");
});

test("공개 레코드의 협약유형은 근거로 뒷받침된다", async () => {
  const { assessAgreementTypeEvidence } = await import("../scripts/build-current-2026-seed.mjs");

  // 협약유형은 회사 상세에서 보여 주는 정보이므로 필터에서 빠져도 근거 검증은 유지한다.
  // 아래 두 건은 근거가 유형을 특정하지 못하는 기존 부채다. 이 목록이 늘어나면
  // 실패해야 한다. 줄이려면 근거를 보강하거나 유형을 미확인으로 내려야 한다.
  const knownUnsupported = new Set([
    "hyundai-mobis|2026", // 근거가 "단체교섭"뿐이라 임금 포함 여부를 특정하지 못한다
    "sk-hynix|2024", // 근거가 "재교섭 잠정합의안 가결"뿐이다
  ]);

  const unsupported = [];
  for (const file of ["current-2026-fact-seed.json", "historical-fact-seed.json"]) {
    const seed = JSON.parse(
      await readFile(new URL(`../data/${file}`, import.meta.url), "utf8"),
    );
    for (const record of seed.records) {
      if (assessAgreementTypeEvidence(record).supported) continue;
      unsupported.push(`${record.companyId}|${record.bargainingYear}`);
    }
  }

  const unexpected = unsupported.filter((key) => !knownUnsupported.has(key));
  assert.deepEqual(
    unexpected,
    [],
    `협약유형이 근거로 뒷받침되지 않는 레코드가 새로 생겼다: ${unexpected.join(", ")}`,
  );

  // 근거가 보강돼 부채가 사라졌으면 위 목록에서도 지워야 한다.
  const resolved = [...knownUnsupported].filter((key) => !unsupported.includes(key));
  assert.deepEqual(resolved, [], `근거가 보강된 레코드는 예외 목록에서 지운다: ${resolved.join(", ")}`);
});

test("실제 보도 제목으로 직영·하청 판정을 고정한다", async () => {
  // 2026-08-11 수집분에서 뽑은 실제 제목이다. 범위 규칙을 손댈 때 이 표가 먼저 깨진다.
  const directCases = [
    ["현대제철, 임단협 마무리..노조 잠정합의안 가결", "hyundai-steel"],
    ["포스코 노사, 단체교섭 조정기간 연장...18일 최종 담판", "posco"],
    ["두산에너빌리티 노조, 임단협 노동위 조정 신청", "doosan-enerbility"],
    ["SK하이닉스 노조, 임단협서 주 4.5일제·정년연장 요구할 듯", "sk-hynix"],
    ["삼성전자 노조, 오늘부터 임단협 잠정합의안 투표", "samsung-electronics"],
  ];
  const excludedCases = [
    ["한화오션 하청 노조 파업권 확보...노란봉투법 시행 뒤 첫 사례", "hanwha-ocean"],
    ["“원청 나와라” 현대제철 하청 파업...노봉법 여파 본격화", "hyundai-steel"],
    ["한화오션 하청업체 노조, 원청 상대 파업권 확보...\"교섭 나서야\"", "hanwha-ocean"],
  ];

  for (const [title, companyId] of directCases) {
    const classification = await classifyTitle(title, companyId);
    assert.equal(
      classification.scopeClassification,
      "PRIMARY_DIRECT_UNION",
      `직영으로 판정해야 한다: ${title}`,
    );
  }
  for (const [title, companyId] of excludedCases) {
    const classification = await classifyTitle(title, companyId);
    assert.equal(
      classification.scopeClassification,
      "SUBCONTRACTOR_UNION_EXCLUDED",
      `하청으로 격리해야 한다: ${title}`,
    );
    assert.equal(classification.includeInPrimaryDashboard, false);
    assert.equal(classification.eligibleForStatusAggregation, false);
  }
});

test("제목의 '임단협' 관용 표현이 임금교섭 해를 통합 임단협으로 뒤집지 않는다", async () => {
  // 포스코는 매년 임금교섭, 2년 주기 단체교섭이라고 공표했고 2025년이 단체교섭 해였다.
  // 따라서 2026년은 임금교섭 해다. 그런데 매체마다 같은 사건을 '단체교섭', '임단협',
  // '임금교섭'으로 제각각 쓴다. 아래 세 제목은 모두 2026년 7월 결렬 보도다.
  for (const title of [
    "포스코 노사, 2026년 단체교섭 결렬…중노위 조정 돌입",
    "'57년 무분규' 갈림길 선 포스코...2026 임단협 교섭 결렬",
    "포스코 임금교섭 결국 결렬…노조, 중노위 조정 절차 예고",
  ]) {
    const { agreementType } = (await classifyTitle(title, "posco", 2026)).annotations;
    assert.equal(agreementType.code, "WAGE", `임금협상으로 봐야 한다: ${title}`);
  }

  // 주기가 단체교섭 해로 가리키면 같은 관용 표현이라도 통합으로 남는다.
  const cbaYear = await classifyTitle(
    "포스코 노사, 2025년 임단협 잠정합의안 도출",
    "posco",
    2025,
  );
  assert.equal(cbaYear.annotations.agreementType.code, "INTEGRATED");

  // 현대모비스는 매년 임금·복리후생을 함께 단체교섭한다. 제목이 '단체교섭'뿐이어도
  // 임금이 빠진 교섭이 아니다.
  const mobis = await classifyTitle(
    "현대모비스 2026년 단체교섭 5차 본교섭",
    "hyundai-mobis",
    2026,
  );
  assert.equal(mobis.annotations.agreementType.code, "INTEGRATED");

  // 주기를 뒤집었으면 사람이 보게 남긴다. 주기 등록이 틀렸을 수도 있기 때문이다.
  const overridden = await classifyTitle(
    "'57년 무분규' 갈림길 선 포스코...2026 임단협 교섭 결렬",
    "posco",
    2026,
  );
  assert.equal(
    overridden.annotations.agreementType.factBasis,
    "company_cycle_overrode_title",
  );
  assert.equal(overridden.annotations.agreementType.cycleConflict.titleDerived, "INTEGRATED");
  assert.equal(overridden.annotations.needsReview, true);

  // 주기를 등록하지 않은 회사는 종전대로 제목 분류를 따른다.
  const noCycle = await classifyTitle("기아 2026 임단협 타결", "kia", 2026);
  assert.equal(noCycle.annotations.agreementType.code, "INTEGRATED");
  assert.equal(noCycle.annotations.agreementType.factBasis, "title_keyword");
});

test("원문까지 확인된 기사는 미확인 기사와 같은 근거 등급으로 기록되지 않는다", async () => {
  const verified = await classifyTitle("현대차 노조, 임금협상 교섭 재개");
  assert.equal(verified.annotations.sourceTier, "B");
  assert.equal(verified.annotations.originalUrlStatus, "PUBLISHER_VERIFIED");
});

test("사람이 검증한 체결 기록을 제목 추론 기사로 되돌리지 않는다", () => {
  const settled = seedRecord({ stage: "S7", factualStatus: "VERIFIED_SOURCE" });
  assert.equal(blocksSettledRecord(settled, "S4"), true);
  assert.equal(blocksSettledRecord(settled, "S8"), false);

  // 자동 수집으로 올라간 체결 기록은 같은 등급끼리의 정정을 허용한다.
  const autoSettled = seedRecord({
    stage: "S7",
    factualStatus: "AUTO_COLLECTED_TITLE_BASIS",
  });
  assert.equal(blocksSettledRecord(autoSettled, "S4"), false);
  assert.equal(blocksSettledRecord(seedRecord({ stage: "S3" }), "S4"), false);
});

test("반영은 사건 정보만 바꾸고 원청 노조 범위 근거는 보존한다", () => {
  const record = seedRecord();
  const updated = applyArticleToRecord(record, verifiedArticle(), "2026-08-20");

  assert.equal(updated.stage, "S5");
  assert.equal(updated.eventDate, "2026-08-20");
  assert.equal(updated.sourceUrl, "https://yna.co.kr/view/AKR20260820000000001");
  assert.equal(updated.factualStatus, "AUTO_COLLECTED_TITLE_BASIS");

  // 기사 제목으로 추정할 수 없는 범위 근거는 그대로 유지한다.
  assert.equal(updated.unionName, record.unionName);
  assert.equal(updated.directEmploymentEvidence, record.directEmploymentEvidence);
  assert.equal(updated.scopeEvidenceUrl, record.scopeEvidenceUrl);
  assert.equal(updated.companyLegalName, record.companyLegalName);
  assert.equal(updated.scopeClassification, "PRIMARY_DIRECT_UNION");
  assert.equal(updated.coveredWorkerRelation, "DIRECT");

  // 기존 경과를 지우지 않고 시간순으로 덧붙인다.
  assert.equal(updated.flowEvents.length, 2);
  assert.equal(updated.flowEvents[0].date, "2026-07-29");
  assert.equal(updated.flowEvents[1].date, "2026-08-20");
  assert.match(updated.flowEvents[1].summary, /연합뉴스/);
});

test("같은 원문으로 두 번 반영해도 경과가 중복되지 않는다", () => {
  const once = applyArticleToRecord(seedRecord(), verifiedArticle(), "2026-08-20");
  const twice = applyArticleToRecord(once, verifiedArticle(), "2026-08-20");
  assert.equal(twice.flowEvents.length, 2);
});

test("자동 반영 경로가 기사 본문을 저장하지 않는다", () => {
  const article = verifiedArticle();
  const updated = applyArticleToRecord(seedRecord(), article, "2026-08-20");
  // 보존 대상은 제목·매체·링크와 계산된 분류뿐이다.
  const stored = `${updated.factSummary} ${updated.flowEvents.at(-1).summary}`;
  assert.match(stored, /연합뉴스/);
  assert.match(stored, /본문 인용 없음/);
  assert.ok(!("body" in updated));
  assert.ok(!("articleText" in updated));
});

test("새 사건이 확인되면 시드와 감사 로그가 함께 갱신된다", async () => {
  const workingDirectory = await mkdtemp(join(tmpdir(), "bargaining-apply-"));
  const candidatesPath = join(workingDirectory, "candidates.json");
  const seedPath = join(workingDirectory, "seed.json");
  const auditPath = join(workingDirectory, "audit.json");

  const staleArticle = verifiedArticle({
    title: "현대자동차 2026년 임금협상 교섭 재개",
    publishedAt: "2026-07-01T02:00:00.000Z",
    originalUrl: "https://yna.co.kr/view/AKR20260701000000001",
  });
  const subcontractorArticle = verifiedArticle({
    title: "현대자동차 하청 노조, 원청 상대 교섭 요구",
    publishedAt: "2026-08-25T02:00:00.000Z",
    originalUrl: "https://yna.co.kr/view/AKR20260825000000009",
    classification: {
      includeInPrimaryDashboard: false,
      scopeClassification: "SUBCONTRACTOR_UNION_EXCLUDED",
    },
  });

  await writeFile(
    candidatesPath,
    JSON.stringify({
      batch: { status: "complete", kstDate: "2026-08-21", primarySource: "google" },
      articles: [staleArticle, verifiedArticle(), subcontractorArticle],
    }),
  );
  await writeFile(
    seedPath,
    JSON.stringify({ schemaVersion: 1, asOf: "2026-08-10", records: [seedRecord()] }),
  );

  try {
    const { stdout } = await runScript("node", [
      APPLY_SCRIPT,
      "--candidates",
      candidatesPath,
      "--seed",
      seedPath,
      "--audit",
      auditPath,
    ]);
    assert.match(stdout, /반영 1건/);

    const seed = JSON.parse(await readFile(seedPath, "utf8"));
    const record = seed.records[0];
    assert.equal(record.stage, "S5");
    assert.equal(record.eventDate, "2026-08-20");
    // 기준일은 사건 발생일이 아니라 수집 실행일(KST)로 갱신된다.
    const todayInSeoul = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    assert.equal(seed.asOf, todayInSeoul);

    // 하청 기사는 원청 보드에 섞이지 않는다.
    assert.ok(
      !JSON.stringify(record).includes("AKR20260825000000009"),
      "하청 기사가 원청 기록에 반영되면 안 된다",
    );

    const audit = JSON.parse(await readFile(auditPath, "utf8"));
    assert.equal(audit.runs[0].appliedCount, 1);
    assert.equal(audit.runs[0].applied[0].previousStage, "S4");
    assert.equal(audit.runs[0].applied[0].nextStage, "S5");
    assert.equal(audit.runs[0].skippedReasonCounts.scope_excluded, 1);
    assert.equal(
      audit.runs[0].skippedReasonCounts.not_newer_than_recorded_event,
      undefined,
      "같은 법인의 오래된 기사는 최신 기사에 밀려 후보 선택 단계에서 제외된다",
    );
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
});

test("발사대가 조용해지면 수집이 도는 날에도 드러난다", async () => {
  const { evaluateFreshness } = await import("../scripts/check-collection-freshness.mjs");

  // 토큰이 만료되면 Cloudflare 쪽은 403으로 막히지만 GitHub cron이 그날 수집을
  // 대신 돌린다. 수집 지표만 보면 정상이라 이중화가 벗겨진 걸 아무도 모른다.
  const masked = evaluateFreshness({
    heartbeat: {
      lastRunKstDate: "2026-08-16",
      lastRunOutcome: "success",
      lastLauncher: "schedule",
      lastCloudflareLaunchKstDate: "2026-08-13",
    },
    todayKstDate: "2026-08-16",
  });
  assert.equal(masked.fresh, false);
  assert.match(masked.problems.join(" "), /발사대가 2026-08-13 이후/);

  // 하루 이틀은 GitHub cron이 먼저 떠서 가드에 걸렸을 수 있다. 그건 정상으로 둔다.
  const recent = evaluateFreshness({
    heartbeat: {
      lastRunKstDate: "2026-08-15",
      lastRunOutcome: "success",
      lastLauncher: "schedule",
      lastCloudflareLaunchKstDate: "2026-08-14",
    },
    todayKstDate: "2026-08-15",
  });
  assert.equal(recent.fresh, true);

  // 발사대를 붙이기 전의 흔적에는 기록이 없다. 도입 첫날부터 오경보를 내면 안 된다.
  const beforeLauncher = evaluateFreshness({
    heartbeat: { lastRunKstDate: "2026-08-13", lastRunOutcome: "success" },
    todayKstDate: "2026-08-13",
  });
  assert.equal(beforeLauncher.fresh, true);
});

test("GitHub schedule이 누락돼도 Cloudflare cron이 일일 수집을 깨운다", async () => {
  const [worker, viteConfig, workflow] = await Promise.all([
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/daily-bargaining-update.yml", import.meta.url), "utf8"),
  ]);

  // 발사대가 실제로 등록돼 있어야 한다. 21:20 UTC = 06:20 KST.
  assert.match(viteConfig, /triggers:\s*\{\s*crons:\s*\[\s*"20 21 \* \* \*"\s*\]/);
  assert.match(worker, /async scheduled\(/);

  // 깨우는 대상은 기존 일일 수집 워크플로다. 수집 로직을 워커로 옮기지 않는다.
  assert.match(worker, /actions\/workflows\/\$\{workflow\}\/dispatches/);
  assert.match(worker, /daily-bargaining-update\.yml/);
  assert.match(worker, /"x-github-api-version"/);

  // force를 넘기면 이미 수집한 날에도 다시 수집한다. 그 판단은 워크플로 가드 몫이다.
  assert.doesNotMatch(worker, /force:\s*true/);
  assert.match(workflow, /workflow_dispatch:/);

  // 토큰이 없을 때 예외로 죽으면 워커 전체가 영향을 받는다. 경고만 남기고 지나가야 한다.
  const guard = worker.slice(
    worker.indexOf("async function dispatchDailyCollection"),
    worker.indexOf("const worker = {"),
  );
  assert.match(guard, /if \(!env\.GITHUB_DISPATCH_TOKEN\)[\s\S]{0,400}?return;/);

  // GitHub cron은 이중화로 남긴다. 한쪽이 죽어도 다른 쪽이 깨운다.
  assert.match(workflow, /cron: "34 21 \* \* \*"/);
});

test("일일 자동화 워크플로가 KST 06:30 직후로 등록되어 있다", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/daily-bargaining-update.yml", import.meta.url),
    "utf8",
  );
  // 21:34 UTC = 06:34 KST(다음 날). 정시·30분 경계는 스케줄러 부하가 몰려 피한다.
  assert.match(workflow, /cron:\s*["']34 21 \* \* \*["']/);
  assert.match(workflow, /collect-news\.mjs/);
  assert.match(workflow, /apply-daily-update\.mjs/);
  assert.match(workflow, /npm test/);
  // 비밀값은 이름으로만 참조하고 로그로 내보내지 않는다.
  assert.doesNotMatch(workflow, /NAVER_API_HUB_CLIENT_SECRET\s*:\s*["'][^$]/);
});

test("schedule 이벤트가 유실돼도 같은 날 예비 실행이 남아 있다", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/daily-bargaining-update.yml", import.meta.url),
    "utf8",
  );
  // GitHub schedule은 보장이 없다. 하루 한 번만 걸면 그 한 번이 유실되면 끝이다.
  const crons = workflow.match(/cron:\s*["'][^"']+["']/g) ?? [];
  assert.ok(crons.length >= 2, `예비 스케줄이 필요하다 (현재 ${crons.length}개)`);

  // 예비 실행이 중복 수집·커밋을 만들지 않도록, 오늘 성공했으면 건너뛴다.
  assert.match(workflow, /needed=false/);
  assert.match(workflow, /steps\.guard\.outputs\.needed == 'true'/);
  // force 입력은 판단을 무시하고 다시 수집한다.
  assert.match(workflow, /inputs\.force[\s\S]{0,200}needed=true/);
});

test("수집이 멈추면 감시 워크플로가 실패로 드러낸다", async () => {
  const alarm = await readFile(
    new URL("../.github/workflows/collection-staleness-alarm.yml", import.meta.url),
    "utf8",
  );
  assert.match(alarm, /schedule/);
  assert.match(alarm, /check-collection-freshness\.mjs/);
  // 저장소 흔적만 보지 않고 공개 페이지까지 확인해 배포 중단도 잡는다.
  assert.match(alarm, /--live\s+https:\/\//);
  // 지연이면 메일을 보내고, 그와 별개로 워크플로도 실패시킨다.
  assert.match(alarm, /steps\.freshness\.outputs\.status != '0'[\s\S]{0,600}--mode staleness/);
  assert.match(alarm, /판정 결과 반영[\s\S]{0,200}exit 1/);
});

test("수집 결과 메일이 성공·실패 양쪽에서 발송된다", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/daily-bargaining-update.yml", import.meta.url),
    "utf8",
  );
  // 메일이 안 오는 것 자체가 신호가 되어야 하므로 실패한 날에도 보낸다.
  assert.match(workflow, /수집 결과 메일 발송\s*\n\s*if: always\(\)/);
  assert.match(workflow, /mode=failure/);
  // 자격증명이 없으면 조용히 건너뛴다.
  assert.match(workflow, /-z "\$MAIL_SMTP_USER"/);
  // 메일 비밀값도 이름으로만 참조한다.
  assert.doesNotMatch(workflow, /MAIL_SMTP_PASSWORD\s*:\s*["'][^$]/);
  // 저장소 쓰기 권한이 있는 작업이라 서드파티 액션을 끌어들이지 않는다.
  assert.doesNotMatch(workflow, /uses:\s*(?!actions\/)[a-z0-9-]+\//i);
  // 메일 안의 승인 버튼을 만들 때도 서버 전용 DB 키와 관리 코드는 시크릿 이름으로만 받는다.
  assert.match(workflow, /SUPABASE_URL:\s*\$\{\{ secrets\.SUPABASE_URL \}\}/);
  assert.match(workflow, /DASHBOARD_ADMIN_CODE:\s*\$\{\{ secrets\.DASHBOARD_ADMIN_CODE \}\}/);
});

test("메일 본문이 감사 로그와 관리자 확인 요청을 사람이 읽을 형태로 요약한다", async () => {
  const { buildReport, encodeSubject, buildMimeMessage, buildHtmlReport, createSignedReviewUrl } = await import(
    "../scripts/build-daily-report.mjs"
  );

  const audit = {
    runs: [
      {
        consideredArticles: 306,
        appliedCount: 1,
        skippedCount: 305,
        primarySource: "google",
        applied: [
          {
            companyId: "hyundai-steel",
            companyLegalName: "현대제철 주식회사",
            previousStage: "S6",
            previousEventDate: "2026-08-01",
            nextStage: "S7",
            nextEventDate: "2026-08-11",
            sourceUrl: "https://example.com/article",
            sourceName: "매일노동뉴스",
            confidence: 0.91,
          },
        ],
        skippedReasonCounts: { scope_excluded: 256 },
      },
    ],
  };
  const batch = {
    stats: { totalQueries: 60, failedQueries: 0, receivedItems: 600, finalCandidates: 306 },
    articles: [
      { originalUrl: "https://example.com/article", title: "현대제철 임단협 조인식", media: "매일노동뉴스" },
    ],
  };

  const signedUrl = createSignedReviewUrl({
    siteUrl: "https://example.test/",
    secret: "test-secret",
    kind: "correction",
    id: "00000000-0000-4000-8000-000000000001",
    expires: 1_800_000_000,
  });
  const pendingReviews = [{ kind: "correction", label: "데이터 수정 · 현대제철 · 2026년", reviewUrl: signedUrl }];
  const report = buildReport({ audit, batch, todayKstDate: "2026-08-11", siteUrl: "https://example.test/", pendingReviews });
  assert.match(report.subject, /2026-08-11 수집 결과 · 반영 1건/);
  assert.match(report.text, /현대제철 주식회사/);
  assert.match(report.text, /S6 인준·서명 대기 → S7 최종 체결·발효/);
  // 감사 로그에 없는 제목은 후보 목록에서 찾아 붙인다.
  assert.match(report.text, /현대제철 임단협 조인식/);
  assert.match(report.text, /https:\/\/example\.com\/article/);
  assert.match(report.text, /관리자 확인 필요 \(1건\)/);
  assert.match(report.text, /\/admin\/review\?/);
  assert.match(signedUrl, /signature=[0-9a-f]{64}/);

  // 반영이 없는 날에도 "왜 안 바뀌었는지"를 알려준다.
  const quiet = buildReport({
    audit: { runs: [{ consideredArticles: 10, appliedCount: 0, skippedCount: 10, applied: [] }] },
    todayKstDate: "2026-08-11",
  });
  assert.match(quiet.text, /상태가 바뀐 교섭 없음/);

  // 실패한 날은 제목에서 바로 구분된다.
  assert.match(buildReport({ mode: "failure", todayKstDate: "2026-08-11" }).subject, /수집 실패/);

  // 지연 알림은 복구 명령을 함께 담는다.
  const staleness = buildReport({
    mode: "staleness",
    todayKstDate: "2026-08-11",
    heartbeat: { lastRunKstDate: "2026-08-08", lastRunOutcome: "success" },
    freshnessProblems: ["마지막 수집이 2026-08-08입니다."],
  });
  assert.match(staleness.subject, /수집 지연 감지/);
  assert.match(staleness.text, /force=true/);

  // 한국어 제목이 SMTP 경로에서 깨지지 않도록 인코딩한다.
  assert.match(encodeSubject("한글 제목"), /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  const message = buildMimeMessage({
    from: "sender@example.com",
    to: "receiver@example.com",
    subject: "한글 제목",
    text: "본문",
    html: buildHtmlReport({ text: report.text, pendingReviews }),
    date: new Date("2026-08-11T00:00:00Z"),
  });
  assert.match(message, /^From: sender@example\.com\r\nTo: receiver@example\.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(message, /Content-Type: multipart\/alternative/);
  assert.match(message, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(message, /Content-Type: text\/html; charset=UTF-8/);
  // 기사 본문을 담지 않는 경계는 메일에서도 유지한다.
  assert.match(report.text, /기사 본문은 담지 않습니다/);
});

test("60일 자동 비활성화를 막는 실행 흔적이 항상 커밋된다", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/daily-bargaining-update.yml", import.meta.url),
    "utf8",
  );
  // 수집·검증이 실패한 날에도 실행 흔적은 기록되고 커밋된다.
  assert.match(workflow, /실행 흔적 기록[\s\S]{0,80}if:\s*always\(\)/);
  assert.match(workflow, /변경 사항 커밋[\s\S]{0,80}if:\s*always\(\)/);
  assert.match(workflow, /git add data\/automation-heartbeat\.json/);
});

test("회귀 검증에 실패하면 사실 데이터를 커밋하지 않는다", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/daily-bargaining-update.yml", import.meta.url),
    "utf8",
  );
  // 검증 실패 시 사실 파일을 되돌린 뒤 실행 흔적만 남긴다.
  assert.match(
    workflow,
    /steps\.verify\.outcome[^\n]*!=[^\n]*success[\s\S]{0,400}git checkout --/,
  );
  // 배포는 회귀 검증 통과가 전제다.
  assert.match(
    workflow,
    /steps\.guard\.outputs\.needed == 'true' && steps\.verify\.outcome == 'success'/,
  );
  // 화면이 마지막 수집 시각을 표시하므로, 흔적을 기록한 뒤 다시 빌드해서 배포한다.
  assert.match(workflow, /npm run build\s*\n\s*npx wrangler deploy/);
  // 배포 자격증명이 없는 복제·포크에서는 데이터만 갱신하고 배포를 건너뛴다.
  assert.match(workflow, /if \[ -z "\$CLOUDFLARE_API_TOKEN" \]/);
  // 배포 토큰도 이름으로만 참조하고 로그로 내보내지 않는다.
  assert.doesNotMatch(workflow, /CLOUDFLARE_API_TOKEN\s*:\s*["'][^$]/);
});

test("실행 흔적 신선도 판정이 지연·실패·배포 중단을 구분한다", async () => {
  const { evaluateFreshness } = await import("../scripts/check-collection-freshness.mjs");

  const fresh = evaluateFreshness({
    heartbeat: { lastRunKstDate: "2026-08-11", lastRunOutcome: "success" },
    todayKstDate: "2026-08-11",
  });
  assert.equal(fresh.fresh, true);
  assert.deepEqual(fresh.problems, []);

  // 오늘 실행이 없으면 지연으로 잡는다. 이게 2026-08-11 아침에 놓친 상황이다.
  const stale = evaluateFreshness({
    heartbeat: { lastRunKstDate: "2026-08-09", lastRunOutcome: "success" },
    todayKstDate: "2026-08-11",
  });
  assert.equal(stale.fresh, false);
  assert.match(stale.problems.join(" "), /2일 지연/);

  // 실행은 됐지만 실패한 경우도 신선하지 않다.
  const failed = evaluateFreshness({
    heartbeat: { lastRunKstDate: "2026-08-11", lastRunOutcome: "failure" },
    todayKstDate: "2026-08-11",
  });
  assert.equal(failed.fresh, false);

  // 수집은 최신인데 공개 페이지에 그 날짜가 없으면 배포가 끊긴 것으로 구분한다.
  const notDeployed = evaluateFreshness({
    heartbeat: { lastRunKstDate: "2026-08-11", lastRunOutcome: "success" },
    todayKstDate: "2026-08-11",
    liveHtml: "<html>2026-08-09 기준</html>",
  });
  assert.equal(notDeployed.fresh, false);
  assert.match(notDeployed.problems.join(" "), /배포가 반영되지 않았을 수 있습니다/);

  // 한 번도 실행되지 않은 상태도 실패로 본다.
  assert.equal(evaluateFreshness({ heartbeat: {}, todayKstDate: "2026-08-11" }).fresh, false);
});

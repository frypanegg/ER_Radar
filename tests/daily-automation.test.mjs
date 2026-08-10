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
  selectCandidate,
} from "../scripts/apply-daily-update.mjs";

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

test("일일 자동화 워크플로가 KST 06:30 기준으로 등록되어 있다", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/daily-bargaining-update.yml", import.meta.url),
    "utf8",
  );
  // 21:30 UTC = 06:30 KST(다음 날)
  assert.match(workflow, /cron:\s*["']30 21 \* \* \*["']/);
  assert.match(workflow, /collect-news\.mjs/);
  assert.match(workflow, /apply-daily-update\.mjs/);
  assert.match(workflow, /npm test/);
  // 비밀값은 이름으로만 참조하고 로그로 내보내지 않는다.
  assert.doesNotMatch(workflow, /NAVER_API_HUB_CLIENT_SECRET\s*:\s*["'][^$]/);
});

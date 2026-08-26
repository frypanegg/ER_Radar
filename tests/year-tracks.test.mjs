import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildYearTracks,
  compareSettlementPace,
  summarizeSettlementSeason,
} from "../app/bargaining-history.ts";

const record = (year, stage, eventDate, flowEvents = []) => ({
  bargainingYear: year,
  agreementType: "INTEGRATED",
  stage,
  eventDate,
  title: `${year}년 교섭`,
  flowEvents,
});

test("연도는 최신부터 내려온다", () => {
  const tracks = buildYearTracks([record(2024, "S7", "2024-09-10"), record(2026, "S5", "2026-08-25")]);
  assert.deepEqual(tracks.map((track) => track.year), [2026, 2024]);
});

test("타결 시점은 경과에서 잠정합의 이상이 처음 나온 날이다", () => {
  // 대표 사건일만 보면 조인식 날짜가 잡혀 잠정합의보다 늦게 찍힌다.
  const [track] = buildYearTracks([
    record(2025, "S7", "2025-09-17", [
      { date: "2025-06-18", stage: "S3", label: "상견례", summary: "", sourceUrl: "" },
      { date: "2025-09-09", stage: "S5", label: "잠정합의", summary: "", sourceUrl: "" },
      { date: "2025-09-17", stage: "S7", label: "조인", summary: "", sourceUrl: "" },
    ]),
  ]);
  assert.equal(track.settledOn, "2025-09-09");
});

test("이듬해로 넘어간 타결도 축 안에 들어온다", () => {
  // 은행은 이듬해 2월에 타결한다. 12개월 축이면 밖으로 밀려난다.
  const [track] = buildYearTracks([record(2025, "S6", "2026-02-01")]);
  assert.ok(track.settledOffset !== null && track.settledOffset > 90 && track.settledOffset <= 100,
    `이듬해 2월이 축 안에 있어야 한다: ${track.settledOffset}`);
});

test("예년 타결 시기는 두 해 이상 확인됐을 때만 말한다", () => {
  const one = buildYearTracks([record(2025, "S7", "2025-09-10")]);
  assert.equal(summarizeSettlementSeason(one), null);

  const many = buildYearTracks([
    record(2025, "S7", "2025-12-11"),
    record(2024, "S6", "2024-12-20"),
    record(2023, "S6", "2023-12-21"),
  ]);
  assert.equal(summarizeSettlementSeason(many).label, "12월");
});

test("올해는 예년에서 뺀다", () => {
  const tracks = buildYearTracks([
    record(2026, "S5", "2026-03-02"),
    record(2025, "S7", "2025-09-10"),
    record(2024, "S7", "2024-08-10"),
  ]);
  assert.equal(summarizeSettlementSeason(tracks, { excludeYear: 2026 }).label, "8~9월");
});

test("직전 확인 연도와 견준 진도를 날짜 차이로만 말한다", () => {
  const tracks = buildYearTracks([
    record(2026, "S5", "2026-08-25"),
    record(2025, "S5", "2025-08-04"),
  ]);
  const pace = compareSettlementPace(tracks, 2026);
  assert.equal(pace.previousYear, 2025);
  assert.equal(pace.days, 21);
  assert.equal(pace.label, "3주 늦음");
});

test("타결하지 않은 해는 견줄 대상이 아니다", () => {
  const tracks = buildYearTracks([record(2026, "S3", "2026-08-04"), record(2025, "S7", "2025-09-10")]);
  assert.equal(compareSettlementPace(tracks, 2026), null);
});

test("공개 시드에서 실제로 겹쳐 그릴 수 있는 법인이 있다", async () => {
  const [historical, current] = await Promise.all([
    readFile(new URL("../data/historical-fact-seed.json", import.meta.url), "utf8"),
    readFile(new URL("../data/current-2026-fact-seed.json", import.meta.url), "utf8"),
  ]);
  const all = [...JSON.parse(historical).records, ...JSON.parse(current).records];

  const byCompany = new Map();
  for (const row of all) {
    byCompany.set(row.companyId, [...(byCompany.get(row.companyId) ?? []), row]);
  }

  const drawable = [...byCompany.values()]
    .map((rows) => buildYearTracks(rows))
    .filter((tracks) => summarizeSettlementSeason(tracks) !== null);

  assert.ok(drawable.length >= 10, `겹쳐 그릴 수 있는 법인이 너무 적다: ${drawable.length}곳`);
});


test("타결 조건은 잠정합의 이상에만 붙는다", async () => {
  // 요약문에서 정규식으로 뽑던 방식은 요구안과 거부된 제시안까지 "타결 조건"으로 잡았다.
  // 예정·주장과 발생을 가르는 것이 이 대시보드의 전제라 그 실수는 특히 나쁘다.
  // 이제는 원문에서 확인한 것만 레코드에 적으므로, 타결 전 단계에 붙어 있으면 잘못이다.
  const [historical, current] = await Promise.all([
    readFile(new URL("../data/historical-fact-seed.json", import.meta.url), "utf8"),
    readFile(new URL("../data/current-2026-fact-seed.json", import.meta.url), "utf8"),
  ]);
  const all = [...JSON.parse(historical).records, ...JSON.parse(current).records];
  const withTerms = all.filter((row) => Array.isArray(row.settlementTerms) && row.settlementTerms.length > 0);

  assert.ok(withTerms.length > 0, "타결 조건이 적힌 레코드가 있어야 한다");

  const settledStages = new Set(["S5", "S6", "S7"]);
  const premature = withTerms
    .filter((row) => !settledStages.has(row.stage))
    .map((row) => `${row.companyId}|${row.bargainingYear}|${row.stage}`);
  assert.deepEqual(premature, [], `타결 전 단계에 타결 조건이 붙어 있다: ${premature.join(", ")}`);

  const malformed = withTerms.flatMap((row) =>
    row.settlementTerms
      .filter((term) => !term.field?.trim() || !term.value?.trim())
      .map(() => `${row.companyId}|${row.bargainingYear}`),
  );
  assert.deepEqual(malformed, [], `field·value가 빈 타결 조건이 있다: ${malformed.join(", ")}`);
});

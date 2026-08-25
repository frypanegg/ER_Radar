import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildStageTimeline } from "../app/bargaining-history.ts";

const event = (date, stage, label = stage) => ({ date, stage, label, summary: `${label} 확인` });

test("같은 단계가 이어지면 한 구간으로 접힌다", () => {
  const timeline = buildStageTimeline(
    [
      event("2026-04-28", "S4", "부분파업"),
      event("2026-05-01", "S4", "전면파업"),
      event("2026-05-06", "S4", "준법투쟁"),
    ],
    { asOf: "2026-08-25" },
  );

  assert.equal(timeline.segments.length, 1);
  const [segment] = timeline.segments;
  assert.equal(segment.stage, "S4");
  assert.equal(segment.startDate, "2026-04-28");
  // 진행 중인 구간의 끝은 기준일이다.
  assert.equal(segment.endDate, "2026-08-25");
  assert.equal(segment.events.length, 3);
  assert.equal(segment.isCurrent, true);
});

// 되돌아간 단계를 합치면 왕복이 사라진다. 기아 2026년이 실제로 S3에서 S4로 갔다가
// 다시 S3으로 돌아왔고, 그 왕복 자체가 읽혀야 하는 사실이다.
test("단계가 되돌아가면 새 구간을 연다", () => {
  const timeline = buildStageTimeline(
    [
      event("2026-07-15", "S3"),
      event("2026-07-20", "S4"),
      event("2026-07-23", "S4"),
      event("2026-08-24", "S3"),
    ],
    { asOf: "2026-08-25" },
  );

  assert.deepEqual(
    timeline.segments.map((segment) => segment.stage),
    ["S3", "S4", "S3"],
  );
  assert.deepEqual(
    timeline.segments.map((segment) => segment.startDate),
    ["2026-07-15", "2026-07-20", "2026-08-24"],
  );
  // 앞 구간의 끝은 다음 구간의 시작이다. 전환 날짜가 두 번 적히지 않아야 한다.
  assert.equal(timeline.segments[0].endDate, timeline.segments[1].startDate);
  assert.equal(timeline.segments[1].endDate, timeline.segments[2].startDate);
  assert.equal(timeline.segments[2].isCurrent, true);
});

test("구간 비율을 모두 더하면 100이 된다", () => {
  const timeline = buildStageTimeline(
    [event("2026-01-01", "S1"), event("2026-03-01", "S3"), event("2026-06-01", "S4")],
    { asOf: "2026-08-25" },
  );
  const total = timeline.segments.reduce((sum, segment) => sum + segment.share, 0);
  assert.ok(Math.abs(total - 100) < 0.001, `비율 합계가 100이 아니다: ${total}`);
});

// 같은 날 단계가 바뀌면 길이가 0이 되고, 그대로 두면 차트에서 구간이 사라진다.
test("같은 날 전환한 구간도 차트에서 사라지지 않는다", () => {
  const timeline = buildStageTimeline(
    [event("2026-03-05", "S6"), event("2026-03-05", "S7")],
    { asOf: "2026-03-05" },
  );
  assert.equal(timeline.segments.length, 2);
  assert.ok(timeline.segments.every((segment) => segment.days >= 1));
});

// 기준일을 그냥 믿으면 마지막 사건이 그보다 뒤일 때 길이가 음수가 된다.
test("기준일보다 늦은 사건이 있으면 그 사건이 끝이다", () => {
  const timeline = buildStageTimeline([event("2026-08-20", "S5")], { asOf: "2026-08-01" });
  assert.equal(timeline.endDate, "2026-08-20");
  assert.ok(timeline.segments[0].days >= 1);
});

test("경과가 없으면 타임라인을 만들지 않는다", () => {
  assert.equal(buildStageTimeline([], { asOf: "2026-08-25" }), null);
  assert.equal(buildStageTimeline(undefined, { asOf: "2026-08-25" }), null);
});

// 공개 시드 전량이 타임라인으로 접히는지 본다. 경과가 있는 기록은 구간이 하나 이상
// 나와야 하고, 구간 경계는 반드시 이어져 있어야 한다.
test("공개 시드의 모든 경과가 끊김 없는 구간으로 접힌다", async () => {
  for (const file of ["current-2026-fact-seed.json", "historical-fact-seed.json"]) {
    const seed = JSON.parse(await readFile(new URL(`../data/${file}`, import.meta.url), "utf8"));
    for (const record of seed.records) {
      const timeline = buildStageTimeline(record.flowEvents, { asOf: seed.asOf ?? "2026-08-25" });
      if (!timeline) continue;
      assert.ok(timeline.segments.length > 0, `${record.companyId} 구간이 비었다`);
      for (let index = 1; index < timeline.segments.length; index += 1) {
        assert.equal(
          timeline.segments[index - 1].endDate,
          timeline.segments[index].startDate,
          `${record.companyId} 구간 경계가 끊겼다`,
        );
      }
      assert.equal(timeline.segments[timeline.segments.length - 1].isCurrent, true);
    }
  }
});

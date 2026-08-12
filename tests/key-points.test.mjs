import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { toKeyPoints } from "../app/key-points.ts";

test("서술식 요약을 개조식 항목으로 바꾼다", () => {
  assert.deepEqual(
    toKeyPoints(
      "포스코노동조합은 7월 23일 본교섭 결렬 뒤 7월 27일 중앙노동위원회에 노동쟁의 조정을 신청했다. " +
        "기사상 미합의 쟁점은 임금·복지와 현장 안전, 인력·설비 문제이며, 조정 기간에도 교섭을 이어갈 수 있다고 밝혔다.",
    ),
    [
      "포스코노동조합은 7월 23일 본교섭 결렬 뒤 7월 27일 중앙노동위원회에 노동쟁의 조정 신청",
      "기사상 미합의 쟁점은 임금·복지와 현장 안전, 인력·설비 문제",
      "조정 기간에도 교섭을 이어갈 수 있음",
    ],
  );
});

test("조사를 서술어 안쪽에서 잘라내지 않는다", () => {
  // '찬성으로 가결됐다'의 '가'를 주격조사로 읽으면 '찬성으로 결'이 되어 뜻이 사라진다.
  assert.deepEqual(toKeyPoints("잠정합의안이 찬성 56.8%로 가결됐다."), [
    "잠정합의안이 찬성 56.8%로 가결",
  ]);
  // 부정 보조용언도 마찬가지다. '좁히지 못'이 되면 안 된다.
  assert.deepEqual(toKeyPoints("핵심 요구안의 견해차를 좁히지 못했다."), [
    "핵심 요구안의 견해차를 좁히지 못함",
  ]);
});

test("출처를 밝히는 인용절은 항목에서 뺀다", () => {
  // 원문은 별도 카드에서 보여주므로 개조식 항목에는 남기지 않는다.
  assert.deepEqual(toKeyPoints("노조가 3차 부분파업에 들어갔다고 보도됐다."), [
    "노조가 3차 부분파업 돌입",
  ]);
});

test("이미 개조식으로 적어 둔 문자열은 그대로 둔다", () => {
  assert.deepEqual(
    toKeyPoints("현재 확인한 기사에 확인된 결렬 사유 없음 · 원문 명시 시에만 별도 쟁점 갱신"),
    ["현재 확인한 기사에 확인된 결렬 사유 없음", "원문 명시 시에만 별도 쟁점 갱신"],
  );
});

test("공개 사실 데이터 전량이 개조식으로 변환된다", async () => {
  // 규칙에 걸리지 않는 문장은 서술식 그대로 남는다. 데이터가 늘어 새로운 종결어미가
  // 들어오면 여기서 먼저 드러나야 한다.
  const leftovers = [];
  for (const file of ["current-2026-fact-seed.json", "historical-fact-seed.json"]) {
    const seed = JSON.parse(
      await readFile(new URL(`../data/${file}`, import.meta.url), "utf8"),
    );
    for (const record of seed.records) {
      for (const point of toKeyPoints(record.factSummary)) {
        // 서술식 종결어미가 남았거나, 어간만 남아 잘렸거나, 공백이 깨진 항목
        if (/다$/.test(point) || /(?:았|었|였|했)$/.test(point) || /\s{2,}/.test(point)) {
          leftovers.push(`${record.companyId}|${record.bargainingYear}: ${point}`);
        }
      }
    }
  }
  assert.deepEqual(leftovers, [], `개조식으로 바뀌지 않은 항목이 있다:\n${leftovers.join("\n")}`);
});

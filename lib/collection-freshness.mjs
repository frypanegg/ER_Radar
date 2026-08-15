// 수집 상태를 화면과 회귀 테스트가 같은 규칙으로 읽게 만드는 단일 출처.
//
// 이 규칙이 app/page.tsx 안에만 있던 동안 회귀 테스트는 화면에 찍히는 기준일을
// 문자열로 박아 두고 검사했다. 사실이 실제로 반영되는 날 기준일이 올라가면서
// 테스트가 깨졌고, 그날 수집한 사실이 통째로 되돌려졌다. 규칙을 여기로 끌어내
// 화면과 테스트가 같은 함수를 부르게 한다.

/** 시드가 사실을 마지막으로 검증한 날. 시드에 asOf가 없을 때의 바닥값이다. */
export const FALLBACK_SEED_AS_OF = "2026-08-10";

/**
 * @typedef {object} AutomationHeartbeat
 * @property {string} [lastRunKstDate]
 * @property {string} [lastRunOutcome]
 * @property {string} [collectOutcome]
 * @property {string} [verifyOutcome]
 */

/**
 * 화면에 쓰는 "기준일"을 정한다.
 *
 * 시드의 asOf는 사실을 마지막으로 검증한 날이고, 수집 흔적은 마지막으로 확인한
 * 날이다. 수집이 성공한 날은 그날까지 사실이 확인된 것이므로 기준일을 올린다.
 * 검증에 막혀 되돌린 날은 공개 사실이 그대로이므로 기준일도 올리지 않는다.
 *
 * @param {{ seedAsOf?: string | null, heartbeat?: AutomationHeartbeat | null }} input
 * @returns {string}
 */
export function resolveCurrentAsOf({ seedAsOf, heartbeat }) {
  const base = seedAsOf ?? FALLBACK_SEED_AS_OF;
  const lastRun = heartbeat?.lastRunKstDate ?? null;
  const succeeded = heartbeat?.lastRunOutcome === "success";
  return succeeded && lastRun && lastRun > base ? lastRun : base;
}

/**
 * 마지막 수집 상태를 한 줄로 설명한다.
 *
 * 수집이 멈춰도 화면이 평소와 똑같으면 사람은 멈춘 걸 알 수 없다. 그래서 지연을
 * 드러낸다. 다만 "지연"과 "실패"는 다른 사건이고, 실패 중에서도 기사를 못 모은
 * 날과 다 모으고 회귀 검증에 막힌 날은 사람이 해야 할 일이 다르다. 셋을 구분한다.
 *
 * @param {{ heartbeat?: AutomationHeartbeat | null, todayKstDate: string }} input
 * @returns {{ tone: "fresh" | "warn" | "stale", text: string }}
 */
export function describeCollectionLag({ heartbeat, todayKstDate }) {
  const lastKstDate = heartbeat?.lastRunKstDate ?? null;
  if (!lastKstDate) return { tone: "stale", text: "수집 기록 없음" };

  const lagDays = Math.round(
    (Date.parse(`${todayKstDate}T00:00:00Z`) - Date.parse(`${lastKstDate}T00:00:00Z`)) / 86_400_000,
  );
  if (Number.isNaN(lagDays)) return { tone: "stale", text: "수집 기록 확인 불가" };

  const outcome = heartbeat?.lastRunOutcome ?? null;
  if (outcome && outcome !== "success") {
    // 기사는 다 모았는데 회귀 검증이 막은 날이 실패의 대부분이다. 그냥 "실패"라고
    // 적으면 수집이 아예 안 돈 날과 구분되지 않아서, 사람이 수집기를 들여다보게 된다.
    // 실제로 봐야 하는 것은 그날 반영하려던 사실과 검증 로그다.
    const collected = heartbeat?.collectOutcome === "success";
    const verifyBlocked = heartbeat?.verifyOutcome && heartbeat.verifyOutcome !== "success";
    if (collected && verifyBlocked) {
      return { tone: "stale", text: `${lastKstDate} 수집됨 · 검증에 막혀 미반영` };
    }
    return { tone: "stale", text: `마지막 수집 실패 (${lastKstDate})` };
  }

  if (lagDays <= 0) return { tone: "fresh", text: `오늘 수집 완료 (${lastKstDate} KST)` };
  if (lagDays === 1) return { tone: "warn", text: `마지막 수집 ${lastKstDate} · 1일 지연` };
  return { tone: "stale", text: `마지막 수집 ${lastKstDate} · ${lagDays}일 지연` };
}

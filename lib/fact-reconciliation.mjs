// 공개 화면이 DB 행과 시드 레코드 중 무엇으로 그릴지 고른다.
//
// 화면은 하이드레이션 뒤 /api/published-facts로 DB를 읽어 같은 법인·연도의 시드
// 레코드를 덮어썼다. 그런데 일일 수집은 시드에만 쓴다. DB는 사람이 정정을 승인하거나
// "공개 시드 Supabase 적재"를 손으로 돌릴 때만 바뀐다. 그래서 매일 수집이 성공해도
// 그 결과가 화면에 닿지 못했다. 실제로 2026-08-19 이후 수집한 현대차 사건(08-20,
// 08-23)이 08-19에서 멈춘 DB 행에 계속 가려졌다.
//
// 어느 한쪽을 항상 이기게 두면 반대쪽 사실을 잃는다. DB에만 있는 정정(sk하이닉스
// S5, 포스코·기아의 최신 사건)은 시드에 없고, 시드에만 있는 수집 결과는 DB에 없다.
// 그래서 "더 최근에 확인된 쪽"을 고른다.

/** U는 좌표 미확인이라 가장 앞, S0~S7은 숫자 순서를 그대로 쓴다. */
export function stageRank(stage) {
  if (!stage || stage === "U") return -1;
  const rank = Number.parseInt(String(stage).slice(1), 10);
  return Number.isFinite(rank) ? rank : -1;
}

/**
 * 그 기록에서 마지막으로 확인된 사실의 날짜. 대표 사건만 보면 경과에 더 늦은 사건이
 * 들어온 쪽이 낡은 것으로 잘못 판정된다.
 */
export function latestEvidenceDate(record) {
  let latest = record?.eventDate ?? "";
  for (const event of record?.flowEvents ?? []) {
    if (event?.date && event.date > latest) latest = event.date;
  }
  return latest;
}

/**
 * 무엇으로 그릴지 정한다.
 *
 *  - "db"   : DB 행으로 덮어쓴다. DB가 시드보다 낡지 않은 보통의 경우다.
 *  - "seed" : 시드가 더 최근 근거를 갖고 있으므로 시드를 그대로 둔다.
 *
 * 예외가 하나 있다. 제목 기반 자동 수집 기록은 사람이 검증한 DB 단계를 뒤로
 * 돌리지 못한다. 파업·집회 보도는 교섭이 진행 중이라는 신호를 함께 담기 때문에,
 * 잠정합의(S5)가 확인된 교섭에 본교섭(S3) 제목이 하루 늦게 붙는 일이 실제로
 * 생긴다. 그때 시드가 이기면 사람이 확인한 단계가 제목 하나로 내려간다.
 * 날짜가 더 최근이어도 단계는 DB 것을 쓴다.
 */
export function decideFactSource({ seed, fact }) {
  if (!fact) return { use: "seed", reason: "db_row_missing" };

  const seedDate = latestEvidenceDate(seed);
  const factDate = latestEvidenceDate(fact);
  if (!seedDate || seedDate <= factDate) return { use: "db", reason: "db_not_older" };

  const titleBasis = seed?.factualStatus === "AUTO_COLLECTED_TITLE_BASIS";
  if (titleBasis && stageRank(seed?.stage) < stageRank(fact?.stage)) {
    return { use: "db", reason: "title_basis_cannot_lower_verified_stage" };
  }

  return { use: "seed", reason: "seed_has_newer_evidence" };
}

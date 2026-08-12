/**
 * 서술식 요약문을 개조식 항목으로 바꾼다.
 *
 * 사실 데이터의 factSummary는 원문 근거를 문장으로 적어 둔 서술식이다. 화면의 점검
 * 카드는 한눈에 훑는 자리라 개조식이 맞는데, 종전 toBulletPoints는 문장 경계로 자르기만
 * 해서 서술식이 그대로 남았다.
 *
 * 문장을 새로 쓰지는 않는다. 출처를 밝히는 인용절을 걷어내고 종결어미를 명사형으로
 * 바꾸는 것까지만 한다. 없는 사실을 만들지 않는 것이 이 화면의 전제라, 규칙에 걸리지
 * 않는 문장은 손대지 않고 그대로 둔다.
 */

/** 출처를 밝히는 인용절. 원문은 별도 카드에서 보여주므로 항목에서는 뺀다. */
const ATTRIBUTION_TAIL =
  /\s*(?:라)?고\s*(?:보도됐|보도되었|보도한|밝혔|밝힌|전했|전한|말했|공지했|공지한|덧붙였|알렸)다$/;

/** 문장 앞에 붙는 전언 표지. */
const ATTRIBUTION_HEAD = /^(?:보도에\s*따르면|기사에\s*따르면|공시에\s*따르면)\s*/;

/**
 * 부정 보조용언은 아래 한자어 규칙에 넘기면 안 된다. "좁히지 못했다"가 "좁히지 못"이
 * 되어 뜻이 잘린다.
 */
const NEGATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/못했다$/, "못함"],
  [/않았다$/, "않음"],
  [/못한다$/, "못함"],
  [/않는다$/, "않음"],
];

/**
 * 자주 나오는 고유어 서술어를 대응하는 명사로 바꾼다. 한자어 서술어는 아래 일반
 * 규칙이 처리하므로 여기에는 그 규칙으로 어색해지는 것만 둔다.
 */
const PREDICATE_NOUNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:을|를)?\s*열었다$/, " 개최"],
  [/(?:에|으로)?\s*들어갔다$/, " 돌입"],
  [/(?:에|으로)?\s*들어간다$/, " 돌입"],
  [/(?:이|가)?\s*이어졌다$/, " 지속"],
  [/(?:이|가)?\s*나왔다$/, " 제시"],
  [/(?<=[가-힣])(?:을|를)\s+이뤘다$/, ""],
];

/**
 * 한자어 서술어를 명사로 되돌린다. "조정을 신청했다"에서 "조정 신청"을 얻는 것이
 * 목적이라, 목적어 조사는 지우고 서술어의 어간만 남긴다.
 *
 * 조사 앞뒤를 모두 고정한다. 앞의 lookbehind가 없으면 "찬성으로 가결됐다"의 '가'를
 * 주격조사로 읽어 "찬성으로 결"이 되고, 뒤의 공백을 강제하지 않으면 같은 일이 조사
 * 없는 서술어에서도 일어난다.
 */
const SINO_PREDICATES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<=[가-힣])(?:을|를)\s+([가-힣]{1,8})(?:했|하였)다$/, " $1"],
  [/(?<=[가-힣])(?:이|가)\s+([가-힣]{1,8})(?:됐|되었)다$/, " $1"],
  [/([가-힣]{1,8})(?:했|하였)다$/, "$1"],
  [/([가-힣]{1,8})(?:됐|되었)다$/, "$1"],
  [/([가-힣]{1,8})된다$/, "$1"],
  [/([가-힣]{1,8})한다$/, "$1"],
];

/** 위 규칙에 걸리지 않는 서술어는 명사형 어미로 바꿔 개조식을 맞춘다. */
const NOMINALIZATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/이다$/, ""],
  [/있다$/, "있음"],
  [/없다$/, "없음"],
  [/했다$/, "함"],
  [/였다$/, "임"],
  [/았다$/, "았음"],
  [/었다$/, "었음"],
  [/나온다$/, "나옴"],
  // 연결어미를 끊고 남은 어간. "이어졌으며,"를 나누면 "이어졌"만 남는다.
  [/(?<=[가-힣])(?:았|었|였|했)$/, "$&음"],
];

/** 독립된 사실 두 개를 잇는 연결어미. 개조식에서는 항목을 나눈다. */
const CLAUSE_SPLIT = /(?<=[가-힣])(?:이며|으며|며),\s*|(?<=[가-힣])(?:으나|나),\s*/;

function stripTrailingPunctuation(text: string) {
  return text.replace(/[.\s]+$/, "");
}

/** 한 절을 개조식 한 항목으로 바꾼다. */
function toKeyPoint(clause: string) {
  let point = stripTrailingPunctuation(clause.trim());
  if (!point) return "";

  point = point.replace(ATTRIBUTION_HEAD, "");

  // 인용절은 여러 겹으로 붙기도 한다. "…라고 밝혔다고 보도됐다" 같은 경우다.
  let stripped = point.replace(ATTRIBUTION_TAIL, "");
  while (stripped !== point) {
    point = stripTrailingPunctuation(stripped);
    stripped = point.replace(ATTRIBUTION_TAIL, "");
  }

  for (const [pattern, replacement] of NEGATIONS) {
    if (pattern.test(point)) return point.replace(pattern, replacement).trim();
  }
  for (const [pattern, replacement] of PREDICATE_NOUNS) {
    if (pattern.test(point)) return point.replace(pattern, replacement).trim();
  }
  for (const [pattern, replacement] of SINO_PREDICATES) {
    if (pattern.test(point)) return point.replace(pattern, replacement).trim();
  }
  for (const [pattern, replacement] of NOMINALIZATIONS) {
    if (pattern.test(point)) return point.replace(pattern, replacement).trim();
  }
  return point;
}

/**
 * 서술식 요약을 개조식 항목 목록으로 바꾼다. 이미 개조식으로 적어 둔 문자열은
 * ` · `로 항목을 나눠 두었으므로 그 경계도 함께 본다.
 */
export function toKeyPoints(text: string): string[] {
  return text
    .split(/(?<=다\.)\s+|\s+·\s+/)
    .flatMap((sentence) => sentence.split(CLAUSE_SPLIT))
    .map((clause) => toKeyPoint(clause ?? ""))
    .filter(Boolean);
}

// Google News RSS 링크를 발행사 원문 URL로 되돌리고, 그 URL이 실제로 살아 있는지
// 확인한다. NAVER API 자격증명 없이도 원문 URL 근거를 확보하기 위한 경로다.
//
// RSS가 주는 링크는 news.google.com/rss/articles/CBMi... 형태이며 HTTP 리다이렉트가
// 아니라 페이지 내부 스크립트로 최종 주소를 만든다. 그래서 다음 두 단계를 거친다.
//   1) 기사 페이지에서 data-n-a-id / -ts / -sg 서명 값을 읽는다.
//   2) 같은 서명으로 batchexecute RPC를 호출해 발행사 URL을 받는다.
// 헤드리스 브라우저 없이 fetch만으로 동작한다.

const GOOGLE_NEWS_HOSTS = new Set(["news.google.com"]);
const BATCH_EXECUTE_ENDPOINT =
  "https://news.google.com/_/DotsSplashUi/data/batchexecute";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const RESOLUTION_STATUS = {
  notGoogle: "NOT_GOOGLE",
  signatureMissing: "SIGNATURE_NOT_FOUND",
  resolutionFailed: "RESOLUTION_FAILED",
  unreachable: "RESOLVED_UNREACHABLE",
  titleMismatch: "RESOLVED_TITLE_MISMATCH",
  verified: "RESOLVED_AND_REACHABLE",
};

// 제목 대조에서 의미를 갖지 않는 조사·상투어. 이것만 겹치면 같은 기사로 보지 않는다.
const TITLE_STOPWORDS = new Set([
  "그리고",
  "그러나",
  "관련",
  "기자",
  "단독",
  "속보",
  "종합",
  "영상",
  "포토",
  "뉴스",
  "오늘",
  "내일",
  "올해",
]);

function isGoogleNewsUrl(value) {
  try {
    return GOOGLE_NEWS_HOSTS.has(new URL(value).hostname.replace(/^www\./, ""));
  } catch {
    return false;
  }
}

function extractSignature(html) {
  const id = html.match(/data-n-a-id="([^"]+)"/)?.[1];
  const timestamp = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  const signature = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  if (!id || !timestamp || !signature) return null;
  return { id, timestamp: Number(timestamp), signature };
}

function buildBatchExecuteBody({ id, timestamp, signature }) {
  const request = JSON.stringify([
    "garturlreq",
    [
      [
        "en-US",
        "US",
        ["FINANCE_TOP_INDICES", "WEB_TEST_1_0_0"],
        null,
        null,
        1,
        1,
        "US:en",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        null,
        null,
        [1608992183, 723341000],
      ],
      "en-US",
      "US",
      1,
      [2, 3, 4, 8],
      1,
      0,
      "655000234",
      0,
      0,
      null,
      0,
    ],
    id,
    timestamp,
    signature,
  ]);
  return `f.req=${encodeURIComponent(
    JSON.stringify([[["Fbv4je", request, null, "generic"]]]),
  )}`;
}

function extractResolvedUrl(payload) {
  // 응답은 이스케이프된 JSON 스트림이다. 쿼리스트링을 가진 주소는 `=`가 =,
  // `&`가 &로 들어오므로 먼저 되돌리지 않으면 URL이 물음표 뒤에서 잘린다.
  // 원문 URL은 JSON 문자열 안의 JSON 문자열이라 역슬래시가 겹쳐 들어온다.
  // (`?idxno\\u003d85080`) 그래서 역슬래시 개수를 가리지 않고 되돌린다.
  const decoded = payload
    .replace(/\\+u([0-9a-fA-F]{4})/g, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\+\//g, "/");
  // 구글 자신을 가리키지 않는 첫 http(s) 주소를 발행사 원문으로 본다.
  const match = decoded.match(/https?:\/\/(?!news\.google\.com)[^"\\\s]+/);
  return match ? match[0] : null;
}

// 한글·영문·숫자 토큰만 남긴다. 발행사 페이지 제목은 접두·접미 장식이 붙는 경우가 많아
// 완전 일치 대신 의미 토큰의 겹침 비율로 같은 기사인지 판정한다.
function titleTokens(value) {
  return new Set(
    String(value ?? "")
      .replace(/[^\p{Script=Hangul}\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !TITLE_STOPWORDS.has(token)),
  );
}

function titleOverlapRatio(feedTitle, pageTitle) {
  const feedTokens = titleTokens(feedTitle);
  if (feedTokens.size === 0) return 0;
  const pageText = String(pageTitle ?? "");
  let matched = 0;
  for (const token of feedTokens) {
    if (pageText.includes(token)) matched += 1;
  }
  return Number((matched / feedTokens.size).toFixed(3));
}

function extractPageTitle(html) {
  const ogTitle = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  )?.[1];
  const documentTitle = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1];
  return [ogTitle, documentTitle].filter(Boolean).join(" | ").trim();
}

async function fetchText(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.text();
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * RSS 링크 하나를 발행사 원문 URL로 되돌리고 도달 가능성과 제목 일치를 확인한다.
 * 실패해도 예외를 던지지 않고 상태 코드로 알린다. 호출자는 검증 실패를 공개 반영
 * 차단 사유로만 쓰고 기존 확정 상태는 건드리지 않는다.
 */
export async function resolveGoogleNewsUrl(url, feedTitle, options = {}) {
  const {
    timeoutMs = 20_000,
    minimumTitleOverlap = 0.4,
    canonicalize = (value) => value,
    inferMedia = () => null,
  } = options;
  const verifiedAt = new Date().toISOString();
  const base = {
    method: "google-news-batchexecute",
    originalUrl: null,
    httpStatus: null,
    resolvedMedia: null,
    titleOverlap: null,
    verifiedAt,
  };

  if (!isGoogleNewsUrl(url)) {
    return { ...base, status: RESOLUTION_STATUS.notGoogle, originalUrl: url };
  }

  let signature;
  try {
    const { body } = await fetchText(
      url,
      { headers: { "User-Agent": BROWSER_USER_AGENT } },
      timeoutMs,
    );
    signature = extractSignature(body);
  } catch {
    signature = null;
  }
  if (!signature) {
    return { ...base, status: RESOLUTION_STATUS.signatureMissing };
  }

  let resolvedUrl = null;
  try {
    const { body } = await fetchText(
      BATCH_EXECUTE_ENDPOINT,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": BROWSER_USER_AGENT,
        },
        body: buildBatchExecuteBody(signature),
      },
      timeoutMs,
    );
    resolvedUrl = extractResolvedUrl(body);
  } catch {
    resolvedUrl = null;
  }
  if (!resolvedUrl) {
    return { ...base, status: RESOLUTION_STATUS.resolutionFailed };
  }

  const originalUrl = canonicalize(resolvedUrl) ?? resolvedUrl;
  const resolvedMedia = inferMedia(originalUrl);

  let httpStatus = null;
  let pageTitle = "";
  try {
    const { response, body } = await fetchText(
      originalUrl,
      { headers: { "User-Agent": BROWSER_USER_AGENT } },
      timeoutMs,
    );
    httpStatus = response.status;
    pageTitle = extractPageTitle(body);
  } catch {
    httpStatus = null;
  }
  if (!httpStatus || httpStatus >= 400) {
    return {
      ...base,
      status: RESOLUTION_STATUS.unreachable,
      originalUrl,
      httpStatus,
      resolvedMedia,
    };
  }

  const titleOverlap = titleOverlapRatio(feedTitle, pageTitle);
  if (titleOverlap < minimumTitleOverlap) {
    return {
      ...base,
      status: RESOLUTION_STATUS.titleMismatch,
      originalUrl,
      httpStatus,
      resolvedMedia,
      titleOverlap,
    };
  }

  return {
    ...base,
    status: RESOLUTION_STATUS.verified,
    originalUrl,
    httpStatus,
    resolvedMedia,
    titleOverlap,
  };
}

export {
  RESOLUTION_STATUS,
  buildBatchExecuteBody,
  extractPageTitle,
  extractResolvedUrl,
  extractSignature,
  isGoogleNewsUrl,
  titleOverlapRatio,
};

#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESOLUTION_STATUS,
  resolveGoogleNewsUrl,
} from "./resolve-google-news.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIRECTORY = dirname(SCRIPT_PATH);
const PROJECT_ROOT = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_CONFIG_PATH = resolve(PROJECT_ROOT, "data/source-config.json");
const DEFAULT_OUTPUT_PATH = resolve(
  PROJECT_ROOT,
  "public/data/news-candidates.json",
);
const USER_AGENT =
  "KoreaCollectiveBargainingDashboard/1.0 (+daily metadata collection)";
const DAY_IN_MILLISECONDS = 86_400_000;
const LOCK_STALE_AFTER_MILLISECONDS = 2 * 60 * 60 * 1_000;

const KNOWN_MEDIA_BY_HOST = [
  ["yna.co.kr", "연합뉴스"],
  ["newsis.com", "뉴시스"],
  ["news1.kr", "뉴스1"],
  ["labortoday.co.kr", "매일노동뉴스"],
  ["laborplus.co.kr", "참여와혁신"],
  ["worklaw.co.kr", "월간노동법률"],
  ["mk.co.kr", "매일경제"],
  ["hankyung.com", "한국경제"],
  ["sedaily.com", "서울경제"],
  ["edaily.co.kr", "이데일리"],
  ["fnnews.com", "파이낸셜뉴스"],
  ["mt.co.kr", "머니투데이"],
  ["etnews.com", "전자신문"],
  ["heraldcorp.com", "헤럴드경제"],
  ["chosun.com", "조선일보"],
  ["joongang.co.kr", "중앙일보"],
  ["donga.com", "동아일보"],
  ["hani.co.kr", "한겨레"],
  ["khan.co.kr", "경향신문"],
  ["kbs.co.kr", "KBS"],
  ["imbc.com", "MBC"],
  ["mbc.co.kr", "MBC"],
  ["sbs.co.kr", "SBS"],
  ["nocutnews.co.kr", "노컷뉴스"],
];

const NAVER_MEDIA_BY_OID = {
  "001": "연합뉴스",
  "003": "뉴시스",
  "008": "머니투데이",
  "009": "매일경제",
  "011": "서울경제",
  "014": "파이낸셜뉴스",
  "015": "한국경제",
  "016": "헤럴드경제",
  "018": "이데일리",
  "020": "동아일보",
  "022": "세계일보",
  "023": "조선일보",
  "025": "중앙일보",
  "028": "한겨레",
  "032": "경향신문",
  "055": "SBS",
  "056": "KBS",
  "214": "MBC",
  "421": "뉴스1",
};

const HELP_TEXT = `
한국 대기업 임금·단체협상 뉴스 일일 수집기

사용법:
  node scripts/collect-news.mjs [옵션]

옵션:
  --source <auto|naver|google>  수집원 선택 (기본값: auto)
  --year <YYYY>                대상 협상 연도 (기본값: 현재 KST 연도)
  --max-per-query <N>          쿼리별 최대 기사 수
  --no-resolve                 Google 링크의 원문 URL 되돌리기 생략
  --max-resolve <N>            원문 URL 되돌리기 최대 건수 (기본값: 60)
  --config <path>              소스 설정 JSON 경로
  --output <path>              결과 JSON 경로
  --force                      같은 KST 날짜의 배치를 강제 재실행
  --dry-run                    파일을 쓰지 않고 결과 JSON을 표준 출력
  --verbose                    쿼리별 진행 로그 출력
  --help                       도움말 출력

auto 모드는 NAVER_API_HUB_CLIENT_ID/NAVER_API_HUB_CLIENT_SECRET(또는 NAVER_* 별칭)이
모두 있으면 NAVER API HUB 뉴스 검색 API를 우선 사용하고, 없거나 요청이 실패하면
Google News RSS를 사용합니다. 운영 배치는 Asia/Seoul 06:30, 하루 한 번입니다.
`.trim();

function parseArguments(argv) {
  const options = {
    source: "auto",
    configPath: DEFAULT_CONFIG_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    year: null,
    maxPerQuery: null,
    force: false,
    dryRun: false,
    verbose: false,
    help: false,
    resolveOriginalUrls: true,
    maxResolutions: null,
  };

  const readValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} 옵션에 값이 필요합니다.`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--source":
        options.source = readValue(index, argument);
        index += 1;
        break;
      case "--year":
        options.year = Number.parseInt(readValue(index, argument), 10);
        index += 1;
        break;
      case "--max-per-query":
        options.maxPerQuery = Number.parseInt(readValue(index, argument), 10);
        index += 1;
        break;
      case "--config":
        options.configPath = resolve(process.cwd(), readValue(index, argument));
        index += 1;
        break;
      case "--output":
        options.outputPath = resolve(process.cwd(), readValue(index, argument));
        index += 1;
        break;
      case "--no-resolve":
        options.resolveOriginalUrls = false;
        break;
      case "--max-resolve":
        options.maxResolutions = Number.parseInt(readValue(index, argument), 10);
        index += 1;
        break;
      case "--force":
        options.force = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`알 수 없는 옵션입니다: ${argument}`);
    }
  }

  if (!new Set(["auto", "naver", "google"]).has(options.source)) {
    throw new Error("--source는 auto, naver, google 중 하나여야 합니다.");
  }
  if (options.year !== null && (options.year < 2000 || options.year > 2100)) {
    throw new Error("--year는 2000~2100 범위의 연도여야 합니다.");
  }
  if (
    options.maxPerQuery !== null &&
    (!Number.isInteger(options.maxPerQuery) || options.maxPerQuery < 1)
  ) {
    throw new Error("--max-per-query는 1 이상의 정수여야 합니다.");
  }

  return options;
}

async function readJson(path) {
  const contents = await readFile(path, "utf8");
  return JSON.parse(contents.replace(/^\uFEFF/, ""));
}

async function readJsonIfPresent(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function validateConfiguration(config) {
  if (config?.schemaVersion !== 1) {
    throw new Error("source-config.json의 schemaVersion은 1이어야 합니다.");
  }
  if (config?.collectionPolicy?.frequency !== "daily") {
    throw new Error("collectionPolicy.frequency는 daily로 고정해야 합니다.");
  }
  if (config?.collectionPolicy?.timezone !== "Asia/Seoul") {
    throw new Error("collectionPolicy.timezone은 Asia/Seoul이어야 합니다.");
  }
  if (
    config?.scopeReviewAgent?.id !== "primary-union-scope-review" ||
    config.scopeReviewAgent.executionOrder !== "before_stage_classification" ||
    !config.scopeReviewAgent.ruleVersion
  ) {
    throw new Error(
      "scopeReviewAgent는 primary-union-scope-review의 선행 게이트여야 합니다.",
    );
  }
  if (!Array.isArray(config?.companies) || config.companies.length === 0) {
    throw new Error("하나 이상의 회사 설정이 필요합니다.");
  }
  const naverSource = config?.sources?.naver;
  if (
    !naverSource?.endpoint ||
    !Array.isArray(naverSource.clientIdEnvironmentVariables) ||
    !Array.isArray(naverSource.clientSecretEnvironmentVariables)
  ) {
    throw new Error("NAVER 뉴스 수집원 설정이 불완전합니다.");
  }
  if (!new Set(["api-hub", "legacy"]).has(naverSource.authentication)) {
    throw new Error("NAVER 인증 방식은 api-hub 또는 legacy여야 합니다.");
  }

  const companyIds = new Set();
  for (const company of config.companies) {
    if (!company.id || !company.name || !Array.isArray(company.aliases)) {
      throw new Error("모든 회사에는 id, name, aliases가 필요합니다.");
    }
    if (companyIds.has(company.id)) {
      throw new Error(`중복 회사 id입니다: ${company.id}`);
    }
    companyIds.add(company.id);
    if (!Array.isArray(company.queries) || company.queries.length === 0) {
      throw new Error(`${company.name}에 수집 쿼리가 없습니다.`);
    }
    if (!Array.isArray(company.bargainingUnits)) {
      throw new Error(`${company.name}의 bargainingUnits는 배열이어야 합니다.`);
    }
    if (
      !company.selection?.scale ||
      !company.selection?.industryImpact ||
      !company.selection?.mediaExposure ||
      !company.selection?.majorityUnion
    ) {
      throw new Error(`${company.name}의 회사 선정 메타가 누락되었습니다.`);
    }
    if (
      !new Set(["O", "X", "UNKNOWN"]).has(
        company.selection.majorityUnion.status,
      )
    ) {
      throw new Error(`${company.name}의 majorityUnion.status가 잘못되었습니다.`);
    }
  }

  const requiredStages = new Set([
    "preparation",
    "bargaining",
    "breakdown_mediation",
    "industrial_action",
    "tentative_agreement",
    "final_agreement",
    "manual_review",
  ]);
  const configuredStages = new Set(
    (config?.taxonomy?.stages ?? []).map((stage) => stage.code),
  );
  for (const stageCode of requiredStages) {
    if (!configuredStages.has(stageCode)) {
      throw new Error(`필수 단계가 누락되었습니다: ${stageCode}`);
    }
  }

  const patterns = [
    ...(config.relevanceSignals ?? []),
    ...config.taxonomy.stages.flatMap((stage) => stage.signals ?? []),
    ...(config.taxonomy.exceptionEvents ?? []).flatMap(
      (event) => event.patterns ?? [],
    ),
    ...Object.values(config.taxonomy.guards ?? {}).flatMap((guards) =>
      guards.flatMap((guard) => guard.patterns ?? []),
    ),
    ...(config.taxonomy.statusFramework?.explicitStateSignals ?? []).flatMap(
      (state) => state.patterns ?? [],
    ),
    ...Object.values(
      config.taxonomy.statusFramework?.eventStatePatterns ?? {},
    ).flat(),
    ...Object.values(
      config.taxonomy.statusFramework?.parallelStates ?? {},
    ).flatMap((states) => states.flatMap((state) => state.patterns ?? [])),
  ];
  for (const pattern of patterns) {
    try {
      new RegExp(pattern, "iu");
    } catch (error) {
      throw new Error(`잘못된 정규식 '${pattern}': ${error.message}`);
    }
  }

  const framework = config.taxonomy.statusFramework;
  const requiredFrameworkCodes = new Set([
    "U",
    "S0",
    "S1",
    "S2",
    "S3",
    "S4",
    "S5",
    "S6",
    "S7",
    "S8",
  ]);
  const frameworkCodes = new Set(
    (framework?.states ?? []).map((state) => state.code),
  );
  for (const code of requiredFrameworkCodes) {
    if (!frameworkCodes.has(code)) {
      throw new Error(`상태 프레임워크 코드가 누락되었습니다: ${code}`);
    }
  }
  const requiredEventStates = new Set([
    "planned",
    "occurred",
    "cancelled",
    "corrected",
    "disputed",
  ]);
  for (const eventState of requiredEventStates) {
    if (!framework.eventStates.includes(eventState)) {
      throw new Error(`eventState 값이 누락되었습니다: ${eventState}`);
    }
  }
}

function kstParts(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function kstDateKey(date) {
  const { year, month, day } = kstParts(date);
  return `${year}-${month}-${day}`;
}

function currentKstYear(date) {
  return Number.parseInt(kstParts(date).year, 10);
}

function firstEnvironmentValue(names) {
  for (const name of names ?? []) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function naverCredentials(config) {
  const source = config.sources.naver;
  const clientId = firstEnvironmentValue(
    source.clientIdEnvironmentVariables,
  );
  const clientSecret = firstEnvironmentValue(
    source.clientSecretEnvironmentVariables,
  );
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function naverAuthenticationHeaders(source, credentials) {
  if (source.authentication === "api-hub") {
    return {
      "X-NCP-APIGW-API-KEY-ID": credentials.clientId,
      "X-NCP-APIGW-API-KEY": credentials.clientSecret,
    };
  }
  if (source.authentication === "legacy") {
    return {
      "X-Naver-Client-Id": credentials.clientId,
      "X-Naver-Client-Secret": credentials.clientSecret,
    };
  }
  throw new Error(`지원하지 않는 NAVER 인증 방식입니다: ${source.authentication}`);
}

function decodeHtmlEntities(value) {
  const namedEntities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return String(value ?? "")
    .replace(/&#(\d+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 10)),
    )
    .replace(/&#x([\da-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&([a-z]+);/gi, (entity, name) =>
      Object.hasOwn(namedEntities, name.toLowerCase())
        ? namedEntities[name.toLowerCase()]
        : entity,
    );
}

function cleanText(value) {
  return decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, " ")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function comparableText(value) {
  return cleanText(value).toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]/gu, "");
}

function normalizedTitleKey(value) {
  return cleanText(value)
    .replace(/^\s*(?:\[[^\]]{1,20}\]|【[^】]{1,20}】)\s*/g, "")
    .toLocaleLowerCase("ko-KR")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function canonicalizeUrl(value) {
  try {
    const url = new URL(decodeHtmlEntities(value));
    if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    const removableParameters = [
      "fbclid",
      "gclid",
      "oc",
      "ref",
      "source",
      "spm",
    ];
    for (const name of [...url.searchParams.keys()]) {
      if (name.toLowerCase().startsWith("utm_") || removableParameters.includes(name)) {
        url.searchParams.delete(name);
      }
    }
    url.searchParams.sort();
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

function inferMedia(urlValue) {
  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "n.news.naver.com") {
      const oid = url.searchParams.get("oid") ?? url.pathname.match(/article\/(\d{3})\//)?.[1];
      if (oid && NAVER_MEDIA_BY_OID[oid]) return NAVER_MEDIA_BY_OID[oid];
    }
    for (const [domain, media] of KNOWN_MEDIA_BY_HOST) {
      if (host === domain || host.endsWith(`.${domain}`)) return media;
    }
    return host;
  } catch {
    return "매체 미상";
  }
}

function parsePublishedAt(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1_000, 30_000);
  }
  return Math.min(750 * 2 ** attempt + Math.random() * 250, 10_000);
}

async function fetchWithRetry(url, init, policy) {
  let lastError;
  for (let attempt = 0; attempt < policy.maxRetries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(policy.requestTimeoutMs),
      });
      if (response.ok) return response;
      const retryable = response.status === 429 || response.status >= 500;
      const error = new Error(`HTTP ${response.status} ${response.statusText}`);
      if (!retryable) {
        error.nonRetryable = true;
        throw error;
      }
      if (attempt === policy.maxRetries - 1) throw error;
      lastError = error;
      await delay(retryDelay(response, attempt));
    } catch (error) {
      lastError = error;
      if (error?.nonRetryable) throw error;
      if (attempt === policy.maxRetries - 1) break;
      await delay(retryDelay(null, attempt));
    }
  }
  throw lastError ?? new Error("뉴스 수집 요청이 실패했습니다.");
}

async function fetchNaverNews(query, maxItems, config, credentials) {
  const source = config.sources.naver;
  const url = new URL(source.endpoint);
  url.searchParams.set("query", query);
  url.searchParams.set("display", String(Math.min(maxItems, 100)));
  url.searchParams.set("start", "1");
  url.searchParams.set("sort", source.sort ?? "date");

  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...naverAuthenticationHeaders(source, credentials),
      },
    },
    config.collectionPolicy,
  );
  const payload = await response.json();
  if (!Array.isArray(payload.items)) {
    throw new Error("네이버 뉴스 API 응답에 items 배열이 없습니다.");
  }

  return payload.items.slice(0, maxItems).map((item) => {
    const originalUrl = canonicalizeUrl(item.originallink);
    const urlValue = originalUrl ?? canonicalizeUrl(item.link);
    return {
      title: cleanText(item.title),
      media: urlValue ? inferMedia(urlValue) : "매체 미상",
      publishedAt: parsePublishedAt(item.pubDate),
      url: urlValue,
      originalUrl,
      collectionSources: ["naver"],
    };
  });
}

function nodeText(value) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (value && typeof value === "object") {
    return String(value["#text"] ?? value.__cdata ?? "");
  }
  return "";
}

async function fetchGoogleNews(query, maxItems, year, config) {
  const source = config.sources.googleNews;
  const url = new URL(source.endpoint);
  const datedQuery = `${query} after:${year}-01-01 before:${year + 1}-01-01`;
  url.searchParams.set("q", datedQuery);
  url.searchParams.set("hl", source.language);
  url.searchParams.set("gl", source.country);
  url.searchParams.set("ceid", source.edition);

  const response = await fetchWithRetry(
    url,
    {
      headers: {
        Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
        "User-Agent": USER_AGENT,
      },
    },
    config.collectionPolicy,
  );
  const xml = await response.text();
  const { XMLParser } = await import("fast-xml-parser");
  const parser = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    removeNSPrefix: true,
    trimValues: true,
  });
  const payload = parser.parse(xml);
  const rssItems = payload?.rss?.channel?.item;
  const items = Array.isArray(rssItems) ? rssItems : rssItems ? [rssItems] : [];

  return items.slice(0, maxItems).map((item) => {
    const media = cleanText(nodeText(item.source)) || "매체 미상";
    let title = cleanText(nodeText(item.title));
    const mediaSuffix = ` - ${media}`;
    if (media !== "매체 미상" && title.endsWith(mediaSuffix)) {
      title = title.slice(0, -mediaSuffix.length).trim();
    }
    return {
      title,
      media,
      publishedAt: parsePublishedAt(nodeText(item.pubDate)),
      url: canonicalizeUrl(nodeText(item.link)),
      originalUrl: null,
      collectionSources: ["google-news-rss"],
    };
  });
}

function matchesPattern(value, pattern) {
  return new RegExp(pattern, "iu").test(value);
}

function countPatternMatches(value, pattern) {
  const expression = new RegExp(pattern, "giu");
  return [...value.matchAll(expression)].length;
}

function hasRelevantSignal(title, config) {
  return config.relevanceSignals.some((pattern) => matchesPattern(title, pattern));
}

function mergeRecord(left, right) {
  const rank = (record) => {
    let score = record.collectionSources.includes("naver") ? 3 : 0;
    if (!record.url.includes("news.google.com")) score += 2;
    if (record.media && !record.media.includes(".")) score += 1;
    return score;
  };
  const preferred = rank(right) > rank(left) ? right : left;
  return {
    ...preferred,
    originalUrl: preferred.originalUrl ?? left.originalUrl ?? right.originalUrl,
    originCompanyIds: [
      ...new Set([...left.originCompanyIds, ...right.originCompanyIds]),
    ],
    collectionSources: [
      ...new Set([...left.collectionSources, ...right.collectionSources]),
    ],
  };
}

function deduplicateBy(records, keyFunction) {
  const deduplicated = new Map();
  for (const record of records) {
    const key = keyFunction(record);
    if (!key) continue;
    const existing = deduplicated.get(key);
    deduplicated.set(key, existing ? mergeRecord(existing, record) : record);
  }
  return [...deduplicated.values()];
}

function guardForStage(title, stageCode, taxonomy) {
  for (const kind of ["negation", "future"]) {
    for (const guard of taxonomy.guards?.[kind] ?? []) {
      if (!guard.stageCodes.includes(stageCode)) continue;
      if ((guard.patterns ?? []).some((pattern) => matchesPattern(title, pattern))) {
        return {
          kind,
          fallbackStage: guard.fallbackStage ?? "manual_review",
        };
      }
    }
  }
  return null;
}

function stageReference(stageCode, stagesByCode) {
  const stage = stagesByCode.get(stageCode) ?? stagesByCode.get("manual_review");
  return { code: stage.code, label: stage.label };
}

function classifyStage(title, taxonomy) {
  const stagesByCode = new Map(
    taxonomy.stages.map((stage) => [stage.code, stage]),
  );

  for (const exception of taxonomy.exceptionEvents ?? []) {
    const matched = exception.patterns.some((pattern) =>
      matchesPattern(title, pattern),
    );
    if (!matched) continue;

    if (exception.respectGuards) {
      const guard = guardForStage(title, exception.stage, taxonomy);
      if (guard) {
        return {
          stage: stageReference(guard.fallbackStage, stagesByCode),
          suggestedStage: stageReference(exception.stage, stagesByCode),
          eventType: guard.kind === "future" ? "future_plan" : "negated_signal",
          transitionHint: "hold_before_suggested_stage",
          confidence: 0.46,
          needsReview: true,
          reasonCodes: [`${guard.kind}_expression_guard`],
        };
      }
    }

    return {
      stage: stageReference(exception.stage, stagesByCode),
      suggestedStage: null,
      eventType: exception.eventType,
      transitionHint: exception.transitionHint,
      confidence: exception.needsReview ? 0.82 : 0.9,
      needsReview: Boolean(exception.needsReview),
      reasonCodes: ["exception_transition_rule"],
    };
  }

  const activeCandidates = [];
  const guardedCandidates = [];
  for (const stage of taxonomy.stages) {
    if (stage.code === "manual_review") continue;
    const matchCount = (stage.signals ?? []).reduce(
      (total, pattern) => total + countPatternMatches(title, pattern),
      0,
    );
    if (matchCount === 0) continue;
    const guard = guardForStage(title, stage.code, taxonomy);
    const candidate = {
      stage,
      matchCount,
      score: stage.order + Math.min(matchCount, 3) * 2,
      guard,
    };
    if (guard) guardedCandidates.push(candidate);
    else activeCandidates.push(candidate);
  }

  activeCandidates.sort((left, right) => right.score - left.score);
  guardedCandidates.sort((left, right) => right.score - left.score);

  if (activeCandidates.length > 0) {
    const winner = activeCandidates[0];
    const guarded = guardedCandidates[0] ?? null;
    return {
      stage: stageReference(winner.stage.code, stagesByCode),
      suggestedStage: guarded
        ? stageReference(guarded.stage.code, stagesByCode)
        : null,
      eventType: guarded
        ? guarded.guard.kind === "future"
          ? "future_plan"
          : "negated_signal"
        : "stage_update",
      transitionHint: guarded ? "hold_before_suggested_stage" : "evaluate_by_date",
      confidence: Math.min(0.94, 0.66 + winner.matchCount * 0.08),
      needsReview: Boolean(guarded),
      reasonCodes: guarded
        ? ["stage_signal", `${guarded.guard.kind}_expression_guard`]
        : ["stage_signal"],
    };
  }

  if (guardedCandidates.length > 0) {
    const guarded = guardedCandidates[0];
    return {
      stage: stageReference(guarded.guard.fallbackStage, stagesByCode),
      suggestedStage: stageReference(guarded.stage.code, stagesByCode),
      eventType:
        guarded.guard.kind === "future" ? "future_plan" : "negated_signal",
      transitionHint: "hold_before_suggested_stage",
      confidence: 0.42,
      needsReview: true,
      reasonCodes: [`${guarded.guard.kind}_expression_guard`],
    };
  }

  return {
    stage: stageReference("manual_review", stagesByCode),
    suggestedStage: null,
    eventType: "unclassified",
    transitionHint: "manual_review",
    confidence: 0.3,
    needsReview: true,
    reasonCodes: ["no_stage_signal"],
  };
}

function firstParallelState(title, definitions) {
  const matches = [];
  for (const definition of definitions ?? []) {
    if (
      (definition.patterns ?? []).some((pattern) =>
        matchesPattern(title, pattern),
      )
    ) {
      matches.push({
        code: definition.code,
        label: definition.label,
        eventState: definition.eventState,
      });
    }
  }
  return matches.find((state) => state.eventState === "disputed") ?? matches[0] ?? null;
}

function frameworkStateDefinition(framework, code) {
  return (
    framework.states.find((state) => state.code === code) ??
    framework.states.find((state) => state.code === "U")
  );
}

function eventStatePatternMatches(title, framework, eventState) {
  return (framework.eventStatePatterns?.[eventState] ?? []).some((pattern) =>
    matchesPattern(title, pattern),
  );
}

function deriveEventState(
  title,
  stageClassification,
  framework,
  disputeState,
  agreementState,
) {
  if (eventStatePatternMatches(title, framework, "corrected")) {
    return "corrected";
  }

  const occurredExceptionEvents = new Set([
    "tentative_rejected",
    "rejected_then_action_resumed",
    "renewed_bargaining_broken",
    "agreement_failed",
  ]);
  if (occurredExceptionEvents.has(stageClassification.eventType)) {
    return "occurred";
  }
  if (
    disputeState.eventState === "cancelled" ||
    eventStatePatternMatches(title, framework, "cancelled")
  ) {
    return "cancelled";
  }
  if (
    stageClassification.eventType === "future_plan" ||
    disputeState.eventState === "planned" ||
    agreementState.eventState === "planned" ||
    eventStatePatternMatches(title, framework, "planned")
  ) {
    return "planned";
  }
  if (
    stageClassification.eventType === "negated_signal" ||
    agreementState.eventState === "disputed" ||
    eventStatePatternMatches(title, framework, "disputed")
  ) {
    return "disputed";
  }
  return "occurred";
}

function representationFromScope(scope) {
  switch (scope) {
    case "single":
      return {
        code: "SINGLE_UNION",
        label: "교섭단위 확인",
        eventState: "occurred",
      };
    case "multiple":
      return {
        code: "MULTI_UNION",
        label: "복수 교섭단위 명시",
        eventState: "occurred",
      };
    case "inferred_single":
      return {
        code: "SINGLE_UNION",
        label: "단일 교섭단위 추론",
        eventState: "occurred",
      };
    default:
      return {
        code: "MULTI_UNION",
        label: "교섭단위 불명",
        eventState: "disputed",
      };
  }
}

function aggregateRepresentationState(companies, explicitRepresentation) {
  if (explicitRepresentation) return explicitRepresentation;
  const representations = companies.map(
    (company) => company.representationState,
  );
  if (
    companies.some((company) => company.bargainingUnitScope === "unspecified")
  ) {
    return {
      code: "MULTI_UNION",
      label: "교섭단위 불명",
      eventState: "disputed",
    };
  }
  const codes = new Set(representations.map((state) => state.code));
  if (codes.size > 1) {
    return {
      code: "MULTI_UNION",
      label: "복수 대표성 맥락",
      eventState: "disputed",
    };
  }
  return representations[0] ?? {
    code: "MULTI_UNION",
    label: "교섭단위 불명",
    eventState: "disputed",
  };
}

function deriveFrameworkClassification(
  title,
  stageClassification,
  companies,
  taxonomy,
) {
  const framework = taxonomy.statusFramework;
  let disputeState =
    firstParallelState(title, framework.parallelStates.dispute) ?? {
      code: "NONE",
      label: "없음",
      eventState: "occurred",
    };
  const explicitRepresentation = firstParallelState(
    title,
    framework.parallelStates.representation,
  );
  const representationState = aggregateRepresentationState(
    companies,
    explicitRepresentation,
  );
  let agreementState =
    firstParallelState(title, framework.parallelStates.agreement) ?? {
      code: "NONE",
      label: "없음",
      eventState: "occurred",
    };
  const agreementLifecycleState = firstParallelState(
    title,
    framework.parallelStates.agreementLifecycle,
  );

  if (disputeState.code === "MEDIATION_SETTLED") {
    agreementState = {
      code: "EFFECTIVE",
      label: "조정 성립 합의",
      eventState: "occurred",
    };
  } else if (disputeState.code === "ARBITRATION_AWARD") {
    agreementState = {
      code: "EFFECTIVE",
      label: "중재재정 효력",
      eventState: "occurred",
    };
  }
  const eventState = deriveEventState(
    title,
    stageClassification,
    framework,
    disputeState,
    agreementState,
  );

  const hasExplicitReopenEvidence = matchesPattern(
    title,
    "재교섭|재협상|교섭\\s*재개|협상\\s*재개",
  );
  const exceptionCode = {
    tentative_rejected: hasExplicitReopenEvidence ? "S3" : "U",
    rejected_then_action_resumed: hasExplicitReopenEvidence ? "S3" : "U",
    bargaining_resumed: "S3",
    renewed_bargaining_broken: "S4",
    agreement_failed: "U",
    industrial_action_withdrawn: "U",
  }[stageClassification.eventType];
  let statusCode =
    exceptionCode ?? framework.defaultStageMap[stageClassification.stage.code] ?? "U";
  let statusBasis = exceptionCode ? "exception_transition" : "stage_mapping";

  const explicitState = framework.explicitStateSignals.find((signal) =>
    signal.patterns.some((pattern) => matchesPattern(title, pattern)),
  );
  if (
    explicitState &&
    !new Set([
      "tentative_rejected",
      "rejected_then_action_resumed",
      "agreement_failed",
    ]).has(stageClassification.eventType)
  ) {
    const baseNumber = Number.parseInt(statusCode.slice(1), 10);
    if (explicitState.code !== "S2" || !Number.isFinite(baseNumber) || baseNumber <= 2) {
      statusCode = explicitState.code;
      statusBasis = "explicit_status_signal";
    }
  }

  const breakdownStage = taxonomy.stages.find(
    (stage) => stage.code === "breakdown_mediation",
  );
  const hasActualImpasseOrMediation = (breakdownStage?.signals ?? []).some(
    (pattern) => matchesPattern(title, pattern),
  ) && !guardForStage(title, "breakdown_mediation", taxonomy);

  if (disputeState.code === "MEDIATION_SETTLED") {
    statusCode = "S7";
    statusBasis = "mediation_settled";
  } else if (disputeState.code === "ARBITRATION_AWARD") {
    statusCode = "S7";
    statusBasis = "arbitration_award";
  } else if (
    new Set(["ARBITRATION_ACTIVE", "ADMINISTRATIVE_GUIDANCE"]).has(
      disputeState.code,
    )
  ) {
    statusCode = "U";
    statusBasis = "retain_only";
  }
  const isStrikeOnlyEvidence = new Set([
    "STRIKE_VOTE_SCHEDULED",
    "STRIKE_VOTE_PASSED",
    "STRIKE_ANNOUNCED",
    "STRIKE_ACTIVE",
    "STRIKE_SUSPENDED_OR_RETURNED",
  ]).has(disputeState.code) || matchesPattern(
    title,
    "(?:쟁의행위|파업).{0,8}찬반투표|찬반투표.{0,12}(?:쟁의행위|파업)",
  );

  const activeNonIndustrialStages = taxonomy.stages
    .filter(
      (stage) =>
        !new Set(["industrial_action", "manual_review"]).has(stage.code) &&
        (stage.signals ?? []).some((pattern) => matchesPattern(title, pattern)) &&
        !guardForStage(title, stage.code, taxonomy),
    )
    .sort((left, right) => right.order - left.order);
  if (
    stageClassification.stage.code === "industrial_action" &&
    !exceptionCode &&
    !explicitState &&
    activeNonIndustrialStages.length > 0
  ) {
    statusCode =
      framework.defaultStageMap[activeNonIndustrialStages[0].code] ?? "U";
    statusBasis = "concurrent_main_stage_signal";
  }
  const strikeDisputeWithoutMainEvidence =
    isStrikeOnlyEvidence &&
    !hasActualImpasseOrMediation &&
    activeNonIndustrialStages.length === 0 &&
    !explicitState;

  if (strikeDisputeWithoutMainEvidence && statusCode === "S4") {
    statusCode = "U";
    statusBasis = "retain_only";
  }
  if (
    stageClassification.stage.code === "industrial_action" &&
    hasActualImpasseOrMediation
  ) {
    statusCode = "S4";
    statusBasis = "explicit_impasse_or_mediation";
  }

  if (
    agreementState.code === "REPORTED" &&
    !new Set(["S5", "S6", "S7", "S8"]).has(statusCode)
  ) {
    statusCode = "U";
    statusBasis = "ambiguous_agreement_report";
  } else if (
    agreementState.code === "REPORTED" &&
    stageClassification.stage.code === "final_agreement" &&
    !explicitState
  ) {
    statusCode = "U";
    statusBasis = "ambiguous_agreement_report";
  }

  const status = frameworkStateDefinition(framework, statusCode);
  const retainMainState =
    eventState !== "occurred" ||
    stageClassification.transitionHint === "retain_main_state" ||
    strikeDisputeWithoutMainEvidence ||
    statusBasis === "retain_only" ||
    statusBasis === "ambiguous_agreement_report" ||
    (statusCode === "U" && exceptionCode === "U") ||
    (new Set(["tentative_rejected", "rejected_then_action_resumed"]).has(
      stageClassification.eventType,
    ) && !hasExplicitReopenEvidence);

  return {
    statusCode: status.code,
    statusName: status.name,
    statusLabel: status.label,
    eventState,
    eventStateCode: framework.frameworkEventStateCodes[eventState],
    retainMainState,
    statusBasis,
    parallelStates: {
      dispute: {
        ...disputeState,
        eventStateCode:
          framework.frameworkEventStateCodes[disputeState.eventState],
      },
      representation: {
        ...representationState,
        eventStateCode:
          framework.frameworkEventStateCodes[representationState.eventState],
      },
      agreement: {
        ...agreementState,
        eventStateCode:
          framework.frameworkEventStateCodes[agreementState.eventState],
      },
      agreementLifecycle: agreementLifecycleState
        ? {
            ...agreementLifecycleState,
            eventStateCode:
              framework.frameworkEventStateCodes[
                agreementLifecycleState.eventState
              ],
          }
        : null,
    },
    needsReview:
      statusBasis === "ambiguous_agreement_report" ||
      (statusCode === "U" && exceptionCode === "U"),
  };
}

function matchingAliases(title, aliases) {
  const comparableTitle = comparableText(title);
  return aliases.filter((alias) => comparableTitle.includes(comparableText(alias)));
}

function classifyEmploymentScope(title, company, unitMatches, config) {
  const comparableTitle = comparableText(title);
  const hasCompanyUnionPhrase = company.aliases.some((alias) => {
    const comparableAlias = comparableText(alias);
    return ["노조", "노동조합", "지부"].some((suffix) =>
      comparableTitle.includes(`${comparableAlias}${comparableText(suffix)}`),
    );
  });
  const hasDirectUnionUnit = unitMatches.some(
    (unit) => unit.id !== "works-council",
  );
  const hasWorksCouncilOnly =
    unitMatches.length > 0 && !hasDirectUnionUnit;
  const hasSubcontractorSignal = config.scopePolicy.subcontractorSignals.some(
    (pattern) => matchesPattern(title, pattern),
  );
  const hasAffiliateSignal = config.scopePolicy.affiliateSignals.some((pattern) =>
    matchesPattern(title, pattern),
  );
  const hasDirectEvidence = hasDirectUnionUnit;

  if (hasDirectEvidence && (hasSubcontractorSignal || hasAffiliateSignal)) {
    return {
      scopeClassification: "MIXED_NEEDS_SPLIT",
      includeInPrimaryDashboard: false,
      directEmployerMatch: true,
      coveredWorkerRelation: "MIXED_OR_UNRESOLVED",
      reasonCodes: ["direct_and_excluded_scope_signals"],
    };
  }
  if (hasSubcontractorSignal) {
    return {
      scopeClassification: "SUBCONTRACTOR_UNION_EXCLUDED",
      includeInPrimaryDashboard: false,
      directEmployerMatch: false,
      coveredWorkerRelation: "SUBCONTRACTOR_OR_NON_DIRECT",
      reasonCodes: ["subcontractor_signal"],
    };
  }
  if (hasAffiliateSignal) {
    return {
      scopeClassification: "AFFILIATE_UNION_EXCLUDED",
      includeInPrimaryDashboard: false,
      directEmployerMatch: false,
      coveredWorkerRelation: "AFFILIATE",
      reasonCodes: ["affiliate_union_signal"],
    };
  }
  if (hasWorksCouncilOnly) {
    return {
      scopeClassification: "UNKNOWN_REVIEW",
      includeInPrimaryDashboard: false,
      directEmployerMatch: true,
      coveredWorkerRelation: "WORKS_COUNCIL_NOT_UNION",
      reasonCodes: ["works_council_not_collective_bargaining_union"],
    };
  }
  if (hasDirectEvidence) {
    return {
      scopeClassification: "PRIMARY_DIRECT_UNION",
      includeInPrimaryDashboard: true,
      directEmployerMatch: true,
      coveredWorkerRelation: "DIRECT",
      reasonCodes: [
        hasDirectUnionUnit ? "configured_direct_union_alias" : "company_union_phrase",
      ],
    };
  }
  return {
    scopeClassification: "UNKNOWN_REVIEW",
    includeInPrimaryDashboard: false,
    directEmployerMatch: false,
    coveredWorkerRelation: "UNKNOWN",
    reasonCodes: [
      hasCompanyUnionPhrase
        ? "company_union_phrase_requires_direct_union_alias"
        : "direct_employment_relation_not_confirmed",
    ],
  };
}

function runScopeReviewAgent(title, company, unitMatches, config) {
  const scope = classifyEmploymentScope(title, company, unitMatches, config);
  return {
    ...scope,
    scopeReview: {
      agentId: config.scopeReviewAgent.id,
      ruleVersion: config.scopeReviewAgent.ruleVersion,
      executionOrder: config.scopeReviewAgent.executionOrder,
      publicScope: config.scopeReviewAgent.publicScope,
      quarantined: !scope.includeInPrimaryDashboard,
    },
  };
}

function classifyCompanyMatch(title, company, matchedDirectly, config) {
  const taxonomy = config.taxonomy;
  const unitMatches = company.bargainingUnits.filter(
    (unit) => matchingAliases(title, unit.aliases).length > 0,
  );
  let bargainingUnits;
  let bargainingUnitScope;
  let needsReview = !matchedDirectly;
  let reasonCode = matchedDirectly ? "company_alias" : "query_context_only";

  if (unitMatches.length > 0) {
    bargainingUnits = unitMatches.map((unit) => ({
      id: unit.id,
      name: unit.name,
      matchBasis: "title_alias",
    }));
    bargainingUnitScope = unitMatches.length === 1 ? "single" : "multiple";
    if (unitMatches.length > 1) {
      needsReview = true;
      reasonCode = "multiple_units_in_title";
    }
  } else if (company.bargainingUnits.length === 1) {
    const unit = company.bargainingUnits[0];
    bargainingUnits = [
      {
        id: unit.id,
        name: unit.name,
        matchBasis: "single_configured_unit",
      },
    ];
    bargainingUnitScope = "inferred_single";
  } else {
    bargainingUnits = [];
    bargainingUnitScope = "unspecified";
    needsReview = true;
    reasonCode = "multiple_units_unspecified";
  }

  const explicitRepresentation = firstParallelState(
    title,
    taxonomy.statusFramework.parallelStates.representation,
  );
  const representationState =
    explicitRepresentation ?? representationFromScope(bargainingUnitScope);
  representationState.eventStateCode =
    taxonomy.statusFramework.frameworkEventStateCodes[
      representationState.eventState
    ];
  if (representationState.eventState === "disputed") needsReview = true;
  const employmentScope = runScopeReviewAgent(
    title,
    company,
    unitMatches,
    config,
  );
  if (
    new Set(["UNKNOWN_REVIEW", "MIXED_NEEDS_SPLIT"]).has(
      employmentScope.scopeClassification,
    )
  ) {
    needsReview = true;
  }
  const unionProfiles = bargainingUnits.map((unit) => ({
    bargainingUnitId: unit.id,
    bargainingUnitName: unit.name,
    memberCount: null,
    electionIssues: [],
    majorityUnion: {
      status: "UNKNOWN",
      numerator: null,
      denominator: null,
      calculationBasis: null,
      evidenceDate: null,
      evidenceUrl: null,
    },
    representativeBargainingUnion: { status: "UNKNOWN" },
    directEmploymentUnionizationRate: { value: null },
    verifiedAt: null,
    needsReview: true,
  }));

  return {
    companyId: company.id,
    companyName: company.name,
    matchBasis: matchedDirectly ? "title_alias" : "query_context",
    confidence: matchedDirectly ? 0.94 : 0.56,
    bargainingUnits,
    bargainingUnitScope,
    representationState,
    unionProfiles,
    ...employmentScope,
    needsReview,
    reasonCode,
  };
}

function freshnessFor(publishedAt, now, policy) {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(publishedAt)) / DAY_IN_MILLISECONDS);
  const score = 0.5 ** (ageDays / policy.freshnessHalfLifeDays);
  let band = "archive";
  if (ageDays <= 7) band = "very_recent";
  else if (ageDays <= 30) band = "recent";
  else if (ageDays <= policy.freshnessReviewDays) band = "aging";
  return {
    score: Number(score.toFixed(4)),
    ageDays: Number(ageDays.toFixed(1)),
    band,
  };
}

function extractPercentage(title, patterns) {
  for (const pattern of patterns) {
    const match = title.match(new RegExp(pattern, "iu"));
    if (!match) continue;
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value) && value >= 0 && value <= 100) return value;
  }
  return null;
}

function extractVoteData(title, parallelStates) {
  if (!matchesPattern(title, "찬반투표|투표율|찬성률")) return null;
  const agreementVoteCodes = new Set([
    "RATIFICATION_SCHEDULED",
    "RATIFICATION_IN_PROGRESS",
    "RATIFIED",
    "RATIFICATION_REJECTED",
  ]);
  const isAgreementVote =
    agreementVoteCodes.has(parallelStates.agreement.code) ||
    matchesPattern(title, "잠정\\s*합의안?|임단협\\s*합의안?");
  let result = "REPORTED";
  if (
    parallelStates.dispute.code === "STRIKE_VOTE_SCHEDULED" ||
    parallelStates.agreement.code === "RATIFICATION_SCHEDULED"
  ) {
    result = "SCHEDULED";
  } else if (parallelStates.agreement.code === "RATIFICATION_IN_PROGRESS") {
    result = "IN_PROGRESS";
  } else if (
    parallelStates.dispute.code === "STRIKE_VOTE_PASSED" ||
    parallelStates.agreement.code === "RATIFIED"
  ) {
    result = "PASSED";
  } else if (parallelStates.agreement.code === "RATIFICATION_REJECTED") {
    result = "REJECTED";
  } else if (matchesPattern(title, "찬반투표.{0,40}(?:부결|반대\\s*우세)")) {
    result = "REJECTED";
  } else if (matchesPattern(title, "찬반투표.{0,40}(?:가결|찬성)")) {
    result = "PASSED";
  }

  return {
    voteType: isAgreementVote ? "RATIFICATION" : "STRIKE_ACTION",
    result,
    turnoutRate: extractPercentage(title, [
      "투표율\\s*(?:은|이|:)?\\s*(\\d+(?:\\.\\d+)?)\\s*%",
      "(\\d+(?:\\.\\d+)?)\\s*%.{0,5}투표율",
    ]),
    approvalRate: extractPercentage(title, [
      "찬성률\\s*(?:은|이|:)?\\s*(\\d+(?:\\.\\d+)?)\\s*%",
      "(\\d+(?:\\.\\d+)?)\\s*%.{0,5}찬성",
    ]),
    legalConclusionInferred: false,
    factBasis: "title_only",
  };
}

function deriveAgreementType(title) {
  const integrated = matchesPattern(
    title,
    "임단협|임금.{0,4}(?:및|·|\\+).{0,4}단체|단체.{0,4}(?:및|·|\\+).{0,4}임금",
  );
  const wage = matchesPattern(title, "임금\\s*(?:협상|교섭|협약|인상)");
  const collective = matchesPattern(title, "단체\\s*(?:협약|교섭|협상)");
  if (integrated || (wage && collective)) return "INTEGRATED";
  if (wage) return "WAGE";
  if (collective) return "CBA";
  return null;
}

function deriveIssueSummary(title) {
  const issueDefinitions = [
    ["WAGE_BASE", "기본급·임금체계", "기본급|호봉|정기승급|임금체계"],
    ["WAGE_INCREASE", "임금 인상", "임금\\s*인상|인상률|정액\\s*인상|정률\\s*인상"],
    ["VARIABLE_PAY_PERFORMANCE", "성과·변동급", "성과급|격려금|이익배분|인센티브"],
    ["ALLOWANCE", "수당", "수당|상여금"],
    ["WORKTIME_SHIFT", "근로시간·교대", "근로시간|노동시간|교대제|주4일|주\\s*4.5일"],
    ["EMPLOYMENT_SECURITY", "고용안정", "고용안정|정년|구조조정|해고|전환배치"],
    ["SAFETY", "산업안전", "산업안전|안전보건|중대재해"],
    ["WELFARE", "복지", "복지|휴가|주거|통근"],
    ["WORK_RULES", "인사·취업규칙", "인사|평가|징계|취업규칙"],
    ["UNION_RIGHTS", "노조활동", "노조활동|전임자|타임오프|조합비"],
    ["SUBCONTRACTING", "외주·하청", "외주|하청|협력업체|간접고용"],
  ];
  return issueDefinitions
    .filter(([, , pattern]) => matchesPattern(title, pattern))
    .map(([code, label]) => ({ code, label, factBasis: "title_keyword" }));
}

function deriveArticleAnnotations(record, frameworkClassification, bargainingYear) {
  const agreementType = deriveAgreementType(record.title);
  const issueSummary = deriveIssueSummary(record.title);
  const isImpasse =
    frameworkClassification.statusCode === "S4" ||
    new Set([
      "IMPASSE_REPORTED",
      "MEDIATION_REQUESTED",
      "MEDIATION_ACTIVE",
      "MEDIATION_UNRESOLVED",
    ]).has(frameworkClassification.parallelStates.dispute.code);
  const agreementCode = frameworkClassification.parallelStates.agreement.code;
  const isRatification = new Set([
    "RATIFICATION_SCHEDULED",
    "RATIFICATION_IN_PROGRESS",
    "RATIFIED",
    "RATIFICATION_REJECTED",
  ]).has(agreementCode);

  const impasseReason = isImpasse
    ? {
        issueCodes: issueSummary.map((issue) => issue.code),
        summary:
          issueSummary.length > 0
            ? `${issueSummary.map((issue) => issue.label).join(", ")} 관련 가능성`
            : null,
        causalLinkConfirmed: false,
        factBasis: "title_keywords_only",
        needsReview: true,
      }
    : null;
  const ratification = isRatification
    ? {
        proposalChangeSummary: {
          summary: null,
          comparisonBasis: "previous_or_existing_agreement_not_available",
          needsReview: true,
        },
      }
    : null;
  const needsReview =
    !agreementType ||
    !record.originalUrl ||
    Boolean(impasseReason?.needsReview) ||
    Boolean(ratification?.proposalChangeSummary.needsReview);

  return {
    agreementType: {
      code: agreementType,
      bargainingYear,
      bargainingYearScope: "current_year",
      factBasis: agreementType ? "title_keyword" : "unverified",
      needsReview: !agreementType,
    },
    issueSummary,
    impasseReason,
    ratification,
    originalUrlStatus: record.originalUrl ? "DIRECT" : "AGGREGATOR_ONLY",
    sourceTier: "C",
    factStatus: "INFERENCE",
    needsReview,
  };
}

function classifyArticle(
  record,
  config,
  now,
  bargainingYear = currentKstYear(now),
) {
  const originCompanyIds = new Set(record.originCompanyIds);
  const directCompanyIds = new Set(
    config.companies
      .filter((company) => matchingAliases(record.title, company.aliases).length > 0)
      .map((company) => company.id),
  );
  const matchedCompanyIds = new Set([...originCompanyIds, ...directCompanyIds]);
  const companies = config.companies
    .filter((company) => matchedCompanyIds.has(company.id))
    .map((company) =>
      classifyCompanyMatch(
        record.title,
        company,
        directCompanyIds.has(company.id),
        config,
      ),
    );

  const stageClassification = classifyStage(record.title, config.taxonomy);
  const derivedFrameworkClassification = deriveFrameworkClassification(
    record.title,
    stageClassification,
    companies,
    config.taxonomy,
  );
  const primaryCompanyMatches = companies.filter(
    (company) => company.includeInPrimaryDashboard,
  );
  const includeInPrimaryDashboard = primaryCompanyMatches.length > 0;
  const scopeClassification = includeInPrimaryDashboard
    ? "PRIMARY_DIRECT_UNION"
    : companies.find(
        (company) => company.scopeClassification === "MIXED_NEEDS_SPLIT",
      )?.scopeClassification ??
      companies.find(
        (company) =>
          company.scopeClassification === "SUBCONTRACTOR_UNION_EXCLUDED",
      )?.scopeClassification ??
      companies.find(
        (company) => company.scopeClassification === "AFFILIATE_UNION_EXCLUDED",
      )?.scopeClassification ??
      "UNKNOWN_REVIEW";
  const unverifiedStatus = frameworkStateDefinition(
    config.taxonomy.statusFramework,
    "U",
  );
  const frameworkClassification = includeInPrimaryDashboard
    ? derivedFrameworkClassification
    : {
        ...derivedFrameworkClassification,
        statusCode: unverifiedStatus.code,
        statusName: unverifiedStatus.name,
        statusLabel: unverifiedStatus.label,
        retainMainState: true,
        statusBasis: "scope_excluded",
        parallelStates: {
          dispute: {
            code: "NONE",
            label: "원청 대시보드 집계 제외",
            eventState: "occurred",
            eventStateCode: "OCCURRED",
          },
          representation: {
            code: "MULTI_UNION",
            label: "원청 직접고용 관계 미확인",
            eventState: "disputed",
            eventStateCode: "DISPUTED",
          },
          agreement: {
            code: "NONE",
            label: "원청 대시보드 집계 제외",
            eventState: "occurred",
            eventStateCode: "OCCURRED",
          },
          agreementLifecycle: null,
        },
        needsReview: new Set(["UNKNOWN_REVIEW", "MIXED_NEEDS_SPLIT"]).has(
          scopeClassification,
        ),
      };
  const voteData = extractVoteData(
    record.title,
    frameworkClassification.parallelStates,
  );
  const annotations = deriveArticleAnnotations(
    record,
    frameworkClassification,
    bargainingYear,
  );
  const freshness = freshnessFor(record.publishedAt, now, config.collectionPolicy);
  const companyNeedsReview = companies.some((company) => company.needsReview);
  const multipleCompanies = companies.length > 1;
  const frameworkNeedsReview = new Set(["corrected", "disputed"]).has(
    frameworkClassification.eventState,
  ) || frameworkClassification.needsReview;
  const needsReview =
    stageClassification.needsReview ||
    companyNeedsReview ||
    multipleCompanies ||
    frameworkNeedsReview ||
    annotations.needsReview;
  // 원문 URL 근거는 두 경로 중 하나로만 확보한다. NAVER 검색 API가 직접 준 원문
  // 링크이거나, Google News RSS 링크를 발행사 주소로 되돌린 뒤 그 페이지가 살아
  // 있고 제목까지 일치하는 것을 확인한 경우다. 둘 다 아니면 공개 상태를 바꾸지 않는다.
  const resolvedByGoogle =
    record.sourceVerification?.status === RESOLUTION_STATUS.verified;
  const requiresSourceVerification =
    !record.originalUrl ||
    (!record.collectionSources.includes("naver") && !resolvedByGoogle);
  const eligibleForStatusAggregation =
    includeInPrimaryDashboard && !requiresSourceVerification && !needsReview;
  const companyConfidence = Math.min(
    ...companies.map((company) => company.confidence),
  );
  const confidence = Number(
    (stageClassification.confidence * 0.7 + companyConfidence * 0.3).toFixed(2),
  );
  const reasonCodes = [
    ...stageClassification.reasonCodes,
    ...new Set(companies.map((company) => company.reasonCode)),
  ];
  if (multipleCompanies) reasonCodes.push("multiple_companies");
  if (frameworkClassification.retainMainState) {
    reasonCodes.push("retain_main_state");
  }
  if (!includeInPrimaryDashboard) reasonCodes.push("excluded_from_primary_scope");

  return {
    id: `news_${createHash("sha256")
      .update(record.url || normalizedTitleKey(record.title))
      .digest("hex")
      .slice(0, 16)}`,
    title: record.title,
    media: record.media,
    publishedAt: record.publishedAt,
    url: record.url,
    originalUrl: record.originalUrl,
    ...(record.sourceVerification
      ? { sourceVerification: record.sourceVerification }
      : {}),
    classification: {
      stage: stageClassification.stage,
      ...(stageClassification.suggestedStage
        ? { suggestedStage: stageClassification.suggestedStage }
        : {}),
      eventType: stageClassification.eventType,
      transitionHint: stageClassification.transitionHint,
      statusCode: frameworkClassification.statusCode,
      statusName: frameworkClassification.statusName,
      statusLabel: frameworkClassification.statusLabel,
      eventState: frameworkClassification.eventState,
      eventStateCode: frameworkClassification.eventStateCode,
      retainMainState: frameworkClassification.retainMainState,
      statusBasis: frameworkClassification.statusBasis,
      scopeClassification,
      includeInPrimaryDashboard,
      eligibleForStatusAggregation,
      requiresSourceVerification,
      parallelStates: frameworkClassification.parallelStates,
      ...(voteData ? { voteData } : {}),
      annotations,
      confidence,
      needsReview,
      freshness,
      companies,
      ...(!includeInPrimaryDashboard
        ? {
            excludedAudit: {
              scopeClassification,
              companyScopes: companies.map((company) => ({
                companyId: company.companyId,
                scopeClassification: company.scopeClassification,
                coveredWorkerRelation: company.coveredWorkerRelation,
                reasonCodes: company.reasonCodes,
              })),
              derivedStatusCode: derivedFrameworkClassification.statusCode,
              excludedFromStatusIssuesAndMediaExposure: true,
            },
          }
        : {}),
      reasonCodes: [...new Set(reasonCodes)],
      collectionSources: record.collectionSources,
    },
  };
}

function createCollectionStats() {
  return {
    totalQueries: 0,
    successfulQueries: 0,
    failedQueries: 0,
    naverQueries: 0,
    googleQueries: 0,
    fallbackQueries: 0,
    sourceFailures: 0,
    receivedItems: 0,
    discardedInvalid: 0,
    discardedOutsideTargetYear: 0,
    discardedIrrelevant: 0,
  };
}

/**
 * 공개 후보로 분류된 기사에 한해 Google News 링크를 발행사 원문 URL로 되돌린다.
 * 성공한 건만 record.originalUrl과 record.sourceVerification을 채우므로, 실패한
 * 후보는 재분류 없이 기존의 `requiresSourceVerification = true` 상태로 남는다.
 */
async function resolveOriginalUrls(preliminary, config, options) {
  const stats = {
    attempted: 0,
    verified: 0,
    failed: 0,
    skipped: 0,
    byStatus: {},
  };
  if (options.resolveOriginalUrls === false) {
    stats.skipped = preliminary.length;
    return stats;
  }

  const pending = preliminary.filter(
    ({ record, classification }) =>
      classification.classification.includeInPrimaryDashboard &&
      !record.originalUrl &&
      typeof record.url === "string",
  );
  const limit = options.maxResolutions ?? config.collectionPolicy.maxUrlResolutions ?? 60;

  for (const entry of pending.slice(0, limit)) {
    stats.attempted += 1;
    const verification = await resolveGoogleNewsUrl(entry.record.url, entry.record.title, {
      canonicalize: canonicalizeUrl,
      inferMedia,
    });
    stats.byStatus[verification.status] =
      (stats.byStatus[verification.status] ?? 0) + 1;

    if (verification.status === RESOLUTION_STATUS.verified) {
      entry.record.originalUrl = verification.originalUrl;
      entry.record.sourceVerification = verification;
      stats.verified += 1;
    } else {
      // 되돌리기에 실패해도 감사 기록은 남긴다. 다만 originalUrl은 비워 두어
      // 상태 집계 후보로 올라가지 않게 한다.
      entry.record.sourceVerification = verification;
      stats.failed += 1;
    }
    if (options.verbose) {
      console.log(
        `[원문 확인] ${verification.status} ${verification.originalUrl ?? entry.record.url}`,
      );
    }
    await delay(config.collectionPolicy.requestDelayMs);
  }

  stats.skipped = Math.max(pending.length - stats.attempted, 0);
  return stats;
}

async function collectCandidates(config, options, year, now) {
  const credentials = naverCredentials(config);
  if (options.source === "naver" && !credentials) {
    throw new Error(
      "--source naver를 사용하려면 NAVER_CLIENT_ID와 NAVER_CLIENT_SECRET이 필요합니다.",
    );
  }

  const primarySource =
    options.source === "google" || (options.source === "auto" && !credentials)
      ? "google"
      : "naver";
  const stats = createCollectionStats();
  const records = [];
  const targetStart = Date.parse(`${year}-01-01T00:00:00+09:00`);
  const targetEnd = Date.parse(`${year + 1}-01-01T00:00:00+09:00`);
  const maxItems = Math.min(
    options.maxPerQuery ?? config.collectionPolicy.maxItemsPerQuery,
    100,
  );

  if (options.source === "auto" && !credentials) {
    console.log("네이버 API 자격증명이 없어 Google News RSS를 사용합니다.");
  }

  for (const company of config.companies) {
    let companyCandidateCount = 0;
    for (const query of company.queries) {
      stats.totalQueries += 1;
      let items = [];
      let querySucceeded = false;

      if (primarySource === "naver") {
        try {
          items = await fetchNaverNews(query, maxItems, config, credentials);
          stats.naverQueries += 1;
          querySucceeded = true;
        } catch (error) {
          stats.sourceFailures += 1;
          console.error(`[네이버 실패] ${company.name}: ${error.message}`);
          if (options.source === "auto") {
            try {
              items = await fetchGoogleNews(query, maxItems, year, config);
              stats.googleQueries += 1;
              stats.fallbackQueries += 1;
              querySucceeded = true;
            } catch (fallbackError) {
              stats.sourceFailures += 1;
              console.error(`[RSS 대체 실패] ${company.name}: ${fallbackError.message}`);
            }
          }
        }
      } else {
        try {
          items = await fetchGoogleNews(query, maxItems, year, config);
          stats.googleQueries += 1;
          querySucceeded = true;
        } catch (error) {
          stats.sourceFailures += 1;
          console.error(`[Google RSS 실패] ${company.name}: ${error.message}`);
        }
      }

      if (querySucceeded) stats.successfulQueries += 1;
      else stats.failedQueries += 1;
      stats.receivedItems += items.length;

      for (const item of items) {
        if (!item.title || !item.url || !item.publishedAt) {
          stats.discardedInvalid += 1;
          continue;
        }
        const publishedTimestamp = Date.parse(item.publishedAt);
        if (publishedTimestamp < targetStart || publishedTimestamp >= targetEnd) {
          stats.discardedOutsideTargetYear += 1;
          continue;
        }
        if (!hasRelevantSignal(item.title, config)) {
          stats.discardedIrrelevant += 1;
          continue;
        }
        records.push({
          ...item,
          originCompanyIds: [company.id],
        });
        companyCandidateCount += 1;
      }

      if (options.verbose) {
        console.log(`${company.name}: '${query}' → ${items.length}건 수신`);
      }
      await delay(config.collectionPolicy.requestDelayMs);
    }
    console.log(`${company.name}: 분류 전 후보 ${companyCandidateCount}건`);
  }

  if (stats.successfulQueries === 0) {
    throw new Error(
      "모든 뉴스 쿼리가 실패했습니다. 기존 결과 파일은 변경하지 않습니다.",
    );
  }

  const urlDeduplicated = deduplicateBy(records, (record) => record.url);
  const titleDeduplicated = deduplicateBy(
    urlDeduplicated,
    (record) => normalizedTitleKey(record.title),
  );
  // 원문 URL 되돌리기는 네트워크 비용이 크므로, 먼저 분류해서 공개 후보로 남은
  // 기사에만 적용한다. 감사 격리 대상은 공개 상태를 바꾸지 않으므로 되돌리지 않는다.
  const preliminary = titleDeduplicated.map((record) => ({
    record,
    classification: classifyArticle(record, config, now, year),
  }));
  const resolutionStats = await resolveOriginalUrls(preliminary, config, options);
  const articles = preliminary
    .map(({ record, classification }) =>
      record.sourceVerification
        ? classifyArticle(record, config, now, year)
        : classification,
    )
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
  const scopeCounts = Object.fromEntries(
    config.scopePolicy.classifications.map((scope) => [scope, 0]),
  );
  for (const article of articles) {
    scopeCounts[article.classification.scopeClassification] += 1;
  }
  const companyScopeCounts = Object.fromEntries(
    config.scopePolicy.classifications.map((scope) => [scope, 0]),
  );
  for (const article of articles) {
    for (const company of article.classification.companies) {
      companyScopeCounts[company.scopeClassification] += 1;
    }
  }

  return {
    articles,
    stats: {
      ...stats,
      candidatesBeforeDeduplication: records.length,
      removedByUrlDeduplication: records.length - urlDeduplicated.length,
      removedByTitleDeduplication:
        urlDeduplicated.length - titleDeduplicated.length,
      finalCandidates: articles.length,
      urlResolution: resolutionStats,
      statusAggregationCandidates: articles.filter(
        (article) => article.classification.eligibleForStatusAggregation,
      ).length,
      primaryDashboardCandidates: articles.filter(
        (article) => article.classification.includeInPrimaryDashboard,
      ).length,
      excludedAuditCandidates: articles.filter(
        (article) => !article.classification.includeInPrimaryDashboard,
      ).length,
      scopeCounts,
      excludedCompanyMatches: Object.entries(companyScopeCounts)
        .filter(([scope]) => scope !== "PRIMARY_DIRECT_UNION")
        .reduce((total, [, count]) => total + count, 0),
      companyScopeCounts,
    },
    primarySource,
  };
}

function companyCoverage(config, articles) {
  return config.companies.map((company) => {
    const matchingArticles = articles.filter((article) =>
      article.classification.includeInPrimaryDashboard &&
      article.classification.companies.some(
        (match) =>
          match.companyId === company.id && match.includeInPrimaryDashboard,
      ),
    );
    const excludedAuditCount = articles.filter((article) =>
      article.classification.companies.some(
        (match) =>
          match.companyId === company.id && !match.includeInPrimaryDashboard,
      ),
    ).length;
    return {
      companyId: company.id,
      companyName: company.name,
      frequency: "daily",
      selection: company.selection,
      candidateCount: matchingArticles.length,
      excludedAuditCount,
      needsReviewCount: matchingArticles.filter(
        (article) => article.classification.needsReview,
      ).length,
      latestPublishedAt: matchingArticles[0]?.publishedAt ?? null,
    };
  });
}

function publicTaxonomy(config) {
  return {
    stages: config.taxonomy.stages.map(({ code, label, order }) => ({
      code,
      label,
      order,
    })),
    normalProgression: config.taxonomy.transitionPolicy.normalProgression,
    stateKey: config.taxonomy.transitionPolicy.stateKey,
    dateAloneDoesNotImplyProgression: true,
    statusFramework: {
      states: config.taxonomy.statusFramework.states,
      eventStates: config.taxonomy.statusFramework.eventStates,
      frameworkEventStateCodes:
        config.taxonomy.statusFramework.frameworkEventStateCodes,
      s4RequiresExplicitImpasseOrMediation: true,
      industrialActionRetainsMainStateWithoutS4Evidence: true,
    },
  };
}

function buildOutput(config, collection, options, year, now) {
  const kstDate = kstDateKey(now);
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    batch: {
      status: collection.stats.failedQueries > 0 ? "partial" : "complete",
      frequency: "daily",
      timezone: config.collectionPolicy.timezone,
      recommendedRunTime: config.collectionPolicy.recommendedRunTime,
      cron: config.collectionPolicy.cron,
      kstDate,
      targetYear: year,
      requestedSourceMode: options.source,
      primarySource: collection.primarySource,
      stats: collection.stats,
    },
    taxonomy: publicTaxonomy(config),
    scopePolicy: config.scopePolicy,
    scopeReviewAgent: config.scopeReviewAgent,
    metadataSchemas: config.metadataSchemas,
    companyCoverage: companyCoverage(config, collection.articles),
    articles: collection.articles,
  };
}

async function acquireLock(outputPath) {
  const lockPath = `${outputPath}.lock`;
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    return async () => {
      await handle.close();
      await unlink(lockPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const lockStats = await stat(lockPath);
    if (Date.now() - lockStats.mtimeMs > LOCK_STALE_AFTER_MILLISECONDS) {
      await unlink(lockPath);
      return acquireLock(outputPath);
    }
    throw new Error(
      `다른 수집 배치가 실행 중입니다. 잠금 파일: ${lockPath}`,
    );
  }
}

async function writeJsonAtomically(path, payload) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function alreadyRanToday(outputPath, now) {
  const existing = await readJsonIfPresent(outputPath);
  return existing?.batch?.kstDate === kstDateKey(now);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const now = new Date();
  const config = await readJson(options.configPath);
  validateConfiguration(config);
  const year = options.year ?? currentKstYear(now);

  if (
    !options.force &&
    !options.dryRun &&
    (await alreadyRanToday(options.outputPath, now))
  ) {
    console.log(
      `${kstDateKey(now)} KST 일일 배치가 이미 완료되었습니다. 재실행하려면 --force를 사용하세요.`,
    );
    return;
  }

  let releaseLock = null;
  try {
    if (!options.dryRun) {
      releaseLock = await acquireLock(options.outputPath);
      if (!options.force && (await alreadyRanToday(options.outputPath, now))) {
        console.log(`${kstDateKey(now)} KST 일일 배치가 이미 완료되었습니다.`);
        return;
      }
    }

    const collection = await collectCandidates(config, options, year, now);
    const output = buildOutput(config, collection, options, year, now);
    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      await writeJsonAtomically(options.outputPath, output);
      console.log(
        `완료: ${output.articles.length}건 → ${options.outputPath} (${output.batch.status})`,
      );
    }
  } finally {
    if (releaseLock) await releaseLock();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`뉴스 수집 실패: ${error.message}`);
    process.exitCode = 1;
  });
}

export { classifyArticle, classifyStage, validateConfiguration };

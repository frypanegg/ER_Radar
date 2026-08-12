#!/usr/bin/env node
// DART 전자공시에서 노사관계 관련 공시를 수집한다.
//
// 왜 필요한가
//   과거 교섭의 단계별 일정을 뉴스 검색으로 채우다 2021~2022년에서 막혔다. 오래된 기사는
//   색인에서 밀리고, 같은 회사의 최근 교섭 기사가 대신 올라온다. 실제로 날짜를 특정할 수
//   없어 여러 건을 버렸다.
//
//   공시는 다르다. 접수일자(rcept_dt)가 규정으로 정해져 있고, 상장·공시제출 법인의 파업·
//   조업중단은 주요경영사항 공시 대상이다. 즉 **날짜가 확정된 1차 근거**를 얻을 수 있다.
//
// 경계
//   - 공시 본문을 저장하지 않는다. 회사명·보고서명·접수일자·접수번호와 열람 URL만 남긴다.
//     기사 본문을 복제하지 않는 기존 원칙과 같다.
//   - 이 스크립트는 후보만 만든다. 공개 사실로 올리는 것은 사람이 확인한 뒤다.
//   - 자격증명은 OPENDART_API_KEY 환경 변수로만 받는다.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const root = new URL("../", import.meta.url);
const CORP_CODE_CACHE = new URL("data/dart-corp-codes.json", root);
const OUTPUT_PATH = new URL("data/dart-disclosure-candidates.json", root);

/**
 * 노사관계 공시로 볼 보고서명 패턴.
 *
 * 처음에는 파업·쟁의·노동조합 같은 말을 찾았고 12개 법인 전부 0건이 나왔다. 공시 제목은
 * 표준 서식명이라 사건을 그대로 쓰지 않는다. 실제로 파업으로 인한 조업 정지는 **생산중단**
 * 서식으로 접수되고(현대자동차 2021~2026년 2건), 보도 대응은 **풍문또는보도에대한해명**으로
 * 나온다. 그래서 서식명 기준으로 다시 잡았다.
 *
 * 넓게 잡고 사람이 걸러내는 편이, 놓치는 것보다 낫다. 이 목록은 후보이고 공개 사실이 아니다.
 */
export const LABOR_REPORT_PATTERNS = [
  /생산\s*중단/,
  /조업\s*중단/,
  /영업\s*정지/,
  /직장\s*폐쇄/,
  /풍문또는보도에대한해명/,
  /파업/,
  /쟁의/,
  /노동조합/,
  /임금\s*협약/,
  /단체\s*협약/,
  /임단협/,
];

export function isLaborDisclosure(reportName) {
  if (typeof reportName !== "string") return false;
  return LABOR_REPORT_PATTERNS.some((pattern) => pattern.test(reportName));
}

/** DART 접수번호로 공시 열람 주소를 만든다. 이 URL이 사건의 근거가 된다. */
export function disclosureViewerUrl(receiptNumber) {
  return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receiptNumber}`;
}

/** YYYYMMDD → YYYY-MM-DD. 시드의 date 형식과 맞춘다. */
export function toIsoDate(compact) {
  if (!/^\d{8}$/.test(compact ?? "")) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}

/**
 * corpCode.zip은 단일 항목 ZIP이다. 외부 의존성을 늘리지 않기 위해 로컬 파일 헤더만 읽고
 * raw deflate를 직접 푼다.
 */
export function unzipSingleEntry(buffer) {
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw new Error("ZIP 형식이 아닙니다.");
  const method = buffer.readUInt16LE(8);
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  const start = 30 + nameLength + extraLength;
  const body = buffer.subarray(start);
  if (method === 0) return body.toString("utf8");
  return inflateRawSync(body).toString("utf8");
}

/** corpCode.xml에서 법인명 → 고유번호를 뽑는다. 상장 여부와 무관하게 제출 법인이 모두 있다. */
export function parseCorpCodes(xml) {
  const entries = [];
  for (const match of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const block = match[1];
    const pick = (tag) => (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? "").trim();
    entries.push({
      corpCode: pick("corp_code"),
      corpName: pick("corp_name"),
      stockCode: pick("stock_code"),
    });
  }
  return entries;
}

/**
 * 추적 법인과 공시 법인을 잇는다. 법적 실명이 정확히 같지 않은 경우가 있어(상호 변경,
 * 지주사 전환) 종목코드를 먼저 보고, 없으면 이름으로 맞춘다. 자동으로 억지 매칭하지 않고
 * 못 찾은 법인은 그대로 보고한다.
 */
export function matchCorpCodes(trackingCompanies, corpEntries, stockCodeBySlug = {}) {
  const byStock = new Map(
    corpEntries.filter((entry) => entry.stockCode).map((entry) => [entry.stockCode, entry]),
  );
  const byName = new Map(corpEntries.map((entry) => [entry.corpName.replace(/\s+/g, ""), entry]));

  const matched = [];
  const unmatched = [];
  for (const company of trackingCompanies) {
    const stock = stockCodeBySlug[company.id];
    const entry =
      (stock && byStock.get(stock)) ||
      byName.get(company.legalName.replace(/\s*주식회사\s*/g, "").replace(/\s+/g, "")) ||
      byName.get(company.legalName.replace(/\s+/g, ""));
    if (entry) {
      matched.push({ slug: company.id, legalName: company.legalName, corpCode: entry.corpCode, corpName: entry.corpName });
    } else {
      unmatched.push({ slug: company.id, legalName: company.legalName });
    }
  }
  return { matched, unmatched };
}

// 추적 법인의 상장 종목코드. 비상장(한국지엠)과 사업회사 분할(포스코)은 이름 매칭에 맡긴다.
const STOCK_CODE_BY_SLUG = {
  "hyundai-motor": "005380",
  kia: "000270",
  "samsung-electronics": "005930",
  "hd-hyundai-heavy-industries": "329180",
  "sk-hynix": "000660",
  "hyundai-mobis": "012330",
  "hanwha-ocean": "042660",
  "hyundai-steel": "004020",
  "lg-electronics": "066570",
  "doosan-enerbility": "034020",
};

async function fetchCorpCodes(apiKey) {
  try {
    const cached = JSON.parse(await readFile(CORP_CODE_CACHE, "utf8"));
    if (Array.isArray(cached.entries) && cached.entries.length > 0) return cached.entries;
  } catch {
    // 캐시가 없으면 받아온다.
  }
  const response = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${apiKey}`);
  if (!response.ok) throw new Error(`corpCode 조회 실패: HTTP ${response.status}`);
  const xml = unzipSingleEntry(Buffer.from(await response.arrayBuffer()));
  const entries = parseCorpCodes(xml);
  await mkdir(new URL("data/", root), { recursive: true });
  await writeFile(
    CORP_CODE_CACHE,
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), entries }, null, 2)}\n`,
    "utf8",
  );
  return entries;
}

async function fetchDisclosures(apiKey, corpCode, since, until) {
  const results = [];
  for (let page = 1; page <= 10; page += 1) {
    const url =
      `https://opendart.fss.or.kr/api/list.json?crtfc_key=${apiKey}` +
      `&corp_code=${corpCode}&bgn_de=${since}&end_de=${until}&page_no=${page}&page_count=100`;
    const response = await fetch(url);
    if (!response.ok) break;
    const payload = await response.json();
    // 013 = 조회 결과 없음. 오류가 아니다.
    if (payload.status === "013") break;
    if (payload.status !== "000") throw new Error(`list 조회 실패: ${payload.status} ${payload.message ?? ""}`);
    results.push(...(payload.list ?? []));
    if (page >= Number(payload.total_page ?? 1)) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return results;
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main() {
  const apiKey = process.env.OPENDART_API_KEY;
  if (!apiKey) throw new Error("OPENDART_API_KEY 환경 변수가 필요합니다.");

  const since = argValue("--since", "20210101");
  const until = argValue("--until", new Date().toISOString().slice(0, 10).replaceAll("-", ""));

  const seed = JSON.parse(await readFile(new URL("data/historical-fact-seed.json", root), "utf8"));
  const corpEntries = await fetchCorpCodes(apiKey);
  const { matched, unmatched } = matchCorpCodes(seed.trackingCompanies, corpEntries, STOCK_CODE_BY_SLUG);

  console.log(`공시 법인 매칭: ${matched.length}건 · 미매칭 ${unmatched.length}건`);
  for (const company of unmatched) console.log(`  미매칭: ${company.legalName}`);

  const candidates = [];
  for (const company of matched) {
    const disclosures = await fetchDisclosures(apiKey, company.corpCode, since, until);
    const labor = disclosures.filter((item) => isLaborDisclosure(item.report_nm));
    for (const item of labor) {
      candidates.push({
        companyId: company.slug,
        companyLegalName: company.legalName,
        corpName: item.corp_name,
        reportName: item.report_nm,
        // 접수일자는 규정으로 정해진 날짜다. 이것이 이 경로의 핵심 가치다.
        receivedOn: toIsoDate(item.rcept_dt),
        receiptNumber: item.rcept_no,
        sourceUrl: disclosureViewerUrl(item.rcept_no),
        filerName: item.flr_nm,
      });
    }
    console.log(`  ${company.legalName}: 공시 ${disclosures.length}건 중 노사관계 ${labor.length}건`);
  }

  candidates.sort((left, right) => (right.receivedOn ?? "").localeCompare(left.receivedOn ?? ""));
  await writeFile(
    OUTPUT_PATH,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        purpose:
          "DART 전자공시의 노사관계 공시 후보. 접수일자가 확정된 1차 근거이며, 사람이 확인한 뒤 historical-flow-events.json으로 옮긴다.",
        collectedAt: new Date().toISOString(),
        range: { since: toIsoDate(since), until: toIsoDate(until) },
        unmatchedCompanies: unmatched,
        candidateCount: candidates.length,
        candidates,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`\n노사관계 공시 후보 ${candidates.length}건을 data/dart-disclosure-candidates.json에 기록했습니다.`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// 메일에서 승인된 신규 기업의 최근 5개년 기사 후보를 기존 Supabase 검토함에 넣는다.
//
// 제목·매체·날짜·URL만 sources에 비공개로 저장하고, scope_review_audits에서는 전부
// UNKNOWN_REVIEW로 시작한다. 원청 직접고용 사용자와 적용 근로자 관계가 모두 확인되기
// 전에는 공개 교섭 기록(bargaining_cases)을 만들지 않는다.

import { readFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

const root = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("data/source-config.json", root), "utf8"));

function requireEnv(names) {
  for (const name of names) if (process.env[name]?.trim()) return process.env[name].trim();
  throw new Error(`${names.join(" 또는 ")} 환경 변수가 필요합니다.`);
}

const baseUrl = requireEnv(["SUPABASE_URL", "SUPABASE_PJT_URL"]).replace(/\/$/, "");
const serviceKey = requireEnv(["SUPABASE_SERVICE_ROLE_KEY"]);
const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
const jsonHeaders = { ...headers, "content-type": "application/json" };

function nodeText(value) {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value && typeof value === "object" ? String(value["#text"] ?? value.__cdata ?? "") : "";
}

function cleanText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").normalize("NFKC").replace(/\s+/g, " ").trim();
}

async function rest(path, init = {}) {
  return fetch(`${baseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...(init.body ? jsonHeaders : headers), ...(init.headers ?? {}) },
  });
}

async function fetchCandidates(companyName, year) {
  const query = `"${companyName}" (임금협상 OR 임단협 OR 단체교섭 OR 잠정합의 OR 파업) after:${year}-01-01 before:${year + 1}-01-01`;
  const url = new URL(config.sources.googleNews.endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("hl", config.sources.googleNews.language);
  url.searchParams.set("gl", config.sources.googleNews.country);
  url.searchParams.set("ceid", config.sources.googleNews.edition);
  const response = await fetch(url, { headers: { Accept: "application/rss+xml", "User-Agent": "ER-Radar-Onboarding/1.0" } });
  if (!response.ok) throw new Error(`Google News RSS ${response.status}`);
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false, trimValues: true }).parse(await response.text());
  const raw = parsed?.rss?.channel?.item;
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return items.slice(0, 30).map((item) => {
    const publisher = cleanText(nodeText(item.source));
    let title = cleanText(nodeText(item.title));
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3)).trim();
    return {
      candidateYear: year,
      title,
      publisher: publisher || "매체 미상",
      publishedAt: Number.isFinite(Date.parse(nodeText(item.pubDate))) ? new Date(nodeText(item.pubDate)).toISOString() : null,
      url: nodeText(item.link),
    };
  }).filter((item) => item.title && /^https?:\/\//.test(item.url));
}

async function ensureSource(candidate) {
  const existing = await rest(`sources?select=id&original_url=eq.${encodeURIComponent(candidate.url)}&limit=1`);
  const rows = existing.ok ? await existing.json() : [];
  if (rows[0]?.id) return rows[0].id;
  const inserted = await rest("sources", {
    method: "POST",
    headers: { prefer: "return=representation" },
    body: JSON.stringify({
      original_url: candidate.url,
      publisher_name: candidate.publisher,
      source_type: "NEWS",
      headline: candidate.title,
      source_published_at: candidate.publishedAt,
      source_tier: "C",
      confidence_score: 0,
      verification_status: "NEEDS_REVIEW",
      is_published: false,
    }),
  });
  if (!inserted.ok) throw new Error(`기사 후보 저장 실패: ${inserted.status}`);
  return (await inserted.json())[0]?.id;
}

async function ensureAudit(companyId, candidate, sourceId) {
  const existing = await rest(`scope_review_audits?select=id&company_id=eq.${companyId}&source_id=eq.${sourceId}&limit=1`);
  const rows = existing.ok ? await existing.json() : [];
  if (rows.length > 0) return false;
  const response = await rest("scope_review_audits", {
    method: "POST",
    body: JSON.stringify({
      company_id: companyId,
      source_id: sourceId,
      candidate_reference_url: candidate.url,
      candidate_title: candidate.title,
      covered_worker_relation: "UNKNOWN",
      scope_classification: "UNKNOWN_REVIEW",
      include_in_primary_dashboard: false,
      decision_reason: `${candidate.candidateYear}년 과거 기사 후보 · 법인 직접사용자와 노조 적용 근로자 관계를 사람 검토하기 전 공개 금지`,
      reviewer_type: "AGENT",
      rule_version: config.scopeReviewAgent.ruleVersion,
      review_status: "PENDING",
    }),
  });
  if (!response.ok) throw new Error(`범위 검토 후보 저장 실패: ${response.status}`);
  return true;
}

const requestResponse = await rest("company_add_requests?select=*&status=eq.APPROVED&review_note=not.like.*과거자료%20수집%20완료*&order=reviewed_at.asc&limit=10");
if (!requestResponse.ok) throw new Error(`승인 기업 조회 실패: ${requestResponse.status}`);
const requests = await requestResponse.json();
const currentYear = Number(new Intl.DateTimeFormat("en", { timeZone: "Asia/Seoul", year: "numeric" }).format(new Date()));
let total = 0;

for (const addition of requests) {
  try {
    const slug = `pending-${addition.id.replaceAll("-", "").slice(0, 16)}`;
    const companyResponse = await rest(`tracked_companies?select=id&slug=eq.${slug}&limit=1`);
    const companyRows = companyResponse.ok ? await companyResponse.json() : [];
    const companyId = companyRows[0]?.id;
    if (!companyId) throw new Error("승인 시 생성한 비공개 기업을 찾을 수 없습니다.");

    let added = 0;
    for (let year = currentYear - 4; year <= currentYear; year += 1) {
      for (const candidate of await fetchCandidates(addition.company_legal_name, year)) {
        const sourceId = await ensureSource(candidate);
        if (sourceId && await ensureAudit(companyId, candidate, sourceId)) added += 1;
      }
    }
    total += added;
    await rest(`company_add_requests?id=eq.${addition.id}&status=eq.APPROVED`, {
      method: "PATCH",
      body: JSON.stringify({
        review_note: `아침 알림 메일에서 승인 · 과거자료 수집 완료(${currentYear - 4}~${currentYear}, 신규 후보 ${added}건)`,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (error) {
    await rest(`company_add_requests?id=eq.${addition.id}&status=eq.APPROVED`, {
      method: "PATCH",
      body: JSON.stringify({
        review_note: `아침 알림 메일에서 승인 · 과거자료 수집 재시도 필요(${String(error?.message ?? error).slice(0, 300)})`,
        updated_at: new Date().toISOString(),
      }),
    });
  }
}

console.log(`승인 기업 ${requests.length}건 · 비공개 원청 범위 검토 후보 ${total}건 신규 적재`);

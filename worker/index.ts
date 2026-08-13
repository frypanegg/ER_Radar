/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  DASHBOARD_ADMIN_CODE?: string;
  // 일일 수집 워크플로를 깨우는 데만 쓰는 토큰. actions:write 하나면 된다.
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_DISPATCH_REPOSITORY?: string;
  GITHUB_DISPATCH_WORKFLOW?: string;
  GITHUB_DISPATCH_REF?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const ROBOTS_TAG = "noindex, nofollow, noarchive, nosnippet, noimageindex";
const REVIEW_KINDS = new Set(["correction", "company"]);

function withRobotsTag(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", ROBOTS_TAG);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function hasSameSecret(provided: string | null, expected: string | undefined) {
  if (!provided || !expected) return false;
  const providedBytes = new TextEncoder().encode(provided);
  const expectedBytes = new TextEncoder().encode(expected);
  const length = Math.max(providedBytes.length, expectedBytes.length);
  let mismatch = providedBytes.length ^ expectedBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (providedBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function isOptionalHttpUrl(value: unknown) {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function cleanOptionalText(value: unknown, maximumLength: number) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= maximumLength ? text : null;
}

function supabaseHeaders(env: Env, includeJson = false) {
  const headers: Record<string, string> = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY ?? ""}`,
  };
  if (includeJson) headers["content-type"] = "application/json";
  return headers;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function reviewSignature(secret: string, kind: string, id: string, expires: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${kind}:${id}:${expires}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validateReviewToken(env: Env, kind: string, id: string, expires: string, signature: string) {
  if (!env.DASHBOARD_ADMIN_CODE || !REVIEW_KINDS.has(kind) || !/^[0-9a-f-]{36}$/i.test(id)) return false;
  const expiry = Number(expires);
  if (!Number.isInteger(expiry) || expiry < Math.floor(Date.now() / 1000)) return false;
  return hasSameSecret(signature, await reviewSignature(env.DASHBOARD_ADMIN_CODE, kind, id, expires));
}

function htmlResponse(body: string, status = 200) {
  return new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>노사교섭 레이더 관리자 확인</title><style>body{margin:0;background:#f3f8f8;color:#17364a;font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}.wrap{max-width:660px;margin:7vh auto;padding:24px}.card{background:#fff;border:1px solid #d7e7e8;border-radius:18px;padding:30px;box-shadow:0 16px 44px #1232}.eyebrow{color:#138a83;font-weight:800;font-size:13px}h1{font-size:28px;margin:8px 0 18px}.detail{background:#f5faf9;border-radius:12px;padding:16px;line-height:1.7}.actions{display:flex;gap:10px;margin-top:22px}.actions form{flex:1}.actions button{width:100%;min-height:46px;border-radius:10px;font-weight:800;cursor:pointer}.approve{border:1px solid #138f87;background:#138f87;color:#fff}.reject{border:1px solid #d3dde2;background:#fff;color:#6d4c45}small{display:block;color:#687e8e;line-height:1.6;margin-top:16px}</style></head><body><main class="wrap">${body}</main></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleCompanyAddRequest(request: Request, env: Env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "POST 방식만 지원" }, 405);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.DASHBOARD_ADMIN_CODE) {
    return jsonResponse({ error: "추적 기업 추가용 데이터베이스 연결 미설정" }, 503);
  }

  if (!hasSameSecret(request.headers.get("x-dashboard-admin-code"), env.DASHBOARD_ADMIN_CODE)) {
    return jsonResponse({ error: "관리 코드 불일치" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    payload = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "요청 형식 오류" }, 400);
  }

  const companyLegalName = cleanOptionalText(payload.companyLegalName, 120);
  const industry = cleanOptionalText(payload.industry, 80);
  const rationale = cleanOptionalText(payload.rationale, 800);
  const websiteUrl = cleanOptionalText(payload.websiteUrl, 500);

  if (!companyLegalName || companyLegalName.length < 2) {
    return jsonResponse({ error: "법인 실명 2자 이상 입력 필요" }, 400);
  }
  if (!isOptionalHttpUrl(websiteUrl)) {
    return jsonResponse({ error: "참고 URL은 http·https 주소만 허용" }, 400);
  }
  if (payload.industry !== undefined && payload.industry !== null && payload.industry !== "" && !industry) {
    return jsonResponse({ error: "산업명 80자 이내 입력 필요" }, 400);
  }
  if (payload.rationale !== undefined && payload.rationale !== null && payload.rationale !== "" && !rationale) {
    return jsonResponse({ error: "추가 사유 800자 이내 입력 필요" }, 400);
  }

  const endpoint = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/company_add_requests`;
  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
        prefer: "return=representation",
      },
      body: JSON.stringify({
        company_legal_name: companyLegalName,
        industry,
        website_url: websiteUrl,
        rationale,
        status: "PENDING",
        admin_code_verified_at: new Date().toISOString(),
      }),
    });
  } catch {
    return jsonResponse({ error: "요청 저장 중 연결 오류 발생 · 잠시 후 재시도" }, 502);
  }

  if (!upstream.ok) {
    return jsonResponse({ error: "요청 저장 실패 · 관리자 설정 확인 필요" }, 502);
  }

  let requestId: string | null = null;
  try {
    const rows = await upstream.json() as Array<{ request_id?: string; id?: string }>;
    requestId = rows[0]?.request_id ?? rows[0]?.id ?? null;
  } catch {
    // 저장 성공 응답의 식별자가 없더라도 요청 접수 자체는 성공으로 처리한다.
  }

  return jsonResponse({ message: "추적 기업 추가 요청 접수 완료", requestId }, 201);
}

/**
 * 공개 사실 데이터를 Supabase에서 읽어 화면이 쓰는 모양으로 돌려준다.
 *
 * 화면은 빌드 시점에 정적 시드를 번들에 담고 있고, 이 응답이 오면 그걸로 갈아탄다.
 * DB가 비어 있거나 연결이 끊겨도 화면이 비지 않아야 하므로, 실패는 조용히 null로
 * 알리고 화면이 정적 시드를 그대로 쓰게 한다.
 *
 * 공개 게이트는 DB 질의에서 한 번 더 건다. RLS를 신뢰하되 의존하지는 않는다.
 */
async function handlePublishedFacts(env: Env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ source: "unconfigured", records: null }, 200);
  }

  const base = env.SUPABASE_URL.replace(/\/$/, "");
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  };
  const select = [
    "bargaining_year",
    "agreement_type",
    "primary_stage",
    "bargaining_unit_name",
    "current_fact_summary",
    "latest_event_on",
    "source_tier",
    "confidence_score",
    "tracked_companies!bargaining_cases_company_id_fkey(slug,legal_name)",
    "bargaining_events(occurred_on,stage_after,fact_summary,event_type,is_published)",
  ].join(",");

  let rows: unknown;
  try {
    const response = await fetch(
      `${base}/rest/v1/bargaining_cases?select=${encodeURIComponent(select)}` +
        "&is_published=eq.true&verification_status=eq.VERIFIED" +
        "&scope_classification=eq.PRIMARY_DIRECT_UNION&covered_worker_relation=eq.DIRECT" +
        "&order=bargaining_year.desc",
      { headers },
    );
    if (!response.ok) return jsonResponse({ source: "error", records: null }, 200);
    rows = await response.json();
  } catch {
    return jsonResponse({ source: "error", records: null }, 200);
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    return jsonResponse({ source: "empty", records: null }, 200);
  }

  const records = (rows as Array<Record<string, never>>).map((row) => {
    const company = (row as { tracked_companies?: { slug?: string; legal_name?: string } })
      .tracked_companies ?? {};
    const events = ((row as { bargaining_events?: Array<Record<string, string | boolean>> })
      .bargaining_events ?? [])
      .filter((event) => event.is_published !== false && event.event_type === "STAGE_CONFIRMED")
      .map((event) => ({
        date: String(event.occurred_on ?? ""),
        stage: String(event.stage_after ?? "U"),
        label: String(event.stage_after ?? ""),
        summary: String(event.fact_summary ?? ""),
      }))
      .filter((event) => event.date);

    return {
      companyId: company.slug ?? "",
      companyLegalName: company.legal_name ?? "",
      bargainingYear: Number((row as { bargaining_year?: number }).bargaining_year ?? 0),
      agreementType: String((row as { agreement_type?: string }).agreement_type ?? "UNKNOWN"),
      stage: String((row as { primary_stage?: string }).primary_stage ?? "U"),
      eventDate: String((row as { latest_event_on?: string }).latest_event_on ?? ""),
      unionName: String((row as { bargaining_unit_name?: string }).bargaining_unit_name ?? ""),
      factSummary: String((row as { current_fact_summary?: string }).current_fact_summary ?? ""),
      sourceTier: String((row as { source_tier?: string }).source_tier ?? "C"),
      confidence: Number((row as { confidence_score?: number }).confidence_score ?? 0),
      flowEvents: events,
    };
  });

  return jsonResponse({ source: "database", recordCount: records.length, records }, 200);
}

const CORRECTABLE_FIELDS = new Set([
  "stage",
  "eventDate",
  "agreementType",
  "unionName",
  "factSummary",
]);

/**
 * 교섭 기록 수정 요청을 접수한다.
 *
 * 크롤링 결과가 실제와 다를 수 있으므로 사람이 고칠 경로가 필요하다. 다만 접수와 공개는
 * 분리한다. 여기서는 PENDING으로만 적재하고, 누가·언제·무엇을 어떻게 고치려 했는지와
 * 근거 URL을 함께 남긴다. 검증되지 않은 수정이 바로 공개되면 자동 수집보다 위험하다.
 */
async function handleRecordCorrectionRequest(request: Request, env: Env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "POST 방식만 지원" }, 405);
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.DASHBOARD_ADMIN_CODE) {
    return jsonResponse({ error: "기록 수정 요청용 데이터베이스 연결 미설정" }, 503);
  }

  if (!hasSameSecret(request.headers.get("x-dashboard-admin-code"), env.DASHBOARD_ADMIN_CODE)) {
    return jsonResponse({ error: "관리 코드 불일치" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    payload = parsed as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: "요청 형식 오류" }, 400);
  }

  const targetRecordId = cleanOptionalText(payload.targetRecordId, 200);
  const companyIdKey = cleanOptionalText(payload.companyIdKey, 120);
  const companyLegalName = cleanOptionalText(payload.companyLegalName, 120);
  const fieldName = cleanOptionalText(payload.fieldName, 40);
  const proposedValue = cleanOptionalText(payload.proposedValue, 2000);
  const previousValue = cleanOptionalText(payload.previousValue, 2000);
  const evidenceUrl = cleanOptionalText(payload.evidenceUrl, 500);
  const reason = cleanOptionalText(payload.reason, 800);
  const editorName = cleanOptionalText(payload.editorName, 80);
  const editorNote = cleanOptionalText(payload.editorNote, 800);
  const bargainingYear = Number(payload.bargainingYear);

  if (!targetRecordId || !companyIdKey || !companyLegalName) {
    return jsonResponse({ error: "수정 대상 기록을 식별할 수 없음" }, 400);
  }
  if (!Number.isInteger(bargainingYear) || bargainingYear < 2000 || bargainingYear > 2100) {
    return jsonResponse({ error: "교섭연도를 확인할 수 없음" }, 400);
  }
  if (!fieldName || !CORRECTABLE_FIELDS.has(fieldName)) {
    return jsonResponse({ error: "수정할 수 없는 항목" }, 400);
  }
  if (!proposedValue) {
    return jsonResponse({ error: "수정값 입력 필요" }, 400);
  }
  // 근거 없는 수정은 접수하지 않는다. 자동 수집보다 느슨한 경로를 만들지 않기 위한 것이다.
  if (!evidenceUrl || !isOptionalHttpUrl(evidenceUrl) || evidenceUrl === "") {
    return jsonResponse({ error: "근거 원문 URL은 http·https 주소로 입력 필요" }, 400);
  }
  if (!reason) {
    return jsonResponse({ error: "수정 사유 입력 필요" }, 400);
  }
  if (!editorName) {
    return jsonResponse({ error: "수정자 이름 입력 필요" }, 400);
  }

  const endpoint = `${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/bargaining_record_corrections`;
  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
        prefer: "return=representation",
      },
      body: JSON.stringify({
        target_record_id: targetRecordId,
        company_id_key: companyIdKey,
        company_legal_name: companyLegalName,
        bargaining_year: bargainingYear,
        field_name: fieldName,
        previous_value: previousValue,
        proposed_value: proposedValue,
        evidence_url: evidenceUrl,
        reason,
        editor_name: editorName,
        editor_note: editorNote,
        status: "PENDING",
        admin_code_verified_at: new Date().toISOString(),
      }),
    });
  } catch {
    return jsonResponse({ error: "요청 저장 중 연결 오류 발생 · 잠시 후 재시도" }, 502);
  }

  if (upstream.status === 409) {
    return jsonResponse({ error: "같은 항목에 검토 대기 중인 수정 요청이 이미 있음" }, 409);
  }
  if (!upstream.ok) {
    return jsonResponse({ error: "요청 저장 실패 · 관리자 설정 확인 필요" }, 502);
  }

  let requestId: string | null = null;
  let submittedAt: string | null = null;
  try {
    const rows = await upstream.json() as Array<{ id?: string; submitted_at?: string }>;
    requestId = rows[0]?.id ?? null;
    submittedAt = rows[0]?.submitted_at ?? null;
  } catch {
    // 식별자를 읽지 못해도 접수 자체는 성공으로 처리한다.
  }

  return jsonResponse(
    {
      message: "기록 수정 요청 접수 완료 · 검토 후 공개 반영",
      requestId,
      submittedAt,
      editorName,
    },
    201,
  );
}

type ReviewRequestRow = Record<string, string | number | null>;

async function fetchReviewRequest(env: Env, kind: string, id: string) {
  const table = kind === "correction" ? "bargaining_record_corrections" : "company_add_requests";
  const response = await fetch(
    `${env.SUPABASE_URL?.replace(/\/$/, "")}/rest/v1/${table}?select=*&id=eq.${id}&limit=1`,
    { headers: supabaseHeaders(env) },
  );
  if (!response.ok) return null;
  const rows = await response.json() as ReviewRequestRow[];
  return rows[0] ?? null;
}

function reviewDetail(kind: string, row: ReviewRequestRow) {
  if (kind === "correction") {
    return [
      `<strong>${escapeHtml(row.company_legal_name)} · ${escapeHtml(row.bargaining_year)}년</strong>`,
      `수정 항목: ${escapeHtml(row.field_name)}`,
      `기존값: ${escapeHtml(row.previous_value ?? "없음")}`,
      `수정값: ${escapeHtml(row.proposed_value)}`,
      `사유: ${escapeHtml(row.reason)}`,
      `근거: <a href="${escapeHtml(row.evidence_url)}" target="_blank" rel="noreferrer">원문 열기</a>`,
    ].join("<br>");
  }
  return [
    `<strong>${escapeHtml(row.company_legal_name)}</strong>`,
    `산업: ${escapeHtml(row.industry ?? "미입력")}`,
    `추가 사유: ${escapeHtml(row.rationale ?? "미입력")}`,
    row.website_url ? `참고: <a href="${escapeHtml(row.website_url)}" target="_blank" rel="noreferrer">기업 웹사이트 열기</a>` : "",
    "승인 시 최근 5개년 기사 후보 수집 작업이 대기열에 등록됩니다.",
  ].filter(Boolean).join("<br>");
}

async function handleAdminReviewPage(request: Request, env: Env) {
  if (request.method !== "GET") return jsonResponse({ error: "GET 방식만 지원" }, 405);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.DASHBOARD_ADMIN_CODE) {
    return htmlResponse('<section class="card"><h1>관리자 검토 기능이 아직 설정되지 않았습니다.</h1></section>', 503);
  }

  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") ?? "";
  const id = url.searchParams.get("id") ?? "";
  const expires = url.searchParams.get("expires") ?? "";
  const signature = url.searchParams.get("signature") ?? "";
  if (!await validateReviewToken(env, kind, id, expires, signature)) {
    return htmlResponse('<section class="card"><h1>유효하지 않거나 만료된 확인 링크입니다.</h1><small>아침 알림 메일의 최신 링크를 사용해 주세요.</small></section>', 403);
  }

  const row = await fetchReviewRequest(env, kind, id);
  if (!row) return htmlResponse('<section class="card"><h1>요청을 찾을 수 없습니다.</h1></section>', 404);
  const status = String(row.status ?? "");
  if (status !== "PENDING") {
    return htmlResponse(`<section class="card"><p class="eyebrow">처리 완료</p><h1>이미 ${escapeHtml(status)} 상태입니다.</h1></section>`);
  }

  const hidden = `<input type="hidden" name="kind" value="${escapeHtml(kind)}"><input type="hidden" name="id" value="${escapeHtml(id)}"><input type="hidden" name="expires" value="${escapeHtml(expires)}"><input type="hidden" name="signature" value="${escapeHtml(signature)}">`;
  return htmlResponse(`<section class="card"><p class="eyebrow">관리자 최종 확인</p><h1>${kind === "correction" ? "데이터 수정 요청" : "추적 기업 추가 요청"}</h1><div class="detail">${reviewDetail(kind, row)}</div><div class="actions"><form method="post" action="/api/admin/review">${hidden}<input type="hidden" name="decision" value="reject"><button class="reject" type="submit">반려</button></form><form method="post" action="/api/admin/review">${hidden}<input type="hidden" name="decision" value="approve"><button class="approve" type="submit">확인 후 승인</button></form></div><small>링크는 48시간 동안 유효하며, 한 번 처리된 요청은 다시 적용되지 않습니다. 승인 전에는 공개 데이터가 바뀌지 않습니다.</small></section>`);
}

async function handleAdminReviewDecision(request: Request, env: Env) {
  if (request.method !== "POST") return jsonResponse({ error: "POST 방식만 지원" }, 405);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.DASHBOARD_ADMIN_CODE) {
    return htmlResponse('<section class="card"><h1>관리자 검토 기능이 아직 설정되지 않았습니다.</h1></section>', 503);
  }
  const form = await request.formData();
  const kind = String(form.get("kind") ?? "");
  const id = String(form.get("id") ?? "");
  const expires = String(form.get("expires") ?? "");
  const signature = String(form.get("signature") ?? "");
  const decision = String(form.get("decision") ?? "");
  if (!await validateReviewToken(env, kind, id, expires, signature) || !["approve", "reject"].includes(decision)) {
    return htmlResponse('<section class="card"><h1>유효하지 않거나 만료된 요청입니다.</h1></section>', 403);
  }

  const row = await fetchReviewRequest(env, kind, id);
  if (!row) return htmlResponse('<section class="card"><h1>요청을 찾을 수 없습니다.</h1></section>', 404);
  if (String(row.status) !== "PENDING") {
    return htmlResponse(`<section class="card"><h1>이미 ${escapeHtml(row.status)} 상태입니다.</h1></section>`);
  }

  const base = env.SUPABASE_URL.replace(/\/$/, "");
  const now = new Date().toISOString();
  const approve = decision === "approve";
  let status = approve ? "APPROVED" : "REJECTED";
  let changedCase: { id: string; column: string; previous: string | number | null } | null = null;
  let correctionClaimed = false;

  // 메일 버튼을 두 번 누르거나 두 창에서 거의 동시에 승인해도 한 요청만 DB를
  // 바꾸도록 먼저 처리권을 선점한다. 공개 상태를 새 enum으로 바꾸지 않고 감사 필드에
  // 짧게 표시하므로 기존 스키마와도 호환된다.
  const releaseCorrectionClaim = async () => {
    if (!correctionClaimed) return;
    await fetch(
      `${base}/rest/v1/bargaining_record_corrections?id=eq.${id}&status=eq.PENDING&reviewed_by=eq.EMAIL_REVIEW_PROCESSING`,
      {
        method: "PATCH",
        headers: supabaseHeaders(env, true),
        body: JSON.stringify({ reviewed_by: null, updated_at: new Date().toISOString() }),
      },
    );
    correctionClaimed = false;
  };
  const correctionFailure = async (content: string, responseStatus: number) => {
    await releaseCorrectionClaim();
    return htmlResponse(content, responseStatus);
  };

  if (kind === "correction") {
    const claimResponse = await fetch(
      `${base}/rest/v1/bargaining_record_corrections?id=eq.${id}&status=eq.PENDING&reviewed_by=is.null`,
      {
        method: "PATCH",
        headers: { ...supabaseHeaders(env, true), prefer: "return=representation" },
        body: JSON.stringify({ reviewed_by: "EMAIL_REVIEW_PROCESSING", updated_at: now }),
      },
    );
    const claimedRows = claimResponse.ok ? await claimResponse.json() as ReviewRequestRow[] : [];
    if (!claimResponse.ok) {
      return htmlResponse('<section class="card"><h1>수정 요청의 처리권을 확인하지 못했습니다.</h1><small>잠시 후 다시 시도해 주세요.</small></section>', 502);
    }
    if (claimedRows.length !== 1) {
      return htmlResponse('<section class="card"><h1>이 수정 요청은 이미 처리 중이거나 완료되었습니다.</h1><small>같은 승인 버튼을 다시 누르지 않아도 됩니다.</small></section>', 409);
    }
    correctionClaimed = true;
  }

  if (kind === "correction" && approve) {
    const companyResponse = await fetch(
      `${base}/rest/v1/tracked_companies?select=id&slug=eq.${encodeURIComponent(String(row.company_id_key))}&limit=1`,
      { headers: supabaseHeaders(env) },
    );
    const companyRows = companyResponse.ok ? await companyResponse.json() as Array<{ id?: string }> : [];
    const companyId = companyRows[0]?.id;
    if (!companyId) return correctionFailure('<section class="card"><h1>수정 대상 회사를 DB에서 찾을 수 없습니다.</h1></section>', 409);

    const fieldMap: Record<string, string> = {
      stage: "primary_stage",
      eventDate: "latest_event_on",
      agreementType: "agreement_type",
      unionName: "bargaining_unit_name",
      factSummary: "current_fact_summary",
    };
    const column = fieldMap[String(row.field_name)];
    if (!column) return correctionFailure('<section class="card"><h1>자동 적용할 수 없는 수정 항목입니다.</h1></section>', 409);
    const proposed = String(row.proposed_value ?? "").trim();
    if (column === "primary_stage" && !/^(?:U|S[0-8])$/.test(proposed)) return correctionFailure('<section class="card"><h1>올바르지 않은 교섭 단계입니다.</h1></section>', 400);
    if (column === "latest_event_on" && !/^\d{4}-\d{2}-\d{2}$/.test(proposed)) return correctionFailure('<section class="card"><h1>확인일은 YYYY-MM-DD 형식이어야 합니다.</h1></section>', 400);
    if (column === "agreement_type" && !["WAGE", "CBA", "INTEGRATED", "SUPPLEMENTAL", "WORKS_COUNCIL"].includes(proposed)) return correctionFailure('<section class="card"><h1>올바르지 않은 협약유형입니다.</h1></section>', 400);

    const caseResponse = await fetch(
      `${base}/rest/v1/bargaining_cases?select=id,${column}&company_id=eq.${companyId}&bargaining_year=eq.${row.bargaining_year}&order=latest_event_on.desc.nullslast&limit=1`,
      { headers: supabaseHeaders(env) },
    );
    const caseRows = caseResponse.ok ? await caseResponse.json() as Array<Record<string, string | number | null>> : [];
    const bargainingCase = caseRows[0];
    if (!bargainingCase?.id) return correctionFailure('<section class="card"><h1>수정할 교섭 기록을 DB에서 찾을 수 없습니다.</h1></section>', 409);
    const updateResponse = await fetch(`${base}/rest/v1/bargaining_cases?id=eq.${bargainingCase.id}`, {
      method: "PATCH",
      headers: { ...supabaseHeaders(env, true), prefer: "return=minimal" },
      body: JSON.stringify({ [column]: proposed, updated_at: now }),
    });
    if (!updateResponse.ok) return correctionFailure('<section class="card"><h1>교섭 기록 수정에 실패했습니다.</h1></section>', 502);
    changedCase = { id: String(bargainingCase.id), column, previous: bargainingCase[column] ?? null };
    status = "APPLIED";
  }

  const table = kind === "correction" ? "bargaining_record_corrections" : "company_add_requests";
  const requestUpdate: Record<string, string> = kind === "correction"
    ? { status, review_note: approve ? "아침 알림 메일에서 승인" : "아침 알림 메일에서 반려", reviewed_at: now, reviewed_by: "EMAIL_REVIEW", updated_at: now, ...(approve ? { applied_at: now } : {}) }
    : { status, review_note: approve ? "아침 알림 메일에서 승인 · 과거자료 수집 대기" : "아침 알림 메일에서 반려", reviewed_at: now, updated_at: now };
  const ownershipFilter = kind === "correction" ? "&reviewed_by=eq.EMAIL_REVIEW_PROCESSING" : "";
  const response = await fetch(`${base}/rest/v1/${table}?id=eq.${id}&status=eq.PENDING${ownershipFilter}`, {
    method: "PATCH",
    headers: { ...supabaseHeaders(env, true), prefer: "return=representation" },
    body: JSON.stringify(requestUpdate),
  });
  const updatedRows = response.ok ? await response.json() as ReviewRequestRow[] : [];
  if (!response.ok || updatedRows.length !== 1) {
    if (changedCase) {
      await fetch(`${base}/rest/v1/bargaining_cases?id=eq.${changedCase.id}`, {
        method: "PATCH",
        headers: supabaseHeaders(env, true),
        body: JSON.stringify({ [changedCase.column]: changedCase.previous, updated_at: now }),
      });
    }
    await releaseCorrectionClaim();
    if (response.ok && updatedRows.length === 0) {
      return htmlResponse('<section class="card"><h1>이 요청은 이미 다른 창에서 처리되었습니다.</h1></section>', 409);
    }
    return htmlResponse('<section class="card"><h1>DB 반영 중 오류가 발생했습니다.</h1><small>요청은 처리 전 상태로 유지됩니다.</small></section>', 502);
  }
  correctionClaimed = false;

  if (kind === "company" && approve) {
    const slug = `pending-${id.replaceAll("-", "").slice(0, 16)}`;
    const companyResponse = await fetch(`${base}/rest/v1/tracked_companies?on_conflict=slug`, {
      method: "POST",
      headers: { ...supabaseHeaders(env, true), prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        slug,
        legal_name: row.company_legal_name,
        display_name: row.company_name || row.company_legal_name,
        industry: row.industry || "검토 중",
        coverage_tier: "WATCH",
        tracking_status: "PAUSED",
        search_aliases: [row.company_legal_name],
        selection_rationale: row.rationale ? [row.rationale] : [],
        is_published: false,
        verification_status: "NEEDS_REVIEW",
      }),
    });
    if (!companyResponse.ok) {
      await fetch(`${base}/rest/v1/company_add_requests?id=eq.${id}&status=eq.APPROVED`, {
        method: "PATCH",
        headers: supabaseHeaders(env, true),
        body: JSON.stringify({ status: "PENDING", review_note: "비공개 기업 등록 실패 · 재검토 필요", reviewed_at: null, updated_at: now }),
      });
      return htmlResponse('<section class="card"><h1>기업의 비공개 등록에 실패했습니다.</h1><small>요청은 검토 대기로 되돌렸습니다.</small></section>', 502);
    }
  }

  const next = kind === "company" && decision === "approve"
    ? "기업을 비공개 검토 목록에 등록했습니다. 자동 작업이 최근 5개년 기사 후보를 수집하며, 원청 직접고용 범위 검토가 끝난 사실만 이후 공개됩니다."
    : kind === "correction" && decision === "approve"
      ? "승인된 값이 DB에 반영되었습니다."
      : "요청을 반려했습니다. 공개 데이터는 변경되지 않았습니다.";
  return htmlResponse(`<section class="card"><p class="eyebrow">처리 완료 · ${escapeHtml(status)}</p><h1>${escapeHtml(next)}</h1><small><a href="/">대시보드로 돌아가기</a></small></section>`);
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const DISPATCH_DEFAULTS = {
  repository: "frypanegg/ER_Radar",
  workflow: "daily-bargaining-update.yml",
  ref: "main",
};

/**
 * 일일 수집 워크플로를 GitHub에 직접 요청한다.
 *
 * GitHub의 schedule 이벤트는 best-effort라 예고 없이 통째로 누락된다. 2026-08-10부터
 * 08-13까지 나흘 동안 06:34 KST 예정분이 정시에 발화한 날이 하루도 없었고, 그중 이틀은
 * 하루 세 슬롯이 모두 발화하지 않았다. 같은 경로에 슬롯을 더 얹어도 그 날은 못 살린다.
 *
 * 그래서 발사대를 Cloudflare cron으로 옮긴다. 워크플로 자체는 그대로 두고 깨우는
 * 경로만 늘리는 것이라, GitHub cron이 살아 있는 날은 둘 다 깨워도 워크플로의 같은
 * KST 날짜 중복 실행 방지 가드가 한 번만 수집하게 막는다.
 */
async function dispatchDailyCollection(env: Env) {
  if (!env.GITHUB_DISPATCH_TOKEN) {
    console.warn(
      "GITHUB_DISPATCH_TOKEN이 없어 일일 수집 요청을 건너뜁니다. " +
        "npx wrangler secret put GITHUB_DISPATCH_TOKEN 으로 등록하세요.",
    );
    return;
  }

  const repository = env.GITHUB_DISPATCH_REPOSITORY ?? DISPATCH_DEFAULTS.repository;
  const workflow = env.GITHUB_DISPATCH_WORKFLOW ?? DISPATCH_DEFAULTS.workflow;
  const ref = env.GITHUB_DISPATCH_REF ?? DISPATCH_DEFAULTS.ref;
  const endpoint = `https://api.github.com/repos/${repository}/actions/workflows/${workflow}/dispatches`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "er-radar-scheduler",
      "x-github-api-version": "2022-11-28",
    },
    // force는 넘기지 않는다. 이미 수집한 날 다시 깨우는 판단은 워크플로 가드가 한다.
    //
    // trigger_source로 이 발사대가 깨웠다는 표시를 남긴다. 토큰이 만료되면 여기서
    // 403이 나는데, 그날 GitHub cron이 살아 있으면 수집은 정상으로 보여 발사대가
    // 죽은 것을 아무도 모른다. 워크플로가 이 표시를 세어 그 침묵을 깬다.
    body: JSON.stringify({ ref, inputs: { trigger_source: "cloudflare-cron" } }),
  });

  // 204 No Content가 정상 응답이다.
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `일일 수집 요청이 실패했습니다: ${response.status} ${detail.slice(0, 300)}`,
    );
  }
  console.log(`일일 수집 워크플로를 요청했습니다: ${repository} ${workflow} (${ref})`);
}

const worker = {
  // Cloudflare cron 트리거. vite.config.ts의 triggers.crons가 시각을 정한다.
  async scheduled(_event: unknown, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatchDailyCollection(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return withRobotsTag(await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths));
    }

    if (url.pathname === "/api/company-requests") {
      return withRobotsTag(await handleCompanyAddRequest(request, env));
    }

    if (url.pathname === "/api/record-corrections") {
      return withRobotsTag(await handleRecordCorrectionRequest(request, env));
    }

    if (url.pathname === "/api/published-facts") {
      return withRobotsTag(await handlePublishedFacts(env));
    }

    if (url.pathname === "/admin/review") {
      return withRobotsTag(await handleAdminReviewPage(request, env));
    }

    if (url.pathname === "/api/admin/review") {
      return withRobotsTag(await handleAdminReviewDecision(request, env));
    }

    return withRobotsTag(await handler.fetch(request, env, ctx));
  },
};

export default worker;

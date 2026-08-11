/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  DASHBOARD_ADMIN_CODE?: string;
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
  "title",
  "factSummary",
  "sourceUrl",
  "flowEvents",
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

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
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

    return withRobotsTag(await handler.fetch(request, env, ctx));
  },
};

export default worker;

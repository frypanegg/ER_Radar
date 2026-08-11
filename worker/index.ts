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

    return withRobotsTag(await handler.fetch(request, env, ctx));
  },
};

export default worker;

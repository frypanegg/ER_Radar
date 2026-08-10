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

    return withRobotsTag(await handler.fetch(request, env, ctx));
  },
};

export default worker;

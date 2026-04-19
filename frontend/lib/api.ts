/**
 * Thin wrapper around `fetch` for talking to the backend.
 *
 * Default is **same-origin**: an empty base URL means `${baseUrl}${path}`
 * resolves to a relative path (e.g. `/api/v1/...`), which the browser then
 * sends to whichever host served the page. In production on the VPS, nginx
 * proxies `/api/*` to the backend on port 8000 directly. In Docker dev,
 * `frontend/next.config.mjs` rewrites `/api/*` -> `http://backend:8000/api/*`
 * inside the compose network. Either way, the browser sees a single origin
 * and there's no CORS to negotiate.
 *
 * `NEXT_PUBLIC_API_BASE_URL` remains an escape hatch for environments where
 * the frontend genuinely needs to point at a different host (kept for the
 * eventual fis-lead-gen BFF proxy migration). The `credentials: "include"`
 * stays so BetterAuth's session cookie is forwarded post-merge.
 */

const DEFAULT_BASE_URL = "";

const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_BASE_URL;

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    ...init,
  });

  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const body: unknown = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    throw new ApiError(`Request to ${path} failed with ${response.status}`, response.status, body);
  }

  return body as T;
}

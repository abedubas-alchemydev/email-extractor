/**
 * Thin wrapper around `fetch` for talking to the backend.
 *
 * Standalone phase: hits the backend directly via NEXT_PUBLIC_API_BASE_URL.
 * After merge into fis-lead-gen: swap base URL to "" and route through the
 * parent's BFF proxy at app/api/backend/[...path]/route.ts. The
 * `credentials: "include"` is forward-compatible with BetterAuth's session
 * cookie, so no caller-site change is needed at merge time.
 */

const DEFAULT_BASE_URL = "http://localhost:8000";

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

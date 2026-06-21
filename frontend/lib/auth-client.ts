import { createAuthClient } from "better-auth/react";

function resolveAuthBaseUrl() {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }

  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

// Email + password only — no genericOAuthClient plugin (OAuth stripped for the
// standalone email-extractor; see lib/auth.ts).
export const authClient = createAuthClient({
  baseURL: resolveAuthBaseUrl(),
});

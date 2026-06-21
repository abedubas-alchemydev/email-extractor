import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Public routes that never require a session. Everything else under the matcher
// (the app shell — "/" and "/email-extractor/*") bounces to /login when the
// session cookie is absent.
const publicPrefixes = ["/login", "/signup"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (publicPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return NextResponse.next();
  }

  // Presence check only — the cookie's HMAC signature is validated server-side
  // (the (app) layout's getRequiredSession + the FastAPI session dependency).
  // This keeps the edge middleware cheap and DB-free.
  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Run on every path except Next internals, BetterAuth + backend API routes,
  // and static assets. `/api/auth/*` is handled by BetterAuth and `/api/v1/*`
  // is proxied to the backend (which does its own session validation), so both
  // must stay out of the edge gate.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)"],
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output for Docker — bundles a self-contained server.js
  // for use behind a multi-stage Node Alpine runtime image.
  output: "standalone",

  // In Docker dev (compose sets BACKEND_INTERNAL_URL=http://backend:8000),
  // forward browser-issued backend API requests to the backend container so the
  // frontend can use same-origin URLs everywhere. Only `/api/v1/*` is proxied:
  // `/api/auth/*` stays local (handled by BetterAuth's route handler). Cookies
  // forward through the rewrite, so the backend can validate the BetterAuth
  // session. On the VPS, nginx handles `/api/v1/*` before requests ever reach
  // the Next.js server, so this rewrite is dormant in production.
  async rewrites() {
    const internal = process.env.BACKEND_INTERNAL_URL;
    if (!internal) return [];
    return [{ source: "/api/v1/:path*", destination: `${internal}/api/v1/:path*` }];
  },
};

export default nextConfig;

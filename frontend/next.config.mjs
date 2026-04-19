/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output for Docker — bundles a self-contained server.js
  // for use behind a multi-stage Node Alpine runtime image.
  output: "standalone",
};

export default nextConfig;

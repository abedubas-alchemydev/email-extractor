# --- Stage 1: install deps -------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# --- Stage 2: build the Next.js app ----------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_API_BASE_URL
# Use ${VAR-} (single dash) so an empty string from `docker compose` build args
# passes through verbatim. The `:-` form (colon-dash) treats empty as "unset"
# and silently substitutes the default — which would re-bake the broken
# http://localhost:8000 we just removed. Default is empty -> same-origin /api/*.
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL-}
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# --- Stage 3: production runtime -------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]

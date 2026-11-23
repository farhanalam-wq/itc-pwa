# syntax=docker/dockerfile:1.7

FROM oven/bun:1.4.2 AS build
WORKDIR /workspace

COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
RUN bun run build

# Install only production dependencies needed by the bundled API runtime.
FROM oven/bun:1.4.2 AS api-dependencies
WORKDIR /workspace
COPY package.json bun.lock ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/field-pwa/package.json ./apps/field-pwa/package.json
COPY apps/manager/package.json ./apps/manager/package.json
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY packages/charts/package.json ./packages/charts/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/demo-data/package.json ./packages/demo-data/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/ui/package.json ./packages/ui/package.json
RUN bun install --frozen-lockfile --production --filter @itc/api

FROM oven/bun:1.4.2 AS api
USER root
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 itc \
  && useradd --system --uid 10001 --gid itc --home-dir /app --shell /usr/sbin/nologin itc \
  && mkdir -p /app/apps/api/var/upload-staging \
  && chown -R itc:itc /app
WORKDIR /app
COPY --from=api-dependencies --chown=itc:itc /workspace/node_modules ./node_modules
COPY --from=build --chown=itc:itc /workspace/apps/api/dist/index.js ./apps/api/dist/index.js
ENV NODE_ENV=production PORT=4009 LOCAL_UPLOAD_STAGING_DIR=/app/apps/api/var/upload-staging
EXPOSE 4009
USER itc
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["bun", "-e", "fetch('http://127.0.0.1:4009/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["bun", "apps/api/dist/index.js"]

FROM oven/bun:1.4.2-slim AS static-runtime
WORKDIR /app
COPY deploy/static-server.mjs ./static-server.mjs
ENV PORT=3000 STATIC_ROOT=/app/public API_ORIGIN=http://api:4009
EXPOSE 3000
USER bun
CMD ["bun", "static-server.mjs"]

FROM static-runtime AS manager
COPY --from=build --chown=bun:bun /workspace/apps/manager/dist/ /app/public/

FROM static-runtime AS field-pwa
COPY --from=build --chown=bun:bun /workspace/apps/field-pwa/dist/ /app/public/

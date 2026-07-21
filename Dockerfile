# tester-huester — production image for @th/web (Next.js dashboard + collector API).
# Node 24 is required: the DB layer uses the built-in `node:sqlite` (packages/db). ARM64-friendly
# (target VPS is Oracle 'hermes', aarch64) — node:24-slim is multi-arch and pulls the right variant.
#
# Multi-stage:
#   builder — install the @th/web subgraph (web + packages/core + packages/db) and run `next build`
#   runner  — carry the built app + node_modules, drop to a non-root user, `pnpm --filter @th/web start`
#
# Only the web subgraph is installed (`--filter @th/web...`), so the extension's `wxt prepare`
# postinstall and the MCP toolchain never run here — the MCP is stdio and runs beside the agent
# (see DEPLOY.md), not in this image.

# ---------- builder ----------
FROM node:24-slim AS builder
ENV CI=1
# Pin pnpm from the root `packageManager` field and bake it into the image so no download happens later.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# Copy manifests first for a cacheable install layer. All workspace manifests are needed so pnpm can
# resolve the graph, even though only the @th/web subgraph is actually installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/web/package.json        apps/web/package.json
COPY apps/mcp/package.json        apps/mcp/package.json
COPY apps/extension/package.json  apps/extension/package.json
COPY packages/core/package.json   packages/core/package.json
COPY packages/db/package.json     packages/db/package.json

RUN pnpm install --frozen-lockfile --filter @th/web...

# Now the sources (node_modules / .next are excluded via .dockerignore, so this never clobbers the install).
COPY . .

RUN pnpm --filter @th/web build

# ---------- runner ----------
FROM node:24-slim AS runner
ENV NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# Persistent data dir (SQLite file + uploaded blobs). Pre-create it owned by the non-root `node`
# user so a freshly-created named volume inherits writable ownership on first mount.
RUN mkdir -p /data && chown node:node /data

# Bring over the whole installed + built workspace. pnpm's symlinked node_modules resolve because the
# path (/app) and base image are identical to the builder stage.
COPY --from=builder --chown=node:node /app /app

USER node
ENV SQLITE_FILE=/data/th.db \
    UPLOAD_DIR=/data/uploads
EXPOSE 4319
VOLUME ["/data"]

# `next start -p 4319`, bound to 0.0.0.0 by default. Reached only via the Cloudflare tunnel.
CMD ["pnpm", "--filter", "@th/web", "start"]

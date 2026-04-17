# Backend image for Railway. Multi-stage: a builder that installs the
# whole workspace and runs tsc, then a slim runtime that keeps only the
# backend's compiled output plus the node_modules the builder prepared.
#
# We COPY node_modules from the builder (after pruning to prod-only)
# instead of reinstalling in runtime because node-pty/ssh2 ship native
# bindings — reinstalling with --ignore-scripts strips them, and letting
# scripts run requires build-essential in the runtime image. Copying
# keeps native modules intact without bloating the final image with
# compilers.

# ---------- Builder ----------
FROM node:22-bookworm-slim AS builder

# node-gyp needs python3 + build-essential for any native module whose
# prebuilds don't cover linux-x64 + node 22.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace manifests first for better layer caching. If only source
# changes (no dep changes), `npm ci` stays cached.
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/
COPY packages/cli/package.json ./packages/cli/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY apps/desktop/package.json ./apps/desktop/

# Install everything, including native modules. --ignore-scripts skips
# apps/desktop's electron devtools postinstall (we don't ship the
# desktop binary here) but node-pty/ssh2 still get their prebuilts
# extracted because those live in the tarball, not in scripts.
RUN npm ci --ignore-scripts

# Now copy sources and build.
COPY packages/shared ./packages/shared
COPY packages/backend ./packages/backend

RUN npm run build --workspace=@fastowl/shared \
 && npm run build --workspace=@fastowl/backend \
 && npm rebuild --workspace=@fastowl/backend node-pty ssh2

# Prune to production-only node_modules before the runtime stage picks
# them up. `--omit=dev` drops devDependencies across the workspace;
# backend services and their transitive native modules stay.
# --ignore-scripts avoids apps/desktop's erb install hooks that assume a
# full desktop build environment.
RUN npm prune --omit=dev --ignore-scripts

# ---------- Runtime ----------
FROM node:22-bookworm-slim AS runtime

# ca-certificates: outbound HTTPS (GitHub API, Supabase) works.
# libstdc++ is already in the base image, so native modules load.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

# Workspace manifests so npm still understands the layout (drizzle-kit
# etc. that resolve via workspace paths).
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/packages/backend/package.json ./packages/backend/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/cli/package.json ./packages/cli/
COPY --from=builder /app/packages/mcp-server/package.json ./packages/mcp-server/
COPY --from=builder /app/apps/desktop/package.json ./apps/desktop/

# Pre-built, pre-pruned node_modules. npm workspaces hoist most deps to
# the root; the backend ends up with its own node_modules only for
# packages that can't hoist (e.g. a transitive version conflict), so we
# copy both.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/backend/node_modules ./packages/backend/node_modules

# Compiled JS + migrations.
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

EXPOSE 4747
WORKDIR /app/packages/backend
CMD ["node", "dist/index.js"]

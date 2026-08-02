# Backend image for Railway. Multi-stage: a builder that installs the
# whole workspace and runs tsc, then a slim runtime that keeps only the
# backend's compiled output plus the node_modules the builder prepared.
#
# The backend has no native deps after the "daemon everywhere" refactor
# (ssh2 + node-pty were dropped). build-essential is retained in the
# builder image as cheap insurance in case a transitive dep grows a
# native binding later.

# ---------- Builder ----------
FROM node:22-bookworm-slim AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace manifests first for better layer caching. If only source
# changes (no dep changes), `npm ci` stays cached.
COPY package.json package-lock.json ./
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/
# @talyn/client is front-end only, but npm ci needs every workspace manifest
# present or it refuses to install against the lockfile.
COPY packages/client/package.json ./packages/client/
COPY packages/cli/package.json ./packages/cli/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY apps/desktop/package.json ./apps/desktop/
COPY apps/web/package.json ./apps/web/

# Install everything. --ignore-scripts skips apps/desktop's electron
# devtools postinstall (we don't ship the desktop binary here).
RUN npm ci --ignore-scripts

# Now copy sources and build.
COPY packages/shared ./packages/shared
COPY packages/backend ./packages/backend

RUN npm run build --workspace=@talyn/shared \
 && npm run build --workspace=@talyn/backend

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
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Tailscale, for reaching self-hosted fleet hosts.
#
# A fleet host binds loopback and must never be exposed publicly (fleet spec
# §16.4), so the backend needs a private path to it. Spec §15 risk 5 asks for a
# WireGuard mesh; a tailnet is the same idea with key distribution solved.
#
# USERSPACE MODE, because a PaaS container has no NET_ADMIN and cannot create a
# TUN device. tailscaled instead exposes a local HTTP proxy and the fleet client
# dials through it (see services/selfHosted/client.ts). Nothing else in the
# backend's networking changes, and with no TS_AUTHKEY the daemon never starts
# at all — the image behaves exactly as it did before.
#
# Pinned and checksummed like every other fetched artifact.
ARG TAILSCALE_VERSION=1.98.10
ARG TAILSCALE_SHA256=52490ce0832b245857e2afef7426d6ae5a4b49fb391412833cc95729bd23f7de
RUN set -eux; \
    curl -fsSL -o /tmp/ts.tgz \
      "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_amd64.tgz"; \
    echo "${TAILSCALE_SHA256}  /tmp/ts.tgz" | sha256sum -c -; \
    tar xzf /tmp/ts.tgz -C /tmp; \
    install -m0755 "/tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscale"  /usr/local/bin/tailscale; \
    install -m0755 "/tmp/tailscale_${TAILSCALE_VERSION}_amd64/tailscaled" /usr/local/sbin/tailscaled; \
    rm -rf /tmp/ts.tgz "/tmp/tailscale_${TAILSCALE_VERSION}_amd64"

WORKDIR /app
ENV NODE_ENV=production

# Workspace manifests so npm still understands the layout (drizzle-kit
# etc. that resolve via workspace paths).
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/packages/backend/package.json ./packages/backend/
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/packages/client/package.json ./packages/client/
COPY --from=builder /app/packages/cli/package.json ./packages/cli/
COPY --from=builder /app/packages/mcp-server/package.json ./packages/mcp-server/
COPY --from=builder /app/apps/desktop/package.json ./apps/desktop/
COPY --from=builder /app/apps/web/package.json ./apps/web/

# Pre-built, pre-pruned node_modules. npm workspaces hoist most deps to
# the root; the backend ends up with its own node_modules only for
# packages that can't hoist (e.g. a transitive version conflict), so we
# copy both.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/backend/node_modules ./packages/backend/node_modules

# Compiled JS + migrations.
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 4747
WORKDIR /app/packages/backend
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]

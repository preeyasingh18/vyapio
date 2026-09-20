# ─────────────────────────────────────────────────────────────────────────────
# Vyapio app — built once, then served as static files by nginx.
#
# Two stages on purpose: the toolchain and node_modules stay in the builder, and
# the image that ships is nginx plus a folder of files. Nothing that built the
# app is left in it.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# The app is an npm workspace, so its dependencies are pinned in the root
# lockfile rather than one of its own. `npm ci` needs every workspace manifest
# present to verify that lockfile, so all four are copied before the install —
# and only the manifests, so this layer is cached until a dependency changes.
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/
COPY infrastructure/package.json ./infrastructure/

RUN npm ci --no-audit --no-fund

# The frontend imports the backend's Zod schemas through the `@shared` alias, so
# they have to be present for the build. One definition of an entity, used by
# both sides — see frontend/vite.config.ts.
COPY backend/src/schemas ./backend/src/schemas
COPY frontend ./frontend

# Relative, because nginx below serves the app and proxies /api on the same
# origin. An absolute URL here would bake one machine's hostname into the build.
ENV VITE_API_URL=/api

RUN cd frontend && npm run build

# ── Stage 2: serve ───────────────────────────────────────────────────────────
FROM nginx:alpine

COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

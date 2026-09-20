# ─────────────────────────────────────────────────────────────────────────────
# Vyapio API — one Lambda, packaged as a container image.
#
#   docker build -t vyapio-backend ./backend
#   docker run --rm -p 9000:8080 --env-file .env vyapio-backend
#
#   curl -XPOST "http://localhost:9000/2015-03-31/functions/function/invocations" \
#     -d '{"version":"2.0","rawPath":"/health","headers":{},
#          "requestContext":{"http":{"method":"GET","sourceIp":"127.0.0.1"}}}'
#
# CDK builds this image and pushes it to ECR automatically — see
# infrastructure/lib/lambda-stack.ts. Nothing here needs doing by hand.
#
# Two stages: the builder carries the toolchain and dev dependencies, the final
# image carries one bundled file. No source, no node_modules, no secrets — every
# value comes from Lambda's environment at run time.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build ───────────────────────────────────────────────────────────
FROM public.ecr.aws/lambda/nodejs:22 AS builder

WORKDIR /build

# Manifests first, so the dependency layer is cached independently of source
# changes. `backend/package-lock.json` is committed precisely so this is
# reproducible: `npm ci` installs exact versions and fails if the lockfile and
# manifest disagree, which `npm install` would silently paper over.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json build.mjs ./
COPY src ./src

# Typecheck inside the image as well as in CI. An image that builds but does not
# compile is not a passing build, and catching it here beats catching it on
# first invocation.
RUN npx tsc --noEmit

# esbuild bundles the handler and its dependencies into one tree-shaken file.
# Shipping the bundle rather than node_modules cuts the image by an order of
# magnitude, which is most of the cold-start difference.
RUN node build.mjs

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM public.ecr.aws/lambda/nodejs:22

# The AWS base image already provides the Lambda Runtime Interface Client and
# runs as a non-root user, so neither needs adding here.
WORKDIR ${LAMBDA_TASK_ROOT}

# Just the bundle and a package.json marking it as ESM.
COPY --from=builder /build/dist/handler.mjs ./handler.mjs
COPY --from=builder /build/dist/handler.mjs.map ./handler.mjs.map
COPY --from=builder /build/dist/package.json ./package.json

ENV NODE_OPTIONS=--enable-source-maps \
    NODE_ENV=production

# <file>.<exported function>
CMD [ "handler.handler" ]

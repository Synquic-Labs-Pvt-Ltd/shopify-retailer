# syntax=docker/dockerfile:1

# Retailer Studio web app (Next.js, embedded in the Shopify admin) for hosts that detect a Dockerfile in the app
# folder (for example Synq with the root directory set to apps/web).
#
# It builds whichever folder the host uses as the build context:
#  - the repository root (docker build -f apps/web/Dockerfile .): the workspace is already in the context;
#  - apps/web itself: the workspace packages (packages/shared, packages/mock-api) and the lockfile are outside the
#    context, so the monorepo is cloned from GitHub instead (build args GIT_URL and GIT_REF, default branch main;
#    the repository must be readable without credentials).
#
# The image has no deployment settings baked in. Set these environment variables on the host (all read at runtime):
#   SHOPIFY_API_KEY   the Shopify app client id (public)
#   BACKEND_URL       the backend origin, for example https://shopify-retailer.synquic.tech
#   POLARIS_URL       optional, defaults to the classic admin look
FROM node:22-slim AS source
ARG GIT_URL=https://github.com/Synquic-Labs-Pvt-Ltd/shopify-retailer.git
ARG GIT_REF=main
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY . /ctx
RUN if [ -f /ctx/pnpm-workspace.yaml ]; then \
      mkdir /src && cp -a /ctx/. /src/; \
    else \
      git clone --depth 1 --branch "$GIT_REF" "$GIT_URL" /src; \
    fi

FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
COPY --from=source /src /app
# Only the web app and the workspace packages it uses.
RUN pnpm install --frozen-lockfile --filter "@rs/web..."
RUN pnpm -F @rs/web build

FROM node:22-slim
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# Next's standalone output: a server with only the files it needs, plus the static assets it does not copy itself.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]

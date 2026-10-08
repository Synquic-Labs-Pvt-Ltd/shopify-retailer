# syntax=docker/dockerfile:1

# Retailer Studio backend (Express API plus the generation queue worker), for hosts that detect a Dockerfile in the
# app folder (for example Synq with the root directory set to apps/backend).
#
# It builds whichever folder the host uses as the build context:
#  - the repository root (docker build -f apps/backend/Dockerfile .): the workspace is already in the context;
#  - apps/backend itself: the workspace package packages/shared and the lockfile are outside the context, so the
#    monorepo is cloned from GitHub instead (build args GIT_URL and GIT_REF, default branch main; the repository
#    must be readable without credentials).
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

FROM node:22-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
RUN mkdir -p /app && chown node:node /app
WORKDIR /app
COPY --from=source --chown=node:node /src /app
USER node
ENV COREPACK_HOME=/home/node/.cache/corepack

# Only the backend and what it depends on (@rs/shared). NODE_ENV is set after the install.
RUN pnpm install --frozen-lockfile --filter "@rs/backend..."

ENV NODE_ENV=production \
    ROLE=all \
    PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["pnpm", "-F", "@rs/backend", "start"]

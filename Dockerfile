# Retailer Studio backend (Express API plus the generation queue worker), for any Docker-based host.
# Build context is the repository root. The web app (apps/web) is deployed separately.
FROM node:22-slim

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app
COPY --chown=node:node . .
RUN chown node:node /app
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

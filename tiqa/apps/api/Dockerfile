# Tiqa API + worker image. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t tiqa-api .
FROM node:22-slim
# openssl is required by Prisma's query engine
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
  && corepack enable
WORKDIR /app

# Dependencies first (better layer caching). The Prisma schema is needed by the postinstall `prisma generate`.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
COPY packages/scoring/package.json packages/scoring/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma
RUN pnpm install --frozen-lockfile --filter "@tiqa/api..." --filter "tiqa"

COPY packages packages
COPY apps/api apps/api

ENV NODE_ENV=production
USER node
EXPOSE 4000
WORKDIR /app/apps/api
# API by default. Worker:     command: ["/app/node_modules/.bin/tsx", "src/worker.ts"]
# Migrations (one-off):       command: ["/app/packages/db/node_modules/.bin/prisma", "migrate", "deploy", "--schema", "/app/packages/db/prisma/schema.prisma"]
CMD ["/app/node_modules/.bin/tsx", "src/server.ts"]

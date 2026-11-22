# Tiqa dashboard image. Build from the repository root:
#   docker build -f apps/web/Dockerfile --build-arg API_URL=http://api:4000 -t tiqa-web .
FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@tiqa/web..."
COPY apps/web apps/web

# The /api proxy target is baked in at build time (Next.js rewrites).
ARG API_URL=http://api:4000
ARG NEXT_PUBLIC_API_URL
ENV API_URL=$API_URL NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
RUN pnpm --filter @tiqa/web build

USER node
EXPOSE 3000
WORKDIR /app/apps/web
CMD ["/app/apps/web/node_modules/.bin/next", "start", "--port", "3000"]

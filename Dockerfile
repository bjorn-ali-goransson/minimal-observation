# Single-stage build+run image. Runtime footprint is what matters here (feather-light),
# not image size. Produces the combined ingest + query + UI server.
FROM node:22-slim

RUN corepack enable
WORKDIR /app

# Install workspace deps (cached on manifests).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/tracing/package.json packages/tracing/
COPY packages/ui/package.json packages/ui/
COPY services/sample/package.json services/sample/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile=false

# Build.
COPY . .
RUN pnpm --filter @mo/shared build \
 && pnpm --filter @mo/tracing build \
 && pnpm --filter @mo/server build \
 && pnpm --filter @mo/ui build

ENV NODE_ENV=production \
    MO_PORT=4318 \
    MO_DATA_DIR=/data \
    MO_UI_DIR=/app/packages/ui/dist
VOLUME /data
EXPOSE 4318

CMD ["node", "packages/server/dist/index.js"]

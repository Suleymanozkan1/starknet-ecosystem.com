# Multi-stage build for Node services (api, game-server, blockchain-service).
# Usage: docker build -f docker/node.Dockerfile --build-arg APP=api .
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi \
 && corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

FROM base AS build
ARG APP
COPY . .
# Optional corporate/sandbox CA for registry access (BuildKit secret "ca"); absent in normal builds.
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi \
 && pnpm install --frozen-lockfile && pnpm --filter @nebula/${APP} build \
 && pnpm --filter @nebula/${APP} deploy --prod --legacy /out

FROM node:22-bookworm-slim AS runtime
ARG APP
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
COPY --from=build /repo/prisma /app/prisma
COPY --from=build /repo/packages/database/src/generated /app/generated
USER node
EXPOSE 8080 2567 8090
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT_HEALTH||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]

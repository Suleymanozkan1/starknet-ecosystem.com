# Static web + admin bundles served by nginx (put Cloudflare/CDN in front).
FROM node:22-bookworm-slim AS build
ENV CI=true
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi \
 && corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo
COPY . .
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi \
 && pnpm install --frozen-lockfile && pnpm --filter @nebula/web build && pnpm --filter @nebula/admin build

FROM nginx:1.27-alpine
COPY docker/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY --from=build /repo/apps/admin/dist /usr/share/nginx/admin
EXPOSE 80

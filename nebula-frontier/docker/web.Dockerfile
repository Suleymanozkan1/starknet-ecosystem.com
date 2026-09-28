# Static web + admin bundles served by nginx (put Cloudflare/CDN in front).
FROM node:22-bookworm-slim AS build
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @nebula/web build && pnpm --filter @nebula/admin build

FROM nginx:1.27-alpine
COPY docker/nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY --from=build /repo/apps/admin/dist /usr/share/nginx/admin
EXPOSE 80

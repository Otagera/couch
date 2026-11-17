# Couch: one small Node server plus a SQLite file.
#
# Two things ship in the runtime image:
#   - .output       the Nitro-bundled web server
#   - src/server    the TypeScript source, run directly by the maintenance CLI
#                   (docker exec <container> node src/server/cli.ts status)
#
# Server code imports only node: builtins, so the CLI runs with Node's type
# stripping and no node_modules; node:sqlite means no native toolchain.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
RUN apk add --no-cache tini
WORKDIR /app

COPY --from=build /app/.output ./.output
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/package.json ./package.json

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    COUCH_DB_PATH=/data/couch.db \
    COUCH_LETTERBOXD_DIR=/data/letterboxd \
    COUCH_LOG_LEVEL=info

VOLUME /data
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", ".output/server/index.mjs"]

# The application image — the only thing this project packages (PLAN.md §4.1).
#
# It carries the Hono API and nothing else. Postgres and object storage are always opaque
# endpoints behind connection strings, so the same image serves `compose.yml` on one box and
# a platform supplying its own services; only the environment differs.
#
# Build from the repository root:  docker build -f server/Dockerfile .

FROM oven/bun:1.4-alpine AS build
WORKDIR /app

# Manifests first, so a dependency-free source change reuses the install layer.
COPY package.json bun.lock turbo.json tsconfig.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY client/package.json client/package.json

# --ignore-scripts skips the root postinstall, which builds workspaces the sources for
# aren't copied yet; the explicit build below does that job.
RUN bun install --frozen-lockfile --ignore-scripts

COPY shared shared
COPY server server

RUN bun run build:server


FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/shared/package.json shared/package.json
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/drizzle server/drizzle

USER bun
EXPOSE 3000

# Every connection parameter arrives as an environment variable; the server validates them
# all at startup and refuses to boot on a bad one (src/config/env.ts).
CMD ["bun", "run", "server/dist/index.js"]

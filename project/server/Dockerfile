# The application image — the Hono API (PLAN.md §4.1).
#
# Postgres and object storage are always opaque endpoints behind connection strings, so the
# same image serves `compose.yml` on one box and a platform supplying its own services; only
# the environment differs.
#
# The build context is the repository root, because the workspace's lockfile and Turbo
# configuration live there:
#
#   docker build -f project/server/Dockerfile .

FROM oven/bun:1.4-alpine AS build
WORKDIR /app

# Manifests first, so a dependency-free source change reuses the install layer.
COPY package.json bun.lock turbo.json ./
COPY project/tsconfig.json project/tsconfig.json
COPY project/shared/package.json project/shared/package.json
COPY project/server/package.json project/server/package.json
COPY project/client/package.json project/client/package.json

# --ignore-scripts skips the root postinstall, which builds workspaces whose sources aren't
# copied yet; the explicit build below does that job.
RUN bun install --frozen-lockfile --ignore-scripts

COPY project/shared project/shared
COPY project/server project/server

RUN bun run build:server


FROM oven/bun:1.4-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/project/shared/package.json project/shared/package.json
COPY --from=build /app/project/shared/dist project/shared/dist
COPY --from=build /app/project/server/package.json project/server/package.json
COPY --from=build /app/project/server/dist project/server/dist
COPY --from=build /app/project/server/drizzle project/server/drizzle

USER bun
EXPOSE 3000

# Every connection parameter arrives as an environment variable; the server validates them
# all at startup and refuses to boot on a bad one (src/config/env.ts).
CMD ["bun", "run", "project/server/dist/index.js"]

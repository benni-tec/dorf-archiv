# The client image — the built SPA, served as static files by nginx.
#
# The client is a plain static bundle: there is no server-side rendering (PLAN.md §10), so
# nothing here needs a JavaScript runtime. nginx serves the files and falls back to
# index.html for client-side routes.
#
# The build context is the repository root, because the workspace's lockfile and Turbo
# configuration live there:
#
#   docker build -f project/client/Dockerfile .
#
# Note the API's URL is baked in at build time — Vite substitutes `import.meta.env` during
# the bundle, so it cannot be changed by an environment variable on the running container.
# A different API origin means a different build; `VITE_SERVER_URL` is the build argument
# that selects it.

FROM oven/bun:1.4-alpine AS build
WORKDIR /app

# Manifests first, so a dependency-free source change reuses the install layer.
COPY package.json bun.lock turbo.json tsconfig.json ./
COPY project/shared/package.json project/shared/package.json
COPY project/server/package.json project/server/package.json
COPY project/client/package.json project/client/package.json

RUN bun install --frozen-lockfile --ignore-scripts

# The client typechecks against `server/dist`, not the server's source (see AGENTS.md), so
# the server has to be here and built — which `build:client` does for us, since Turbo's
# build task declares `dependsOn: ["^build"]`.
COPY project/shared project/shared
COPY project/server project/server
COPY project/client project/client

ARG VITE_SERVER_URL=http://localhost:3000
ENV VITE_SERVER_URL=$VITE_SERVER_URL

RUN bun run build:client


FROM nginx:1.29-alpine AS runtime

COPY project/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/project/client/dist /usr/share/nginx/html

EXPOSE 80

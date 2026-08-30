# The reverse proxy — one entry point in front of the whole stack (PLAN.md §4.1 shape 2).
#
# Routes by hostname, all on the port the proxy is published on:
#
#   <host>            the client
#   api.<host>        the API
#   admin.db.<host>   pgAdmin
#
# and Postgres on its own port, because TCP has no hostname to route on — see nginx.conf.
#
# The names are not baked in: they arrive as environment variables and are substituted into
# the configuration at container start, so the same image serves localhost in development
# and a real domain in deployment.
#
# Build from this directory:  docker build -f project/Dockerfile project
FROM nginx:1.29-alpine

# Rendered at start-up rather than copied into place, so ${PROXY_*} is substituted. Output
# goes to /etc/nginx rather than the default conf.d because this replaces nginx.conf
# outright — a top-level `stream {}` block cannot live in an include that lands inside
# `http {}`.
COPY nginx.conf /etc/nginx/templates/nginx.conf.template
ENV NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx

# Substitute only our own names. The default is every environment variable, which would
# blank nginx's own $host, $http_upgrade and $proxy_add_x_forwarded_for.
ENV NGINX_ENVSUBST_FILTER=^PROXY_

# Defaults that make the image runnable on its own; compose supplies the real names.
ENV PROXY_CLIENT_HOST=localhost
ENV PROXY_API_HOST=api.localhost
ENV PROXY_ADMIN_HOST=admin.db.localhost

EXPOSE 80
EXPOSE 5432

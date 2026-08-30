# The reverse proxy — one entry point in front of the whole stack (PLAN.md §4.1 shape 2).
#
# Routes by hostname, all on the port the proxy is published on:
#
#   <host>            the client
#   api.<host>        the API
#   admin.db.<host>   pgAdmin
#
# and Postgres on its own port, because TCP has no hostname to route on — see stream.conf.
#
# The names are substituted into the config at container start by the nginx image's
# envsubst entrypoint rather than baked in, so the same image serves localhost in development
# and a real domain in deployment. They arrive whole — compose builds them out of PROXY_HOST,
# so this image holds no rule about how a subdomain is spelled.
#
# Build from the repository root:  docker build -f project/proxy/Dockerfile project/proxy
FROM nginx:1.29-alpine

# Replaces the stock file, which only includes conf.d inside `http {}` — routing Postgres
# needs a top-level `stream {}` block.
COPY nginx.conf /etc/nginx/nginx.conf
COPY forwarded.conf /etc/nginx/forwarded.conf
COPY stream.conf /etc/nginx/stream.d/postgres.conf

# Templates are rendered into conf.d at start-up, not at build time.
COPY templates/ /etc/nginx/templates/

# Substitute only our own names. The default is every environment variable, which would put
# nginx's own $host and $proxy_add_x_forwarded_for at risk of being blanked.
ENV NGINX_ENVSUBST_FILTER=^PROXY_

# Defaults that make the image runnable on its own; compose supplies the real names.
ENV PROXY_CLIENT_HOST=localhost
ENV PROXY_API_HOST=api.localhost
ENV PROXY_ADMIN_HOST=admin.db.localhost

EXPOSE 80
EXPOSE 5432

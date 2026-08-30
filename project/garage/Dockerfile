# The Garage initialisation container.
#
# It exists because the Garage image has no shell — it is the bare binary — so the setup
# script cannot run there. This is that binary on a base that can run `sh`.
#
# Build from this directory:  docker build project/garage
FROM dxflrs/garage:v2.3.0 AS garage

FROM alpine:3.22
COPY --from=garage /garage /usr/local/bin/garage
COPY init.sh /usr/local/bin/garage-init
RUN chmod +x /usr/local/bin/garage-init
ENTRYPOINT ["/usr/local/bin/garage-init"]

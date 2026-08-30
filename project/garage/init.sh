#!/bin/sh
# One-shot cluster initialisation, so a fresh checkout has working storage without anyone
# reading the Garage manual. The MinIO equivalent was three lines of `mc`; Garage needs more
# because a node with no layout assigned stores nothing at all.
#
# Every step is idempotent: this runs on every `up`, not just the first.
set -eu

echo "waiting for garage..."
until garage status >/dev/null 2>&1; do
	sleep 2
done

# A freshly created node holds no data until it is given a role in the cluster layout.
if garage status | grep -q "NO ROLE ASSIGNED"; then
	node="$(garage status | awk '/NO ROLE ASSIGNED/ { print $1 }')"
	echo "assigning layout to node $node"
	garage layout assign -z "${GARAGE_ZONE:-dc1}" -c "${GARAGE_CAPACITY:-10G}" "$node"

	# Garage prints the exact command to enact staged changes, version number included.
	# Reading it back beats tracking the version ourselves and getting it wrong on a re-run.
	version="$(garage layout show | grep -oE 'layout apply --version [0-9]+' | grep -oE '[0-9]+$')"
	garage layout apply --version "$version"
fi

# Deterministic credentials, imported rather than generated, so .env stays the single source
# and nobody has to copy a secret out of a container log on first run.
if garage key info "$S3_ACCESS_KEY_ID" >/dev/null 2>&1; then
	echo "key $S3_ACCESS_KEY_ID already present"
else
	echo "importing key $S3_ACCESS_KEY_ID"
	garage key import "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" --yes -n dorf-archiv
fi

if garage bucket info "$S3_BUCKET" >/dev/null 2>&1; then
	echo "bucket $S3_BUCKET already present"
else
	echo "creating bucket $S3_BUCKET"
	garage bucket create "$S3_BUCKET"
fi

garage bucket allow --read --write --owner "$S3_BUCKET" --key "$S3_ACCESS_KEY_ID" >/dev/null

# PLAN.md §4.6 #3: unpublished blobs sit in storage from the moment of upload, so anonymous
# access would bypass moderation entirely. Garage serves a bucket to the web only when
# website access is switched on, and this makes sure it never was.
garage bucket website --deny "$S3_BUCKET" >/dev/null 2>&1 || true

echo "bucket $S3_BUCKET ready (private), key $S3_ACCESS_KEY_ID authorised"

# Dorf-Archiv

A community archive for a village's history. Locals contribute photos and stories about the
people and places around them, from their phones, and everything lands on an interactive map
tied to a timeline.

> **Status: early.** The repository is still close to its [bhvr](https://github.com/stevedylandev/bhvr)
> starter shape — the domain code is not written yet. The design, however, is settled and
> documented. Commands marked *(planned)* below describe the intended interface and are not
> wired up yet.

## What it does

- **Map and timeline as the entry point.** Tap a place to see what has been contributed there,
  or tap it to contribute. A timeline filter narrows both the pins and the historic map
  overlays.
- **Contribute from a phone.** Photograph an old print, crop and straighten it in the browser,
  add a rough date and a place. Designed for a thumb on a small screen first.
- **Nothing is published unmoderated.** Every contribution is a *proposal* until a moderator
  publishes it. Moderators see diffs, can combine several proposals into one version, and
  every change is audited.
- **Dates are fuzzy by default.** "um 1930" and "sometime in the twenties" are first-class;
  nobody knows exactly when grandma's photo was taken.
- **Everything assertable is citable.** People, places, photos, stories — and the relationships
  between them — carry sources, so you can see *why* the archive claims two people married.
- **Links and backlinks.** References between entries are written inline as chips, which means
  a person's page automatically lists every photo and story mentioning them.
- **German first, multilingual capable.** German full-text search with compound-word handling;
  content can carry several languages, with machine translation filling gaps.
- **Ancestry view** of village families — planned after the map.

## Documentation

| File | Contents |
| --- | --- |
| [`PLAN.md`](./PLAN.md) | **The source of truth.** Domain model, platform decisions, moderation workflow, legal posture, open questions. Read this before writing code. |
| [`AGENTS.md`](./AGENTS.md) | Repository conventions and the invariants that are easy to violate by accident. Written for coding agents, but it's the fastest orientation for a human too. |

## Stack

Bun workspaces + Turbo, with three packages: `client`, `server`, `shared`.

- **Server** — Hono, Drizzle, Postgres, S3-compatible object storage, better-auth
- **Client** — Vite, React 19, TanStack Router + Query, Tailwind v4, shadcn/ui, MapLibre GL JS,
  TipTap, Paraglide
- **Shared** — cross-boundary types, the content format parser, fuzzy-date formatting

## Development

Requires [Bun](https://bun.sh) and Docker.

```bash
bun install          # also prebuilds shared + server (see note below)
bun run dev:deps     # (planned) Postgres + MinIO, foreground, torn down on exit
bun run dev          # client on :5173, server on :3000
```

| Script | Does |
| --- | --- |
| `dev` | client and server from source, with hot reload |
| `dev:client` / `dev:server` | one workspace only |
| `dev:deps` *(planned)* | dependencies in the foreground, cleaned up when you stop it |
| `dev:deps:up` / `dev:deps:down` *(planned)* | the same, detached |
| `build` | all workspaces |
| `lint` / `format` | Biome — tabs, double quotes |

The client and server run **from source**, not in containers; only the backing services come
from Docker. Their connection strings are environment variables, so in development they simply
point at localhost.

> **Build ordering matters.** The client imports `server/client`, which resolves to the
> server's compiled `dist/`, not its source. So `shared` and `server` must be built before the
> client typechecks — which is why `postinstall` prebuilds them and why the server's dev script
> runs `tsc --watch` alongside. If the client reports missing routes or stale response types,
> rebuild the server.

## Deployment

*(planned — no deployment target is chosen yet)*

Only the application is containerized. Postgres and object storage are always reached through
connection strings, so three shapes work from the same source:

1. **Development** — app from source, Compose supplying Postgres and MinIO.
2. **Compose as production** — the whole stack on one box.
   ```bash
   docker compose -f docker/compose.yml up -d
   ```
3. **App container + external services** — the image on a platform, with the database and
   object storage supplied by whoever runs them.

Configuration is entirely environment variables — database URL, S3 endpoint and credentials,
auth secret, public URL, operator details for the Impressum. Nothing assumes a particular
provider, and no provider SDK appears in the code.

The eventual host must be **EU-hosted**, **containerizable**, and have a **hard spending cap**
(billing alerts are not sufficient). See `PLAN.md` §4 for why, and for the providers that were
checked against those requirements.

One deployment-time detail worth knowing: German search quality depends on a Hunspell `de_DE`
dictionary being installed in Postgres. Without it, searching *Kirche* will not find
*Dorfkirche*. The search configuration name is a setting, so the application runs either way —
it just finds less.

## Contributing and legal

Contributions to the *archive* require an account and a verified real person, who certifies at
upload that they hold the rights to the material. This is not bureaucracy for its own sake: the
archive publishes photographs of identifiable people, and German copyright and
Recht-am-eigenen-Bild rules apply. See `PLAN.md` §7.

## Credits

Bootstrapped from [bhvr](https://github.com/stevedylandev/bhvr) by Steve Simkins. MIT licensed;
see [`LICENSE`](./LICENSE).

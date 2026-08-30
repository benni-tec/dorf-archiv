# AGENTS.md

Guidance for coding agents working in this repository.

## Commands

Package manager and runtime is **Bun** (`packageManager: bun@1.2.4`); all scripts run through **Turbo** from the repo root.

```bash
bun install            # also runs postinstall: turbo build --filter=shared --filter=server
bun run dev            # all workspaces (client on :5173, server on :3000)
bun run dev:client
bun run dev:server
bun run dev:deps       # Postgres + MinIO, foreground, torn down when you stop it
bun run dev:deps:up    # the same, detached — dev:deps:down to stop
bun run stack:up       # whole stack in containers (app included); stack:down to stop
bun run db:generate    # drizzle-kit generate / migrate / studio, run from the host
bun run build          # or build:client / build:server
bun run lint           # biome lint .
bun run format         # biome format . --write
bun run type-check     # turbo type-check
bun run test           # turbo test, then bun test scripts
```

Tests are **`bun test`**, colocated as `*.test.ts` beside the code. `server/tsconfig.json` excludes them from the build — `dist/` is what the client resolves `server/client` to, so test files must not reach it. `scripts/` is not a workspace, which is why the root `test` script runs it separately.

Formatting/linting is Biome, not ESLint/Prettier: **tabs** for indentation, **double quotes**, import organization enabled as an assist action. Parts of the repo predating this were never formatted, so run Biome on the files you touch rather than the whole tree.

### Configuration

**One `.env`, at `project/.env`**, read by both the server and Docker Compose so their credentials cannot drift apart. `project/.env.example` documents every variable.

Bun does **not** walk up from the working directory to find `.env`, and Turbo runs each script with the workspace as its cwd — so the server's scripts pass `--env-file=../.env` explicitly, and `scripts/compose.ts` passes `--env-file` to Compose for the same reason. Bun tolerates that file being absent, which is deliberate: every variable has a working default baked into the Compose files.

`server/src/config/env.ts` is the only place environment variables are *interpreted*. Exactly two callers hand it `process.env` — the composition root and `drizzle.config.ts` — and nothing else reads it at all. Everything downstream takes a `ServerEnv`, which is what stops a silent `process.env.FOO ?? "default"` appearing mid-domain later. It reports every bad variable at once and never echoes a value, since half of them are credentials.

The client is the exception that needs saying: Vite looks for `.env` in `envDir`, which defaults to the workspace, so `client/vite.config.ts` sets `envDir: ".."` to reach the same root file. Only `VITE_`-prefixed variables are exposed to the bundle.

## Architecture

Bun workspace monorepo (`client`, `server`, `shared`) derived from the [bhvr](https://github.com/stevedylandev/bhvr) template. The defining property is end-to-end type safety across the client/server boundary, achieved in two layers:

1. **`shared`** — plain runtime-agnostic types imported as `import type { X } from "shared"` by both sides. Add anything the client and server both *construct* here and re-export it from `shared/src/index.ts`. Response shapes do not belong here: they are inferred through RPC.
2. **Hono RPC** — `server/src/app.ts` exports `createApp(dependencies)`, which builds the app as a *single chained expression* (`new Hono().use(...).route(...)`), and `App = ReturnType<typeof createApp>`. That chaining is load-bearing: Hono derives the type from it, and splitting routes into separate `app.get(...)` statements silently erases the route types from the client. `server/src/client.ts` re-exports `hcWithType`, and the client calls typed endpoints via `client.health.$get()` — request/response shapes flow from the route handler with no manual duplication.

**`server/src/index.ts` is the composition root and nothing else** — the only place that reads the environment, opens a connection or registers a shutdown handler. It builds the one app instance the process serves and exports `{ port, fetch }`. `client.ts` takes its type from `./app`, never from `./index`, so importing the RPC type never drags connection setup along. Tests drive the real routes by calling `createApp` with stub dependencies, which is why none of them need a database.

**Build ordering matters.** The client imports `server/client`, which resolves to `server/dist/client.d.ts` (compiled output), not source. So `shared` and `server` must be built before the client typechecks — this is why `postinstall` pre-builds them, why `turbo.json` tasks declare `dependsOn: ["^build"]`, and why `server`'s dev script runs `bun --watch run src/index.ts & tsc --watch` (the `tsc --watch` half exists only to keep `dist/` fresh for the client). If the client reports missing routes or stale response types, rebuild the server.

### Client

Vite + React 19. Routing is **TanStack Router in file-based mode**: routes live in `client/src/routes/`, and `client/src/routeTree.gen.ts` is generated by the `@tanstack/router-plugin` Vite plugin — never edit it by hand. The plugin must stay ordered before `@vitejs/plugin-react` in `vite.config.ts`.

TanStack Query is provided in `main.tsx`; server calls go through the Hono RPC client rather than raw `fetch`.

Styling is **Tailwind v4** via `@tailwindcss/vite` (no `tailwind.config.js`; theme lives in `client/src/index.css`). UI components are **shadcn/ui** (`new-york` style, neutral base, lucide icons) in `client/src/components/ui/`; add them with the shadcn CLI per `client/components.json`.

The server base URL comes from `VITE_SERVER_URL`, defaulting to `http://localhost:3000`.

### Path aliases

- Root `tsconfig.json`: `@server/*`, `@client/*`, `@shared/*` → the respective `src/`.
- Client only: `@/*` → `client/src/*` (declared in both `client/tsconfig.app.json` and `vite.config.ts` — keep them in sync).
- Cross-package imports use the workspace package names (`shared`, `server`, `server/client`), which go through built `dist/`, not the aliases.

### Notable strictness

Root config sets `noUncheckedIndexedAccess` and `verbatimModuleSyntax` (type-only imports must be written `import type`). `client/tsconfig.app.json` additionally enables `noUnusedLocals`/`noUnusedParameters`, so unused bindings fail the client build.

## Current state and direction

**`PLAN.md` §8 step 1 (groundwork) is done; step 2 (the domain core) is next.** What exists: the Compose stack, validated configuration, a Drizzle connection with an empty schema, an S3 client, and `GET /health` reaching both dependencies end to end. What does not: any table, any entity, any authorization. `server/src/db/schema/index.ts` is empty on purpose and records the conventions the first tables inherit.

Keep `README.md` honest as things land — it currently states one known gap, that the application image serves the API only and not the built client.

**`PLAN.md` is the source of truth for where this is going.** Read it before starting feature work. In short: a community village archive where locals upload photos and stories from their phones, centred on a map tied to a timeline, with historic map overlays and an ancestry view. The stack decisions in it are settled; product details are firming up, and open items are marked `(?)` — don't silently resolve one by implementing it.

Three product constraints that bind almost any feature work:

- **Contributing is phone-shaped; viewing is desktop-shaped.** Both are first-class. Capture and upload are designed for a phone; entry detail, ancestry and long reading are designed for a desk; the map and search are genuinely both. Don't derive one layout mechanically from the other — see the per-surface table in `PLAN.md` §6.
- **Nothing is published unmoderated.** Every user-contributed record carries a moderation state and is invisible to the public until approved.
- **Dates are rough by default.** A date is an anchor plus a granularity (`day`/`month`/`year`/`decade`) and therefore denotes a *span*; "specific" is just `day` granularity. Three embedded value types sit on that primitive — `Date` (one, required), `DateOrInterval` (start required, end optional) and `Interval` (both). **`Date` for things that happen once** (born, died, captured), **`DateOrInterval` for things that can last** (a story's period, a source's coverage); uncertainty about *when* is granularity's job, not an interval's. They are constrained so the start's span ends at or before the end's span begins, and, when embedded nullable, so an end can never appear without a start. Note `CalendarDate` is a *different* thing: an exact SQL `date`, used for legal dates like the ToC's `effectiveFrom`. Stored as Postgres `daterange`s with a generated extent for the timeline's `&&` overlap query. The UI renders each end at its own granularity — never a rough date dressed up as an exact one — and renders **inline only** (`<span>`/`<time>`, no block wrappers), since dates and chips appear mid-sentence inside prose. See `PLAN.md` §2.5 and §6.

## Platform

The deployment target is a **containerized Hono server** talking to **Postgres** and **S3-compatible object storage**, with Drizzle and better-auth. The production host is *deliberately undecided* — it must be EU-hosted, containerizable and have a hard spending cap.

**Three deployment shapes must all work from the same source**: (1) development — client and server run from source on the host with hot reload, Compose supplying only Postgres and MinIO; (2) the whole Compose stack as production on one box; (3) the app image on a platform with externally-provided services. Compose is a real deployment option, not just a dev toy — but it is never assumed.

What makes one codebase serve all three: Postgres and object storage are **always opaque endpoints behind connection strings** from environment variables. Assume nothing *undocumented* about how they are hosted, whether we hold superuser rights, or which extensions are installed. No provider-specific SDKs. In development the strings point at localhost; nothing else differs.

Stated requirements are allowed where any host can meet them — **Postgres ≥ 18** (native `uuidv7()`) and an S3-compatible API are hard requirements, documented in the README. Filesystem access for the Hunspell dictionary is *not* a requirement, because many managed hosts cannot grant it, so German search degrades instead.

> An earlier draft targeted Cloudflare Workers + D1 + R2. That was reversed: Cloudflare has no hard spend cap ("Budget alerts are informational only"), the 10ms free-tier CPU ceiling doesn't survive an authenticated route, and a Worker isn't a container. Ignore any remaining Workers/D1 references you find in older notes.

- **German full-text search is quality-degradable, not all-or-nothing.** A Hunspell `de_DE` dictionary gives compound splitting; without it Postgres does stemming only and *Kirche* never matches *Dorfkirche*, which on a German corpus is most searches. Installing one needs filesystem access to `$SHAREDIR/tsearch_data/`, which many hosts don't allow — so **the text-search configuration name is a setting**, not a constant. Full quality where the dictionary exists, graceful fallback to stock `german` where it doesn't. Never hard-code it.
- **Image processing stays client-side on the upload path** (bandwidth, and the crop/deskew UI needs the bitmap anyway), but server-side is available for derivatives and batch work. EXIF is stripped server-side on ingest regardless — a contributor photographing a print at home embeds their house's GPS.
- **The object bucket is private.** Files reach browsers only via short-lived presigned URLs issued after a permission check; unpublished blobs are in storage from upload, so a public policy or guessable key bypasses moderation. `project/compose.infra.yml`'s bucket-init step sets `mc anonymous set none` for exactly this reason — don't relax it to make a URL work in development.

### The Compose stack

Everything the running stack is built from lives under `project/`: the three workspaces, the `postgres/` image, a `Dockerfile` inside each workspace that ships one, and the Compose files. It also holds the base `tsconfig.json` the three workspaces extend, and the `.env`. The repository root keeps what is repository-wide — Biome, the docs, `scripts/`, and the workspace `package.json` with `turbo.json` beside it, because Turbo resolves its config from the directory holding the workspace manifest and will not find it anywhere else.

`project/compose.infra.yml` is standalone and self-sufficient — the backing services development runs against. `project/compose.yml` pulls it in with `include:` alongside `compose.app.yml` rather than restating anything, so the two cannot drift. All three declare `name: dorf-archiv`, so the dev dependencies and the full stack address the *same* volumes; that is intended, and it means `stack:up` sees the database `dev:deps` was using.

Four things here cost an afternoon each if rediscovered:

- **Teardown is `down`, never `down -v`.** Volumes are named and must survive being stopped, since `dev:deps` tears down every time you stop it. `scripts/compose.ts` refuses `-v` without `--yes-destroy-data`; don't route around it.
- **`postgres:18` moved `PGDATA`** to `/var/lib/postgresql/<major>/docker`. The volume therefore mounts at `/var/lib/postgresql`, not `.../data` — the old path leaves the database in the container's writable layer, where it vanishes on recreate.
- **`postgres/` exists to make development match a *good* production**, carrying the Hunspell `de_DE` dictionary and registering `german_hunspell`. The init script applies it to `template1` as well as the initial database, so databases created later inherit it. Deployment does not require any of this — `TEXT_SEARCH_CONFIG` selects stock `german` where the dictionary is absent.
- **Migrations run from the host** via `bun run db:migrate`, never from inside a container and never on boot.

Bun rather than shell for the wrapper scripts, because they behave identically on Windows and Linux — and this is the first thing a contributor touches. Bun is a hard requirement, so they use Bun's own APIs (`Bun.file`, `Bun.spawn`, `Bun.fileURLToPath`) rather than the `node:` compatibility layer; keep new scripts that way. `dev:deps` runs Compose in the foreground and owns the signal handling itself: plain `docker compose up` leaves containers lying around, and appending `; docker compose down` does not survive an interrupt on Windows.

## Backend structure

- **Every write goes through the server's domain layer, never raw SQL.** Versioning, the publish closure invariant and link extraction are enforced there, and there are enough invariants now that a direct writer will violate one.
- **Backend layering is Controller → Service → Repository** (`PLAN.md` §5.1). Controllers do HTTP and authorization; services are framework-free domain logic (no Hono types) so background jobs reuse them; repositories own all base-table access and the row→domain mapping, with **permission query handlers** turning an effective permission set into query constraints so every read path — FTS and backlinks included — is correct by construction.
- **The RPC chaining rule applies per controller.** Each controller must be a single chained expression, mounted via `.route()` inside another single chained expression, or its routes vanish from the client's types.
- **`Link` is bare and versioned with its parent** — a pointer from one `HistoricEntity` to another, no kind or label, existing for SQL discovery (backlinks, traversal) rather than display. Every reference in an entity's body must be unioned into its link set on save. `Relationship` is the opposite: a full entity, **between exactly two `Person`s**, with a kind, a `directed` flag and optional start/end dates — it is what the ancestry graph is drawn from.
- **The domain interface is operations, not tables.** `proposal_id`, table-per-type joins and version integers are implementation. If a controller mentions any of them, the seam is in the wrong place.
- **Every read takes an actor** — anonymous is an actor holding the public role set, never the absence of one. There is no unscoped read function to call, which is what keeps derived read paths (FTS, backlinks, translation) correct.
- **Layers earn their place.** A service that only forwards to its repository should not exist; let the controller use the repository. Controller → Service → Repository says where behaviour goes, not that every entity needs three files.

## Authorization

- **Preview and full content are separate endpoints, never one endpoint that redacts.** `<entity>:preview` is a permission like any other — normally granted to the public role — and `<entity>:view` gates the full endpoint, returning 403 otherwise. No endpoint varies its response shape by caller.
- **Effective permissions are the union of the public roles and the caller's own roles**, so anonymous requests go through the same check rather than bypassing it. There is no auth-free code path. Route permissions are declared per route and **fail closed** — a route declaring none is rejected at startup. The client's `Permission` component is UX only; the server enforces regardless.
- **Three tables: `role`, `role_permission` (role → permission), `user_role` (user → role).** In `role_permission`, `role_id IS NULL` means a **public permission** held by everyone; `user_role` has no nullable columns. That null **fails open** — an accidental one grants a permission to the entire internet — so public grants are their own explicit service method and a nullable role id never arrives from request input.
- **Both mapping tables are temporal, never deleted.** `granted_at/by` plus nullable `revoked_at/by`; active is `revoked_at IS NULL`. Revoke by setting the columns, never by `DELETE` — the history *is* the audit trail. Uniqueness is a *partial* index (`WHERE revoked_at IS NULL`) so something revoked can be granted again.
- **Nothing is HTTP-cached yet** — `Cache-Control: no-store` throughout. Caching anonymous responses is deferred deliberately, because it brings an invalidation obligation when a public role is tightened.
- **`PLAN.md` §4.6 is a fail-open inventory** — the handful of places where an omission grants *more* access rather than less (preview DTOs built by omission, unpublished blobs in storage, redaction not reaching chip labels, derived read paths like backlinks and search bypassing scoping). Read it before touching read paths, DTOs, storage keys or the closure check.

## Domain model

Three load-bearing rules, detailed in `PLAN.md` §2:

- **`Entity` → `VersionedEntity` → `LocalizedEntity` → `HistoricEntity` → subtypes**, each layer adding one capability (identity+audit, versions, languages, archival apparatus). `User`, `Thread` and `Comment` descend from `Entity` directly — identity and audit, no versions. Discussion is threads-of-comments, not a flat list: the thread carries `on_version` (the state of the record it's *about*), comments are moderated individually, and they order by their UUIDv7 id. The discriminator lives on the entity table only. **The spine is one physical table**: `version` and `original_language` are nullable columns on `entity`, null for `User` and `Comment`; table-per-type applies to the subtypes and their content companions, not to the layers (`PLAN.md` §5.2). Each subtype is a **pair**: `place` for what doesn't vary by language, `place_content` for what does (one row per language). There is no shared `LocalizedContent` table — types need different translatable fields — but every `<type>_content` carries `name` and `abstract` by convention, enforced by a registry test.
- **Proposals share the content tables with published rows**, distinguished by a nullable `proposal_id`. Versions are per-entity integers created at publish, never at proposal time. *A query that forgets `proposal_id IS NULL` returns proposals to the public* — i.e. publishes unmoderated content. Base tables are read only inside the repository, and the row→domain mapper asserts `proposal_id` is null rather than quietly dropping it.
- **Published content may only reference published content.** One invariant covering tags, links, places and sources alike.
- **The site is one index per entity type, not a map plus extras.** The map *is* the Places index; ancestry *is* the People index. Detail pages are uniform across types. See `PLAN.md` §6.
- **A user account may be linked to a Person entity** (§2.9) — moderator-confirmed, never self-asserted, not public by default, and carrying no special edit rights over that Person.

Two more rules that are easy to violate by accident:

- **Every mutable row carries `created_at` / `created_by` / `updated_at` / `updated_by`** — join tables, role grants and account approvals included, not just entities. New tables get them by default.
- **Primary keys are UUIDv7, generated by the database** (`DEFAULT uuidv7()`), which sets a **minimum of Postgres 18**. Being time-ordered, `ORDER BY id` is creation order — comment ordering depends on it. Never `gen_random_uuid()`; that's v4 and scatters index writes.
- **Proposals are freely editable; published versions are not.** Editing a version exists only for legal redaction (a KUG or copyright takedown, DSGVO erasure) — publishing a correction doesn't help, because prior versions still render the content. It requires a reason, is loudly warned about in the UI, and must never be the path a normal feature reaches for.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `benni-tec/dorf-archiv`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root, created lazily by `/domain-modeling` rather than upfront. See `docs/agents/domain.md`.

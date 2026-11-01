# AGENTS.md

Guidance for coding agents working in this repository.

## Commands

Package manager and runtime is **Bun** (`packageManager: bun@1.2.4`); all scripts run through **Turbo** from the repo root.

```bash
bun install            # also runs postinstall: turbo build --filter=shared --filter=server
bun run dev            # all workspaces (client on :5173, server on :3000)
bun run dev:client
bun run dev:server
bun run dev:infra       # Postgres, SeaweedFS and pgAdmin on localhost, torn down on exit
bun run dev:infra:up    # the same, detached — dev:infra:down to stop
bun run compose:up       # whole stack in containers (app included); compose:down to stop
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

**`PLAN.md` §8 step 1 (groundwork) is done; step 2 (the domain core) is in progress.**

Landed so far: the Compose stack; validated configuration; `GET /health`; rough dates in `shared` (§2.5 — the primitive everything archival is dated with) and their strict conversion to and from `daterange` (`persistence/db/rough-date-range.ts`); and **the schema of §5.2** except `notification_outbox` — the `entity` spine with `user`, `entity_version` and `proposal`; all eight versioned subtypes and their content companions; `link`, `citation`, `entity_tag`, `asset`, `media_file`; `thread` and `comment`; `terms_acceptance`; `role`, `role_permission`, `user_role`; `user_person`; `translation_cache`; and the **entity registry** with the tests that make its conventions real.

Also landed: the **actor** and its resolution (`domain/actor.ts` — public set plus the account's roles, failing with `PermissionResolutionError` rather than guessing, §4.6 #9); the **row-scoping predicates** (`persistence/repository/scope.ts`) and the **published-row assertion** (`persistence/repository/mapper.ts`) — §4.6 #1's two lines of defence, with the registry-driven conformance test behind them; **grants** (`persistence/repository/permissions.ts` — public and role-bound grants are separate functions, revocation stamps rather than deletes); the **fail-closed route declaration** (`controllers/guard.ts`); **publishing**, **rejection** and **publish-all** (`domain/publishing.ts`, `domain/rejection.ts`); the **published reads** — `findPublished`, `findVersion`, `history`, `backlinks` — and the moderation reads `findProposal` and `pendingProposals` (`persistence/repository/read.ts`); **proposal review** (`domain/review.ts`), which rehearses the publish and diffs the real outcome; and **proposing** (`domain/proposing.ts`, `persistence/repository/write.ts`) with the **content module** (`shared/src/content`) and derived links.

Not yet written: search, the client's editor projections of the content module (`fromEditor`/`toEditor`) and `protectForTranslation`, auth (better-auth, sessions — `identify` answers null for everyone until then), `notification_outbox`, translation, redaction, and every controller beyond `/health`. No controller may touch a base table; they go through the functions above.

### Routes

**Every route declares a permission or an exemption, or the app refuses to start.** Write `requires("place:view")` from `createGuards(…)` as a route's first handler, or `exempt("why")` for the rare route outside the permission system — `/health` is the one so far, because it must answer while the permission tables are unreachable. `assertEveryRouteDeclared` runs inside `createApp` and walks `app.routes`; app-wide `.use()` middleware does not count as declaring anything. The guard resolves the actor itself and hands it to the handler as `c.var.actor`.

### Proposals are complete states; publishing is a three-way merge

A proposal holds the entity's **whole** state — every field, every language, every tag, citation and file — never a delta. The client loads the head, edits it, sends all of it back; `propose`/`editProposal` (`domain/proposing.ts`) write it whole and replace it whole. What a proposer *changed* is derived by comparing with its base.

Publishing (`domain/publishing.ts`) merges **base, proposal and head** part by part (`domain/merge.ts`): a part the proposal left as its base had keeps the head's value, one only the proposal changed takes the proposal's, and one both changed differently is a `ConflictError`. A stale proposal therefore does not revert what landed in between, and several proposals for one entity combine into one version. A proposal may not drop a published language (`IncompleteProposalError`). A moderator resolves a conflict by rebasing the proposal (`editProposal(…, { rebaseTo })`).

Parts are **generic and registry-driven** (`MERGE_PARTS` in `schema/registry.ts`, read and written by `persistence/repository/state.ts`): a part's value is its rows as JSON minus bookkeeping, so a new column is compared and copied without anyone listing it. Keep it that way — a per-type mapping in the merge would drop a forgotten column from every new version. `link` is not a part: it is **derived** from the merged bodies after the version is written, then the closure invariant is checked on the version itself before the head moves.

`domain/review.ts` **rehearses** the publish in a transaction that is always rolled back (`rehearsal()` in `persistence/repository/publishing.ts`), so the moderation diff cannot disagree with publishing. Do not reintroduce a predicted outcome.

`WRITERS` (`persistence/repository/write.ts`) and `READERS` (`read.ts`) are each other's inverse by hand; `write.test.ts` round-trips a fully populated draft of every type through propose → publish → read. Change one, change the other.

### Content and chips

Bodies are directive-Markdown handled by `shared`'s content module (`shared/src/content`). A chip is exactly `:entity{#<uuid>}` — no label, no type. Every text column of a `<type>_content` table except `language` and `name` is Markdown and is scanned for chips (`markdownColumns`). Two things that surprised: `remark-directive` parses prose colons ("10:30 Uhr") as directives, so `parse` turns every non-chip directive back into text; and its serializer escapes those colons, so `serialize` writes chips itself rather than using it. Stored bodies are `normalize`d — canonical, so `serialize(parse(x))` is a fixed point but not `x`.

### Reading content

Two rules, and they are the ones that publish unmoderated content if broken.

- **Every read takes an actor**, and anonymous is *an actor holding the public role set* — never the absence of one (`anonymousActor()`). There is deliberately no unscoped read to call, which is what stops derived paths like backlinks, FTS and translation lookups being written unscoped.
- **Constrain with `publishedOnly()`, and let `assertPublished()` catch what slips.** The first is the rule; the second exists because a mapper that merely dropped `proposal_id` would *hide* proposal-ness rather than catch it, turning a leak into a silently well-typed one. `publishedOrOwnProposals()` is the deliberately separate wider read for "my contributions" — its rows must **not** go through `assertPublished`, which is why it is a different function rather than a flag.

`conformance.test.ts` checks both lines of defence for every registered type: it seeds a proposal per type and checks it three ways — the scoped read excludes it, the *unscoped* read returns it (so the test cannot pass by the proposal never having been there), and the mapper throws on it. It needs a live database and **skips without one** — `bun run dev:infra` then `bun run test` is the combination that arms it, and CI should always be that combination. Breaking `publishedOnly` on purpose fails 16 of its cases, which is the only evidence that a guard test is worth anything.

### Testing against a real database

`connectForTests()` returns null when no `DATABASE_URL` is reachable and the suites that need one skip, so `bun run test` stays green with nothing running. **That means those guards are only armed when the infrastructure is up** — `bun run dev:infra` then `bun run test`, and CI should always be that pair.

Two things cost an afternoon and will again:

- **Do not use `expect(promise).rejects.toThrow(...)` on a promise from a Drizzle transaction.** It hangs until the test times out, and the timeout surfaces as `CONNECTION_DESTROYED` — which reads like a pool problem and is not one. Catch it by hand: `const error = await thing().catch((caught) => caught as Error)`, then assert on it. Rejecting transactions do *not* leak connections; that was checked directly before blaming the pool.
- **Give a transaction an `async` callback that awaits**, not one returning the promise straight through. The same hang otherwise.

### Publishing

**The closure invariant is one rule, not one gate per reference kind** (§2.3): an entity cannot be published while any reference it holds points at something unpublished. `persistence/repository/closure.ts` finds them by iterating `REFERENCE_TABLES`, and returns the list rather than a boolean because the moderation queue has to offer inline publish/remove and a "publish all" for the common case of a photo proposed with its new Place.

It reports which tables it searched, so "did it check everywhere" is observable. Two tests guard it from opposite directions: one that the check searches every *registered* table, and — the one that matters — one that reads the schema, works out which tables hold an entity reference on versioned content, and fails if any is missing from the registry. Removing `citation` from `REFERENCE_TABLES` fails that test; without it, the same omission would just silently stop being checked.

Keep `README.md` honest as things land — it currently states one known gap, that the application image serves the API only and not the built client.

**`PLAN.md` is the source of truth for where this is going.** Read it before starting feature work. In short: a community village archive where locals upload photos and stories from their phones, centred on a map tied to a timeline, with historic map overlays and an ancestry view. The stack decisions in it are settled; product details are firming up, and open items are marked `(?)` — don't silently resolve one by implementing it.

Three product constraints that bind almost any feature work:

- **Contributing is phone-shaped; viewing is desktop-shaped.** Both are first-class. Capture and upload are designed for a phone; entry detail, ancestry and long reading are designed for a desk; the map and search are genuinely both. Don't derive one layout mechanically from the other — see the per-surface table in `PLAN.md` §6.
- **Nothing is published unmoderated.** Every user-contributed record carries a moderation state and is invisible to the public until approved.
- **Dates are rough by default.** A date is an anchor plus a granularity (`day`/`month`/`year`/`decade`) and therefore denotes a *span*; "specific" is just `day` granularity. Three embedded value types sit on that primitive — `Date` (one, required), `DateOrInterval` (start required, end optional) and `Interval` (both). **`Date` for things that happen once** (born, died, captured), **`DateOrInterval` for things that can last** (a story's period, a source's coverage); uncertainty about *when* is granularity's job, not an interval's. They are constrained so the start's span ends at or before the end's span begins, and, when embedded nullable, so an end can never appear without a start. Note `CalendarDate` is a *different* thing: an exact SQL `date`, used for legal dates like the ToC's `effectiveFrom`. Stored as Postgres `daterange`s with a generated extent for the timeline's `&&` overlap query. The UI renders each end at its own granularity — never a rough date dressed up as an exact one — and renders **inline only** (`<span>`/`<time>`, no block wrappers), since dates and chips appear mid-sentence inside prose. See `PLAN.md` §2.5 and §6.

## Platform

The deployment target is a **containerized Hono server** talking to **Postgres** and **S3-compatible object storage**, with Drizzle and better-auth. The production host is *deliberately undecided* — it must be EU-hosted, containerizable and have a hard spending cap.

**Three deployment shapes must all work from the same source**: (1) development — client and server run from source on the host with hot reload, Compose supplying only Postgres and SeaweedFS; (2) the whole Compose stack as production on one box; (3) the app image on a platform with externally-provided services. Compose is a real deployment option, not just a dev toy — but it is never assumed.

What makes one codebase serve all three: Postgres and object storage are **always opaque endpoints behind connection strings** from environment variables. Assume nothing *undocumented* about how they are hosted, whether we hold superuser rights, or which extensions are installed. No provider-specific SDKs. In development the strings point at localhost; nothing else differs.

Stated requirements are allowed where any host can meet them — **Postgres ≥ 18** (native `uuidv7()`) and an S3-compatible API are hard requirements, documented in the README. Filesystem access for the Hunspell dictionary is *not* a requirement, because many managed hosts cannot grant it, so German search degrades instead.

> An earlier draft targeted Cloudflare Workers + D1 + R2. That was reversed: Cloudflare has no hard spend cap ("Budget alerts are informational only"), the 10ms free-tier CPU ceiling doesn't survive an authenticated route, and a Worker isn't a container. Ignore any remaining Workers/D1 references you find in older notes.

- **German full-text search is quality-degradable, not all-or-nothing.** A Hunspell `de_DE` dictionary gives compound splitting; without it Postgres does stemming only and *Kirche* never matches *Dorfkirche*, which on a German corpus is most searches. Installing one needs filesystem access to `$SHAREDIR/tsearch_data/`, which many hosts don't allow — so **the text-search configuration name is a setting**, not a constant. Full quality where the dictionary exists, graceful fallback to stock `german` where it doesn't. Never hard-code it.
- **Image processing is server-side.** The phone uploads the original (to a staging key) plus normalised crop corners; the server orients, strips metadata, warps and writes WebP derivatives with `sharp`. Client-side derivatives were dropped: the original is uploaded anyway, so they only added upload. Stripping on ingest is the control — a contributor photographing a print at home embeds their house's GPS. See `PLAN.md` §4.5.
- **The object bucket is private.** Files reach browsers only via short-lived presigned URLs issued after a permission check; unpublished blobs are in storage from upload, so a public policy or guessable key bypasses moderation. SeaweedFS refuses anonymous requests once an identity is configured, and nothing grants the bucket a public policy — don't add one to make a URL work in development.

### Server layout

```
src/
  app.ts            the Hono app, built by a factory over injected dependencies
  index.ts          the composition root — the only place env is read or a connection opened
  client.ts         the typed RPC client re-export
  config/           environment validation
  controllers/      HTTP: one chained expression per controller (see below)
  domain/           framework-free services — no Hono types, so jobs can reuse them
  persistence/      db/ (Drizzle schema, connection, version guard) and storage/ (S3)
```

This is PLAN.md §5.1's Controller → Service → Repository, one directory per layer. **Layers earn their place**: a service that only forwards to its repository fails the deletion test and should not exist — the rule says where behaviour goes when there *is* behaviour, not that every entity needs three files.

### The schema

Read `persistence/db/schema/index.ts` first; it states the conventions in one place. Three that bite:

- **`casing: "snake_case"` is set twice** — in `drizzle.config.ts` and again on `drizzle()` in `persistence/db/client.ts`. They must agree, or the query builder emits camelCase names against snake_case columns and every query fails on a column that does not exist.
- **The audit quartet lives in `schema/entity.ts`, not `columns.ts`**, because it references `entity.id` and would otherwise close an import cycle. Its foreign keys are lazy arrows, which is what lets `entity` carry its own quartet: the first account is inserted referencing its own id, and a row-level foreign key accepts that inside a single statement.
- **Constraints are the enforcement, not convention.** The four `(proposal_id, version)` combinations, the paired date/granularity columns, the non-overlap rule, "a rejection needs a reason and a moderator" — all are CHECKs, because these rows arrive from the upload form, the moderation UI and any future import alike. Add the constraint with the column.

Migrations are generated with `bun run db:generate` and applied with `bun run db:migrate`, **from the host, never on boot**. Note the scripts invoke `node_modules/drizzle-kit/bin.cjs` directly rather than through `bun x`: `bun x` does not pass on the environment that `--env-file` added, so the config saw no `DATABASE_URL` and failed with every variable missing at once.

### The Compose stack

Everything the running stack is built from lives under `project/`: the three workspaces, the `postgres/` image, a `Dockerfile` inside each workspace that ships one, and the Compose files. It also holds the base `tsconfig.json` the three workspaces extend, and the `.env`. The repository root keeps what is repository-wide — Biome, the docs, `scripts/`, and the workspace `package.json` with `turbo.json` beside it, because Turbo resolves its config from the directory holding the workspace manifest and will not find it anywhere else.

**Two files, neither including the other.** `project/compose.dev.yml` publishes every backing service on loopback — development runs the client and server from source, and both `bun run dev` and `bun run db:migrate` need `localhost:5432`. `project/compose.yml` is the deployment: the whole stack, **publishing nothing but the proxy**, with no route to the database at all.

That duplication is deliberate and was arrived at the hard way: an including file can *add* a published port but cannot take one away, and which ports exist is the entire difference between the two stacks. A change to a backing service usually belongs in both files. Both declare `name: dorf-archiv`, so they address the *same* volumes and `compose:up` sees the database `dev:infra` was using.

Things here that cost an afternoon each if rediscovered:

- **Teardown is `down`, never `down -v`.** Volumes are named and must survive being stopped, since `dev:infra` tears down every time you stop it. `scripts/compose.ts` refuses `-v` without `--yes-destroy-data`; don't route around it.
- **`postgres:18` moved `PGDATA`** to `/var/lib/postgresql/<major>/docker`. The volume therefore mounts at `/var/lib/postgresql`, not `.../data` — the old path leaves the database in the container's writable layer, where it vanishes on recreate.
- **`postgres/` exists to make development match a *good* production**, carrying the Hunspell `de_DE` dictionary and registering `german_hunspell`. The init script applies it to `template1` as well as the initial database, so databases created later inherit it. Deployment does not require any of this — `TEXT_SEARCH_CONFIG` selects stock `german` where the dictionary is absent.
- **Migrations run from the host** via `bun run db:migrate`, never from inside a container and never on boot.
- **SeaweedFS runs as `weed mini` — one container, no init job.** It is master, volume, filer, S3 gateway and admin UI in one process. The S3 key arrives as `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (fed from `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`), a static identity re-read on every start and never persisted, so `.env` stays the single source; `S3_BUCKET` is created on start. Its flags switch off what nothing uses (WebDAV, Iceberg, Lance, telemetry) and bucket auto-creation, so a misspelt bucket fails the health probe instead of quietly becoming a second bucket. Both Compose files carry the same flags — change them together.
- **SeaweedFS with no credentials is wide open.** With no identity configured it serves every S3 request anonymously; once one exists, it authenticates all of them. The access-key variables are therefore what makes the bucket private — never blank them to simplify a setup. Likewise only S3 (`8333`) and the admin UI (`23646`) may ever be published or proxied: the filer (`8888`), master (`9333`) and volume (`9340`) HTTP APIs read and write every object with no authentication at all.
- **The admin UI's login is a plain password, and an empty one disables it.** `compose.yml` sets `WEED_ADMIN_PASSWORD` from `SEAWEEDFS_ADMIN_PASSWORD` because there it is on the public entry point; `compose.dev.yml` deliberately sets none, since it is on loopback.
- **The proxy forwards `Host $http_host`, not `$host`.** The difference is the port, and an S3 signature covers the Host header exactly as the client sent it. Dropping the port makes every signed request fail verification. Changing this back breaks uploads, not just tidiness.
- **The storage admin UI lives at `storage.<host>/_admin`, and the underscore is the point.** Under path-style addressing a request is `storage.<host>/<bucket>/<key>`, so any prefix that could be a bucket name is a collision waiting to happen — and `admin` is a legal bucket name. An underscore is not: SeaweedFS rejects `_admin` as an invalid bucket name, which makes the prefix collision-proof by construction. The UI is told the same prefix through `-admin.urlPrefix`, and strips it itself, so nginx forwards the path untouched.
- **The proxy receives finished hostnames.** `compose.yml` assembles `PROXY_CLIENT_HOST`, `PROXY_API_HOST` and `PROXY_DB_HOST` out of `PROXY_HOST`, the same way it assembles `DATABASE_URL` out of its parts; `project/nginx.conf` holds no rule about how a subdomain is spelled. Two things there are easy to get wrong: `NGINX_ENVSUBST_FILTER=^PROXY_` must stay, or envsubst blanks nginx's own `$host` and `$proxy_add_x_forwarded_for`; and the default `server` block returning 404 must stay first, or an unrecognised Host header silently reaches the client app.
- **The proxy's upstreams are variables with a `resolver`, not literal names**, which defers their lookup to request time. It lives in the infrastructure stack while `app` and `client` live in the application one, so with literal names nginx would resolve every upstream at start-up, find two missing and refuse to run — `dev:infra` would not start at all. Written this way an absent upstream is a 502. Verified: the proxy dies with "host not found in upstream" if this is undone.
- **Postgres is not proxied at all**, and could not be: the wire protocol has no Host header, and a client negotiates TLS *after* a plaintext `SSLRequest`, so there is no ClientHello for nginx's `ssl_preread` to route on either. `db.<host>` is pgAdmin, not the database.
- **pgAdmin is the only way into the database in a deployment**, on `db.<host>` through the proxy; the database itself is not published and is not proxied. In development it is on `localhost:5050` instead, and `compose.dev.yml` deliberately omits the `PGADMIN_CONFIG_PROXY_X_*` counts that `compose.yml` sets — trusting a forwarded header when nothing in front is setting it lets a client spoof it. It reads `postgres/servers.json` **once, on first run**: changing that file later does nothing until the `pgadmin-data` volume is removed. Its default login uses the reserved `.test` TLD, which pgAdmin refuses until `PGADMIN_CONFIG_ALLOW_SPECIAL_EMAIL_DOMAINS` lists it — the container exits at startup with a validation error otherwise.

Bun rather than shell for the wrapper scripts, because they behave identically on Windows and Linux — and this is the first thing a contributor touches. Bun is a hard requirement, so they use Bun's own APIs (`Bun.file`, `Bun.spawn`, `Bun.fileURLToPath`) rather than the `node:` compatibility layer; keep new scripts that way. `dev:infra` runs Compose in the foreground and owns the signal handling itself: plain `docker compose up` leaves containers lying around, and appending `; docker compose down` does not survive an interrupt on Windows.

## Backend structure

- **Every write goes through the server's domain layer, never raw SQL.** Versioning, the publish closure invariant and link extraction are enforced there, and there are enough invariants now that a direct writer will violate one.
- **Backend layering is Controller → Service → Repository** (`PLAN.md` §5.1). Controllers do HTTP and authorization; services are framework-free domain logic (no Hono types) so background jobs reuse them; repositories own all base-table access and the row→domain mapping, with **permission query handlers** turning an effective permission set into query constraints so every read path — FTS and backlinks included — is correct by construction.
- **The RPC chaining rule applies per controller.** Each controller must be a single chained expression, mounted via `.route()` inside another single chained expression, or its routes vanish from the client's types.
- **`Link` is bare and versioned with its parent** — a pointer from one `HistoricEntity` to another, no kind or label, existing for SQL discovery (backlinks, traversal) rather than display. The link set is *exactly* the references in the entity's bodies, derived on save — there are no links outside the prose, and the client never sends any. `Relationship` is the opposite: a full entity, **between exactly two `Person`s**, with a kind, a `directed` flag and optional start/end dates — it is what the ancestry graph is drawn from.
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

## Branches and pull requests

**Work lands as a stack of pull requests, one branch per `PLAN.md` §8 step**: `step-1-seaweedfs`, `step-3-auth`, and so on. Each branch is cut from the one below it, and its PR targets that branch rather than `main` — so every PR shows only its own diff. Nothing is committed to `main` directly.

**A step too large to review in one sitting is split into lettered sub-branches**, still stacked. Step 2 is `step-2-domain-core` (part a, keeping the name of the PR it reused, since a PR cannot change its branch), `step-2b-authorization`, `step-2c-publishing`, `step-2d-proposing` and `step-2e-search`. Cut along the import graph — each file lands, in its final form, in the first PR whose tests need it — and every branch must type-check and pass its tests on its own, not only the top one. Generated files do not count towards the size: `.gitattributes` marks Drizzle's snapshots `linguist-generated`, so GitHub folds them away.

The stack is registered on GitHub with the official `gh stack` extension (`gh extension install github/gh-stack`), which shows it on every PR in it; `gh stack link <branch>…` adds a new branch to it, bottom to top. When a lower PR changes, rebase the branches above it onto it (`gh stack rebase`, or `git rebase --onto <new lower> <old lower> <upper>` by hand) and force-push them with `--force-with-lease` (`gh stack push` does that for every branch at once). When a lower PR merges, retarget the next PR at `main` (`gh pr edit <n> --base main`).

## Agent skills

### Issue tracker

Issues live as GitHub issues in `benni-tec/dorf-archiv`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root, created lazily by `/domain-modeling` rather than upfront. See `docs/agents/domain.md`.

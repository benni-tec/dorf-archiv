import { defineConfig } from "drizzle-kit";
import { loadEnv } from "./src/config/env";

/**
 * Migrations run from the host, never from inside a container (PLAN.md §4.1) — so this
 * config reads the same validated environment the server does, against the same connection
 * string, rather than growing its own idea of where the database is.
 *
 * The scripts pass `--env-file=../.env`, so the repository-root `.env` is the single source
 * for both the server and Docker Compose.
 */
export default defineConfig({
	schema: "./src/persistence/db/schema/index.ts",
	out: "./drizzle",
	dialect: "postgresql",
	casing: "snake_case",
	dbCredentials: {
		url: loadEnv(process.env).databaseUrl,
	},
});

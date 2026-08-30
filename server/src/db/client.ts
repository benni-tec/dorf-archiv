import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ServerEnv } from "../config/env";
import * as schema from "./schema";
import { assertSupportedPostgres } from "./version";

/**
 * The database connection.
 *
 * Postgres is reached through a connection string and nothing else (PLAN.md §4.1) — no
 * provider SDK, no assumption about who operates it or which extensions are installed
 * beyond the stated Postgres 18 floor. In development the string points at the container
 * `compose.dev.yml` starts; in deployment it points wherever the operator says.
 */

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export type DatabaseHandle = {
	db: Database;
	/**
	 * Round-trips the connection and checks the server version.
	 *
	 * Resolves if the database answered, rejects otherwise — the shape `checkHealth`
	 * expects (`src/health/health.ts`).
	 */
	probe: () => Promise<void>;
	close: () => Promise<void>;
};

export function createDatabase(env: ServerEnv): DatabaseHandle {
	const sql = postgres(env.databaseUrl, {
		max: 10,
		// The health probe must fail fast rather than hang while a request waits on it.
		connect_timeout: 5,
		onnotice: () => {},
	});

	return {
		db: drizzle(sql, { schema }),

		probe: async () => {
			const rows = await sql<{ version_num: number }[]>`
				SELECT current_setting('server_version_num')::int AS version_num
			`;
			assertSupportedPostgres(Number(rows[0]?.version_num));
		},

		close: () => sql.end({ timeout: 5 }),
	};
}

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

/**
 * A database connection for tests that genuinely need one.
 *
 * Most of the suite does not: the app is built from injected dependencies precisely so its
 * routes and rules can be tested without Postgres. But the conformance test of §4.6 #1 —
 * seed a proposal per registered type and prove every read path excludes it — is a claim
 * about SQL, and testing it against a fake would prove nothing about the thing that can
 * actually leak.
 *
 * So it connects when a database is reachable and reports `null` when one is not, and the
 * tests that need it skip rather than fail. That keeps `bun run test` green on a machine
 * with nothing running, at the cost of a guard that is only armed when the infrastructure
 * is up — `bun run dev:infra` then `bun run test` is the combination that runs it, and CI
 * should always be that combination.
 */

export type TestDatabase = {
	db: ReturnType<typeof drizzle<typeof schema>>;
	sql: ReturnType<typeof postgres>;
	close: () => Promise<void>;
};

/** Connects, or returns null if there is no reachable database to connect to. */
export async function connectForTests(): Promise<TestDatabase | null> {
	const url = process.env.DATABASE_URL;
	if (!url) return null;

	// Enough for a test that opens a transaction while also querying outside it. Too few and
	// a TRUNCATE in the next setup blocks behind a connection still held, which surfaces as a
	// destroyed connection rather than as anything resembling its cause.
	const sql = postgres(url, { max: 5, connect_timeout: 3, onnotice: () => {} });

	try {
		await sql`SELECT 1`;
	} catch {
		await sql.end({ timeout: 1 }).catch(() => {});
		return null;
	}

	return {
		db: drizzle(sql, { schema, casing: "snake_case" }),
		sql,
		close: () => sql.end({ timeout: 5 }),
	};
}

/**
 * The reason a skipped test was skipped, so a silently absent guard is at least a visible
 * one when someone reads the output.
 */
export const NO_DATABASE_REASON =
	"no reachable DATABASE_URL — run `bun run dev:infra` to arm this guard";

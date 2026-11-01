import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, getTableName } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { accountActor, anonymousActor } from "../../domain/actor";
import { ENTITY_REGISTRY } from "../db/schema/registry";
import {
	connectForTests,
	NO_DATABASE_REASON,
	type TestDatabase,
} from "../db/testing";
import { assertPublished, ProposalLeakError } from "./mapper";
import {
	publishedOnly,
	publishedOrOwnProposals,
	type ScopableContent,
} from "./scope";

/**
 * The proposal conformance test — PLAN.md §4.6 #1.
 *
 * > Forgetting `proposal_id IS NULL` returns proposals alongside published rows — publishing
 * > unmoderated content, the one thing the design forbids.
 *
 * The guard the plan asks for is *registry-driven*: for every registered entity type, seed a
 * proposal and assert the read path excludes it, "so that new entity types are covered
 * without anyone remembering". A list of types written out here by hand would be exactly the
 * thing that rots the day a ninth type arrives, so the cases below come from
 * `ENTITY_REGISTRY` and nowhere else.
 *
 * Each type is checked three ways, because each catches a different mistake:
 *
 *  1. the scoped query returns only published rows — the constraint works;
 *  2. the *unscoped* query returns both — the constraint is what is doing the work, and the
 *     test is not passing because the proposal was never really there;
 *  3. the mapper throws when handed the proposal — the second line of defence holds for a
 *     read path built without the constraint at all.
 *
 * This runs only against a live database (see `../db/testing.ts`). Content tables are the
 * subject because they are uniform enough to seed generically and because they hold the
 * public-facing fields. The type tables get the same treatment through the repository's read
 * functions, seeded through the real publish path, in `read.test.ts`.
 */

const connection = await connectForTests();
const localized = ENTITY_REGISTRY.filter((item) => item.capabilities.localized);

describe.skipIf(connection === null)(
	`proposals never reach a published read (${connection === null ? NO_DATABASE_REASON : "live database"})`,
	() => {
		const active = connection as TestDatabase;
		let systemUser = "";
		const seeded = new Map<string, { entityId: string; proposalId: string }>();

		beforeAll(async () => {
			// The bootstrap account references its own id for the audit quartet, which a
			// row-level foreign key accepts inside a single statement.
			const [account] = await active.sql<{ id: string }[]>`
				WITH seed AS (SELECT uuidv7() AS id)
				INSERT INTO entity (id, type, created_by, updated_by)
				SELECT id, 'user', id, id FROM seed
				RETURNING id
			`;
			systemUser = account?.id ?? "";

			for (const { type, contentTable } of localized) {
				const table = contentTable as PgTable;
				// postgres.js interpolates an identifier through its own `sql()` helper;
				// Drizzle's `sql.identifier` belongs to a different builder entirely.
				const name = active.sql(getTableName(table));

				const [entityRow] = await active.sql<{ id: string }[]>`
					INSERT INTO entity (id, type, original_language, created_by, updated_by)
					VALUES (uuidv7(), ${type}, 'de', ${systemUser}, ${systemUser})
					RETURNING id
				`;
				const entityId = entityRow?.id ?? "";

				const [proposalRow] = await active.sql<{ id: string }[]>`
					INSERT INTO proposal (id, entity_id, based_on_version, created_by, updated_by)
					VALUES (uuidv7(), ${entityId}, 1, ${systemUser}, ${systemUser})
					RETURNING id
				`;
				const proposalId = proposalRow?.id ?? "";

				// Published: version set, proposal_id null.
				await active.sql`
					INSERT INTO ${name} (entity_id, version, proposal_id, language, name, search_config, created_by, updated_by)
					VALUES (${entityId}, 1, NULL, 'de', ${`${type} published`}, 'german', ${systemUser}, ${systemUser})
				`;

				// A pending proposal on the very same entity and language.
				await active.sql`
					INSERT INTO ${name} (entity_id, version, proposal_id, language, name, search_config, created_by, updated_by)
					VALUES (${entityId}, NULL, ${proposalId}, 'de', ${`${type} proposal`}, 'german', ${systemUser}, ${systemUser})
				`;

				seeded.set(type, { entityId, proposalId });
			}
		});

		afterAll(async () => {
			if (systemUser) await active.sql`TRUNCATE entity CASCADE`;
			await active.close();
		});

		test.each(localized.map((item) => [item.type, item] as const))(
			"%s: a scoped read returns published rows only",
			async (type, item) => {
				const table = item.contentTable as PgTable;
				// Narrowed to what the scoping functions actually require, rather than to
				// `never` — casting away the contract would defeat the guard being tested.
				const columns = table as unknown as ScopableContent & {
					entityId: PgColumn;
				};
				const { entityId } = seeded.get(type) as { entityId: string };

				const rows = await active.db
					.select()
					.from(table)
					.where(and(eq(columns.entityId, entityId), publishedOnly(columns)));

				expect(rows).toHaveLength(1);
				expect((rows[0] as { name: string }).name).toBe(`${type} published`);
				expect(() => assertPublished(rows[0] as never)).not.toThrow();
			},
		);

		test.each(localized.map((item) => [item.type, item] as const))(
			"%s: the proposal really was there — an unscoped read returns both",
			async (type, item) => {
				const table = item.contentTable as PgTable;
				// Narrowed to what the scoping functions actually require, rather than to
				// `never` — casting away the contract would defeat the guard being tested.
				const columns = table as unknown as ScopableContent & {
					entityId: PgColumn;
				};
				const { entityId } = seeded.get(type) as { entityId: string };

				const rows = await active.db
					.select()
					.from(table)
					.where(eq(columns.entityId, entityId));

				expect(rows).toHaveLength(2);
			},
		);

		test.each(localized.map((item) => [item.type, item] as const))(
			"%s: the mapper catches a proposal a read path failed to exclude",
			async (type, item) => {
				const table = item.contentTable as PgTable;
				// Narrowed to what the scoping functions actually require, rather than to
				// `never` — casting away the contract would defeat the guard being tested.
				const columns = table as unknown as ScopableContent & {
					entityId: PgColumn;
				};
				const { proposalId } = seeded.get(type) as { proposalId: string };

				const [row] = await active.db
					.select()
					.from(table)
					.where(eq(columns.proposalId, proposalId));

				expect(row).toBeDefined();
				expect(() => assertPublished(row as never)).toThrow(ProposalLeakError);
			},
		);

		// PLAN.md §4.4: ownership filtering lives in the query layer, not in a permission
		// engine — it is a condition on rows rather than a capability.
		test.each(localized.map((item) => [item.type, item] as const))(
			"%s: an author sees their own proposal, a stranger does not",
			async (type, item) => {
				const table = item.contentTable as PgTable;
				// Narrowed to what the scoping functions actually require, rather than to
				// `never` — casting away the contract would defeat the guard being tested.
				const columns = table as unknown as ScopableContent & {
					entityId: PgColumn;
				};
				const { entityId } = seeded.get(type) as { entityId: string };

				const author = accountActor(systemUser, [], []);
				const stranger = accountActor(
					"00000000-0000-0000-0000-0000000000ff",
					[],
					[],
				);

				const asAuthor = await active.db
					.select()
					.from(table)
					.where(
						and(
							eq(columns.entityId, entityId),
							publishedOrOwnProposals(columns, author),
						),
					);
				const asStranger = await active.db
					.select()
					.from(table)
					.where(
						and(
							eq(columns.entityId, entityId),
							publishedOrOwnProposals(columns, stranger),
						),
					);
				const asVisitor = await active.db
					.select()
					.from(table)
					.where(
						and(
							eq(columns.entityId, entityId),
							publishedOrOwnProposals(columns, anonymousActor([])),
						),
					);

				expect(asAuthor).toHaveLength(2);
				expect(asStranger).toHaveLength(1);
				// An anonymous actor owns nothing, so the wider read collapses to the narrow one.
				expect(asVisitor).toHaveLength(1);
			},
		);
	},
);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { REFERENCE_TABLES } from "../db/schema/registry";
import {
	connectForTests,
	NO_DATABASE_REASON,
	type TestDatabase,
} from "../db/testing";
import { findUnpublishedReferences } from "./closure";

/**
 * The publish closure invariant — PLAN.md §2.3.
 *
 * > An entity cannot be published while any reference it holds points at something
 * > unpublished.
 *
 * One rule covering tags, entity links, places and sources alike. §4.6 #5 names the way it
 * rots: written as a hand-written loop it silently permits publishing the moment a fourth
 * reference type exists. So the check iterates `REFERENCE_TABLES`, and these tests prove
 * both that it finds what is there and that it looks in every registered place.
 */

const connection = await connectForTests();

describe.skipIf(connection === null)(
	`the closure invariant (${connection === null ? NO_DATABASE_REASON : "live database"})`,
	() => {
		const active = connection as TestDatabase;
		let system = "";
		let proposalId = "";
		let storyEntity = "";
		let unpublishedPerson = "";
		let publishedTag = "";

		beforeAll(async () => {
			const [account] = await active.sql<{ id: string }[]>`
				WITH seed AS (SELECT uuidv7() AS id)
				INSERT INTO entity (id, type, created_by, updated_by)
				SELECT id, 'user', id, id FROM seed RETURNING id
			`;
			system = account?.id ?? "";

			const make = async (type: string, version: number | null) => {
				const [row] = await active.sql<{ id: string }[]>`
					INSERT INTO entity (id, type, version, original_language, created_by, updated_by)
					VALUES (uuidv7(), ${type}, ${version}, 'de', ${system}, ${system})
					RETURNING id
				`;
				return row?.id ?? "";
			};

			// The story being proposed, the person it mentions (never published), and a tag
			// that *is* published — so the check has to tell them apart rather than flagging
			// every reference.
			storyEntity = await make("story", null);
			unpublishedPerson = await make("person", null);
			publishedTag = await make("tag", 1);

			const [proposalRow] = await active.sql<{ id: string }[]>`
				INSERT INTO proposal (id, entity_id, created_by, updated_by)
				VALUES (uuidv7(), ${storyEntity}, ${system}, ${system})
				RETURNING id
			`;
			proposalId = proposalRow?.id ?? "";

			await active.sql`
				INSERT INTO link (entity_id, version, proposal_id, target_entity_id, created_by, updated_by)
				VALUES (${storyEntity}, NULL, ${proposalId}, ${unpublishedPerson}, ${system}, ${system})
			`;
			await active.sql`
				INSERT INTO entity_tag (entity_id, version, proposal_id, tag_entity_id, created_by, updated_by)
				VALUES (${storyEntity}, NULL, ${proposalId}, ${publishedTag}, ${system}, ${system})
			`;
		});

		afterAll(async () => {
			if (system) await active.sql`TRUNCATE entity CASCADE`;
			await active.close();
		});

		test("finds a reference to something that was never published", async () => {
			const { blocking } = await findUnpublishedReferences(active.db, {
				proposalId,
			});

			expect(blocking).toHaveLength(1);
			expect(blocking[0]).toMatchObject({
				referenceTable: "link",
				targetEntityId: unpublishedPerson,
				targetType: "person",
			});
		});

		test("does not flag a reference to something already published", async () => {
			const { blocking } = await findUnpublishedReferences(active.db, {
				proposalId,
			});

			expect(blocking.map((item) => item.targetEntityId)).not.toContain(
				publishedTag,
			);
		});

		test("clears once the dependency is published", async () => {
			await active.sql`UPDATE entity SET version = 1 WHERE id = ${unpublishedPerson}`;

			expect(
				(await findUnpublishedReferences(active.db, { proposalId })).blocking,
			).toEqual([]);

			await active.sql`UPDATE entity SET version = NULL WHERE id = ${unpublishedPerson}`;
		});

		// §4.6 #5: the whole point of driving this from the registry is that a new reference
		// kind is covered without anyone remembering. If this ever fails, a table was added
		// to the schema and not to REFERENCE_TABLES — which is the silent hole itself.
		test("looks in every registered reference table", async () => {
			const { tablesSearched } = await findUnpublishedReferences(active.db, {
				proposalId,
			});

			expect(tablesSearched).toEqual(REFERENCE_TABLES.map((item) => item.name));
		});

		test("a proposal that references nothing blocks nothing", async () => {
			const [empty] = await active.sql<{ id: string }[]>`
				INSERT INTO proposal (id, entity_id, created_by, updated_by)
				VALUES (uuidv7(), ${storyEntity}, ${system}, ${system})
				RETURNING id
			`;

			const { blocking } = await findUnpublishedReferences(active.db, {
				proposalId: empty?.id ?? "",
			});

			expect(blocking).toEqual([]);
		});
	},
);

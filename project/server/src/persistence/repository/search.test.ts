import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { chip } from "shared";
import { accountActor, anonymousActor } from "../../domain/actor";
import { publishProposal } from "../../domain/publishing";
import { ENTITY_REGISTRY } from "../db/schema/registry";
import {
	connectForTests,
	NO_DATABASE_REASON,
	type TestDatabase,
} from "../db/testing";
import { publishDependencies } from "./publishing";
import { SEARCHED_TABLES, search } from "./search";

/**
 * Search — PLAN.md §4.3, §6, §4.6 #7. Published, current, previewable content only, queried
 * with the configuration each row was indexed with.
 */

test("search walks every registered content table", () => {
	expect([...SEARCHED_TABLES].sort()).toEqual(
		ENTITY_REGISTRY.filter((item) => item.capabilities.versioned)
			.map((item) => getTableName(item.contentTable as PgTable))
			.sort(),
	);
});

const connection = await connectForTests();
const CONFIG = "german_hunspell";

describe.skipIf(connection === null)(
	`search (${connection === null ? NO_DATABASE_REASON : "live database"})`,
	() => {
		const active = connection as TestDatabase;
		const db = active?.db;
		const everyone = anonymousActor(["place:preview", "story:preview"]);
		let system = "";
		let moderator = accountActor("", [], []);
		const marker = `m${Date.now()}`;

		const place = async (
			names: string[],
			options: { config?: string; publishAll?: boolean } = {},
		) => {
			const [row] = await active.sql<{ id: string }[]>`
				INSERT INTO entity (id, type, original_language, created_by, updated_by)
				VALUES (uuidv7(), 'place', 'de', ${system}, ${system}) RETURNING id
			`;
			const entityId = row?.id ?? "";

			for (const [index, name] of names.entries()) {
				const [proposal] = await active.sql<{ id: string }[]>`
					INSERT INTO proposal (id, entity_id, based_on_version, created_by, updated_by)
					VALUES (uuidv7(), ${entityId}, ${index === 0 ? null : index}, ${system}, ${system})
					RETURNING id
				`;
				const proposalId = proposal?.id ?? "";
				await active.sql`
					INSERT INTO place (entity_id, proposal_id, created_by, updated_by)
					VALUES (${entityId}, ${proposalId}, ${system}, ${system})
				`;
				await active.sql`
					INSERT INTO place_content (entity_id, proposal_id, language, name, search_config, created_by, updated_by)
					VALUES (${entityId}, ${proposalId}, 'de', ${`${name} ${marker}`},
					        ${options.config ?? CONFIG}::regconfig, ${system}, ${system})
				`;

				const isLast = index === names.length - 1;
				if (options.publishAll === false && isLast) break;
				await db.transaction(async (tx) => {
					await publishProposal(publishDependencies(tx), proposalId, moderator);
				});
			}
			return entityId;
		};

		const find = async (text: string, actor = everyone) =>
			(
				await search(db, { text: `${text} ${marker}`, config: CONFIG }, actor)
			).map((hit) => hit.id);

		let dorfkirche = "";
		let renamed = "";
		let pendingOnly = "";
		let stockConfig = "";
		let josef = "";
		let mentionsJosef = "";
		let wouldMentionJosef = "";

		/** A published entity of one type, with one German content row. */
		const publish = async (
			type: "person" | "story",
			name: string,
			body: string | null = null,
			options: { publish?: boolean } = {},
		) => {
			const [row] = await active.sql<{ id: string }[]>`
				INSERT INTO entity (id, type, original_language, created_by, updated_by)
				VALUES (uuidv7(), ${type}, 'de', ${system}, ${system}) RETURNING id
			`;
			const entityId = row?.id ?? "";
			const [proposal] = await active.sql<{ id: string }[]>`
				INSERT INTO proposal (id, entity_id, created_by, updated_by)
				VALUES (uuidv7(), ${entityId}, ${system}, ${system}) RETURNING id
			`;
			const proposalId = proposal?.id ?? "";
			await active.sql`
				INSERT INTO ${active.sql(type)} (entity_id, proposal_id, created_by, updated_by)
				VALUES (${entityId}, ${proposalId}, ${system}, ${system})
			`;
			await active.sql`
				INSERT INTO ${active.sql(`${type}_content`)}
				  (entity_id, proposal_id, language, name, ${active.sql(type === "story" ? "body" : "description")}, search_config, created_by, updated_by)
				VALUES (${entityId}, ${proposalId}, 'de', ${name}, ${body},
				        ${CONFIG}::regconfig, ${system}, ${system})
			`;
			if (options.publish !== false) {
				await db.transaction(async (tx) => {
					await publishProposal(publishDependencies(tx), proposalId, moderator);
				});
			}
			return entityId;
		};

		beforeAll(async () => {
			const [account] = await active.sql<{ id: string }[]>`
				WITH seed AS (SELECT uuidv7() AS id)
				INSERT INTO entity (id, type, created_by, updated_by)
				SELECT id, 'user', id, id FROM seed RETURNING id
			`;
			system = account?.id ?? "";
			moderator = accountActor(
				system,
				[],
				ENTITY_REGISTRY.map((item) => `${item.type}:moderate` as const),
			);

			dorfkirche = await place(["Dorfkirche St. Martin"]);
			// Version 1 was a church; version 2 corrected it to the town hall.
			renamed = await place(["Alte Kirche", "Rathaus"]);
			// Proposed, never published.
			pendingOnly = await place(["Kirchenruine"], { publishAll: false });
			// Indexed with a different configuration than the one queried.
			stockConfig = await place(["Kirche am Bach"], { config: "german" });

			// His description is `person:view` content: gated, not part of a preview (§4.4).
			josef = await publish(
				"person",
				`Josef Huber ${marker}`,
				`Feuerwehrkommandant ${marker}`,
			);
			// The story never says "Huber": the chip stores an id, not a name (§11).
			mentionsJosef = await publish(
				"story",
				"Das Feuerwehrfest",
				`Mit ${chip(josef)} am Zapfhahn.`,
			);
			wouldMentionJosef = await publish(
				"story",
				"Noch nicht freigegeben",
				chip(josef),
				{ publish: false },
			);
		});

		afterAll(async () => {
			await active.sql`TRUNCATE entity CASCADE`;
			await active.close();
		});

		// The reason the dictionary exists (§4.3): stemming alone never gets here.
		test("compound splitting: Kirche finds Dorfkirche", async () => {
			expect(await find("Kirche")).toContain(dorfkirche);
		});

		test("a proposal is never found", async () => {
			expect(await find("Kirchenruine")).not.toContain(pendingOnly);
		});

		// §6: surfacing superseded text shows what the archive has explicitly corrected.
		test("only the current version is searched", async () => {
			expect(await find("Kirche")).not.toContain(renamed);
			expect(await find("Rathaus")).toContain(renamed);
		});

		test("rows indexed with another configuration do not answer this one", async () => {
			expect(await find("Bach")).not.toContain(stockConfig);
		});

		// §4.6 #7: a result is a preview, so a type the actor cannot preview is not searched.
		test("types the actor cannot preview are not searched at all", async () => {
			expect(await find("Kirche", anonymousActor(["story:preview"]))).toEqual(
				[],
			);
		});

		// §11: search goes through the links, because a chip carries no name to match.
		describe("through the links", () => {
			// Stories are viewable, as the public role has them by default (§4.4); people are
			// preview-only, as a living person's record is.
			const people = anonymousActor([
				"person:preview",
				"story:preview",
				"story:view",
			]);

			test("an entry is found by the name of what it mentions, below that entry itself", async () => {
				const hits = await find("Huber", people);

				expect(hits).toEqual([josef, mentionsJosef]);
			});

			test("only through what the reader may preview", async () => {
				// The story is previewable; Josef is not — so naming him finds nothing, which
				// is what stops a search revealing who a story mentions.
				expect(await find("Huber", anonymousActor(["story:preview"]))).toEqual(
					[],
				);
			});

			// §4.4: a reader who may only preview a person may only be matched against what a
			// preview shows — or a search would answer what the gated record says.
			test("a preview-only reader is not matched against what only `view` shows", async () => {
				expect(await find("Feuerwehrkommandant", people)).toEqual([]);
			});

			test("a reader who may view people is", async () => {
				const viewers = anonymousActor([
					"person:preview",
					"person:view",
					"story:preview",
					"story:view",
				]);
				expect(await find("Feuerwehrkommandant", viewers)).toEqual([
					josef,
					mentionsJosef,
				]);
			});

			// The other direction of the same leak: a link comes from any prose field, so
			// following one from an entry the reader may only preview would reveal what its
			// gated text says.
			test("links are followed only from entries the reader may view", async () => {
				const previewOnly = anonymousActor(["person:preview", "story:preview"]);
				expect(await find("Huber", previewOnly)).toEqual([josef]);
			});

			test("a mention in an unpublished proposal does not count", async () => {
				expect(await find("Huber", people)).not.toContain(wouldMentionJosef);
			});
		});

		test("a blank query is not a search", async () => {
			expect(
				await search(db, { text: "   ", config: CONFIG }, everyone),
			).toEqual([]);
		});
	},
);

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTableName } from "drizzle-orm";
import { chip, decade, year } from "shared";
import { accountActor, anonymousActor } from "../../domain/actor";
import { publishAll, publishProposal } from "../../domain/publishing";
import { ENTITY_REGISTRY } from "../db/schema/registry";
import {
	connectForTests,
	NO_DATABASE_REASON,
	type TestDatabase,
} from "../db/testing";
import { publishDependencies } from "./publishing";
import {
	backlinks,
	findProposal,
	findPublished,
	findVersion,
	history,
	pendingProposals,
	READERS,
} from "./read";

/**
 * Published reads — PLAN.md §5.1, §2.6, §4.6 #1.
 *
 * Seeded through the real publish path rather than by writing published rows directly, so
 * these prove the reader understands what publishing actually writes — including the
 * proposal rows publishing leaves behind annotated with the same version number, which are
 * exactly what a careless read would return twice.
 */

describe("the reader covers the registry", () => {
	// A type with no reader would fail on its first request; this fails it here instead.
	test("every versioned registered type has a reader, and no reader is orphaned", () => {
		const versioned = ENTITY_REGISTRY.filter(
			(item) => item.capabilities.versioned,
		);

		expect(Object.keys(READERS).sort()).toEqual(
			versioned.map((item) => item.type).sort(),
		);

		for (const item of versioned) {
			const reader = READERS[item.type as keyof typeof READERS];
			expect(getTableName(reader.table)).toBe(getTableName(item.table));
			expect(getTableName(reader.contentTable)).toBe(
				getTableName(item.contentTable as never),
			);
		}
	});
});

const connection = await connectForTests();

describe.skipIf(connection === null)(
	`published reads (${connection === null ? NO_DATABASE_REASON : "live database"})`,
	() => {
		const active = connection as TestDatabase;
		const db = active?.db;
		const anonymous = anonymousActor([]);
		let system = "";
		let moderator = accountActor("", [], []);

		const newEntity = async (type: string) => {
			const [row] = await active.sql<{ id: string }[]>`
				INSERT INTO entity (id, type, original_language, created_by, updated_by)
				VALUES (uuidv7(), ${type}, 'de', ${system}, ${system}) RETURNING id
			`;
			return row?.id ?? "";
		};

		const newProposal = async (entityId: string, basedOn: number | null) => {
			const [row] = await active.sql<{ id: string }[]>`
				INSERT INTO proposal (id, entity_id, based_on_version, created_by, updated_by)
				VALUES (uuidv7(), ${entityId}, ${basedOn}, ${system}, ${system}) RETURNING id
			`;
			return row?.id ?? "";
		};

		/** The columns each type's own row cannot do without. */
		const requiredColumns = async (type: string) => {
			switch (type) {
				// Published people: the closure invariant refuses a relationship between
				// people who are not in the archive yet (§2.3).
				case "relationship":
					return {
						kind: "married",
						person_a_id: await publishedPerson("Josef"),
						person_b_id: await publishedPerson("Anna"),
					};
				case "terms":
					return { effective_from: "2027-01-01" };
				default:
					return {};
			}
		};

		/** Writes a proposal's rows for a type: its own row, and one content row in German. */
		const writeProposalRows = async (
			type: string,
			entityId: string,
			proposalId: string,
			name: string,
			extra: Record<string, unknown>,
			/** Prose, so a chip can go in it — the link set is derived from it (§2.6). */
			abstract: string | null = null,
		) => {
			const item = ENTITY_REGISTRY.find((entry) => entry.type === type);
			if (!item?.contentTable) throw new Error(`no registry entry for ${type}`);

			await active.sql`
				INSERT INTO ${active.sql(getTableName(item.table))} ${active.sql({
					entity_id: entityId,
					proposal_id: proposalId,
					created_by: system,
					updated_by: system,
					...extra,
				})}
			`;
			await active.sql`
				INSERT INTO ${active.sql(getTableName(item.contentTable))} ${active.sql(
					{
						entity_id: entityId,
						proposal_id: proposalId,
						language: "de",
						name,
						abstract,
						search_config: "german",
						created_by: system,
						updated_by: system,
					},
				)}
			`;
		};

		const publishedPerson = async (name: string) => {
			const id = await newEntity("person");
			const proposal = await newProposal(id, null);
			await writeProposalRows("person", id, proposal, name, {});
			await publish(proposal);
			return id;
		};

		const publish = (proposalId: string) =>
			db.transaction(async (tx) => {
				return await publishProposal(
					publishDependencies(tx),
					proposalId,
					moderator,
				);
			});

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
		});

		afterAll(async () => {
			await active.sql`TRUNCATE entity CASCADE`;
			await active.close();
		});

		const versioned = ENTITY_REGISTRY.filter(
			(item) => item.capabilities.versioned,
		).map((item) => [item.type] as const);

		// §4.6 #1, through the repository this time: a published version is read, and the
		// pending proposal sitting beside it — same entity, same language — is not.
		test.each(versioned)(
			"%s: findPublished returns the published version and never the pending proposal",
			async (type) => {
				const entityId = await newEntity(type);
				const extra = await requiredColumns(type);

				const create = await newProposal(entityId, null);
				await writeProposalRows(type, entityId, create, `${type} v1`, extra);
				await publish(create);

				const pending = await newProposal(entityId, 1);
				await writeProposalRows(
					type,
					entityId,
					pending,
					`${type} PENDING`,
					extra,
				);

				const read = await findPublished(db, entityId, anonymous);

				expect(read).not.toBeNull();
				expect(read?.type).toBe(type);
				expect(read?.version).toBe(1);
				// One row, not one per proposal fed into the version (§2.2).
				expect(read?.content.map((row) => row.name)).toEqual([`${type} v1`]);
			},
		);

		test.each(versioned)(
			"%s: an entity that was only ever proposed does not exist to a reader",
			async (type) => {
				const entityId = await newEntity(type);
				const proposal = await newProposal(entityId, null);
				await writeProposalRows(
					type,
					entityId,
					proposal,
					"never published",
					await requiredColumns(type),
				);

				expect(await findPublished(db, entityId, anonymous)).toBeNull();
				expect(await findVersion(db, entityId, 1, anonymous)).toBeNull();
				expect(await history(db, entityId, anonymous)).toEqual([]);
			},
		);

		test("versions: each one reads as it was, the head is the latest, and the future is null", async () => {
			const entityId = await newEntity("story");

			const first = await newProposal(entityId, null);
			await writeProposalRows("story", entityId, first, "Erste Fassung", {
				occurred_start: "[1940-01-01,1950-01-01)",
				occurred_start_granularity: "decade",
			});
			await publish(first);

			const second = await newProposal(entityId, 1);
			await writeProposalRows("story", entityId, second, "Zweite Fassung", {
				occurred_start: "[1939-01-01,1940-01-01)",
				occurred_start_granularity: "year",
				occurred_end: "[1945-01-01,1946-01-01)",
				occurred_end_granularity: "year",
			});
			await publish(second);

			const head = await findPublished(db, entityId, anonymous);
			expect(head?.version).toBe(2);
			expect(head?.content[0]?.name).toBe("Zweite Fassung");
			expect(head?.type === "story" && head.fields.occurred).toEqual({
				start: year(1939),
				end: year(1945),
			});

			const v1 = await findVersion(db, entityId, 1, anonymous);
			expect(v1?.content[0]?.name).toBe("Erste Fassung");
			expect(v1?.type === "story" && v1.fields.occurred).toEqual({
				start: decade(1940),
			});

			expect(await findVersion(db, entityId, 3, anonymous)).toBeNull();
			expect(await findVersion(db, entityId, 0, anonymous)).toBeNull();

			const versions = await history(db, entityId, anonymous);
			expect(versions.map((entry) => entry.version)).toEqual([1, 2]);
			expect(versions[0]?.publishedBy).toBe(system);
		});

		// §4.4: not deceased means living — and a death can be known without its date.
		test("a person reads as living, dead on a date, or dead on an unknown date", async () => {
			const read = async (extra: Record<string, unknown>) => {
				const entityId = await newEntity("person");
				const proposal = await newProposal(entityId, null);
				await writeProposalRows("person", entityId, proposal, "Josef", extra);
				await publish(proposal);
				const person = await findPublished(db, entityId, anonymous);
				return person?.type === "person" ? person.fields.died : "not a person";
			};

			expect(await read({})).toBeNull();
			expect(await read({ deceased: true })).toBe("unknown");
			expect(
				await read({
					deceased: true,
					died: "[1960-01-01,1970-01-01)",
					died_granularity: "decade",
				}),
			).toEqual(decade(1960));
		});

		test("a death date on someone not marked deceased is refused", async () => {
			const entityId = await newEntity("person");
			const proposal = await newProposal(entityId, null);
			const error = await writeProposalRows(
				"person",
				entityId,
				proposal,
				"Josef",
				{ died: "[1960-01-01,1970-01-01)", died_granularity: "decade" },
			).catch((caught) => caught as Error);

			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toContain("person_died_implies_deceased");
		});

		test("references come back with the version that holds them", async () => {
			const target = await newEntity("place");
			const placeProposal = await newProposal(target, null);
			await writeProposalRows("place", target, placeProposal, "Kirche", {});
			await publish(placeProposal);

			const entityId = await newEntity("media");
			const proposal = await newProposal(entityId, null);
			await writeProposalRows(
				"media",
				entityId,
				proposal,
				"Foto",
				{},
				`Vor der ${chip(target)}.`,
			);
			await publish(proposal);

			const read = await findPublished(db, entityId, anonymous);
			expect(read?.references.links).toEqual([target]);
		});

		// §2.6: backlinks are discovery over *current* published content only.
		test("backlinks: current published versions only — not proposals, not superseded versions", async () => {
			const person = await newEntity("person");
			const personProposal = await newProposal(person, null);
			await writeProposalRows("person", person, personProposal, "Josef", {});
			await publish(personProposal);

			const linking = async (name: string) => {
				const entityId = await newEntity("story");
				const proposal = await newProposal(entityId, null);
				await writeProposalRows(
					"story",
					entityId,
					proposal,
					name,
					{},
					`Mit ${chip(person)}.`,
				);
				return { entityId, proposal };
			};

			// Published and still linking: a backlink.
			const current = await linking("mentions Josef");
			await publish(current.proposal);

			// Linking only from a pending proposal: not a backlink.
			await linking("pending mention");

			// Linked in version 1, link removed in version 2: no longer a backlink.
			const superseded = await linking("used to mention Josef");
			await publish(superseded.proposal);
			const edit = await newProposal(superseded.entityId, 1);
			await writeProposalRows(
				"story",
				superseded.entityId,
				edit,
				"no longer mentions him",
				{},
			);
			await publish(edit);

			// Only from entries the reader may view: a link can come from gated prose.
			expect(await backlinks(db, person, anonymous)).toEqual([]);
			const readers = anonymousActor(["story:view"]);
			expect(await backlinks(db, person, readers)).toEqual([
				{ id: current.entityId, type: "story" },
			]);
		});

		// §2.2: a proposer sees their own proposal; §4.4: ownership is a row condition.
		test("a proposal is visible to its author and its moderators, and to nobody else", async () => {
			const entityId = await newEntity("place");
			const proposal = await newProposal(entityId, null);
			await writeProposalRows("place", entityId, proposal, "Neue Mühle", {});

			const author = accountActor(system, [], []);
			const placeModerator = accountActor(
				"00000000-0000-0000-0000-00000000000a",
				[],
				["place:moderate"],
			);
			const personModerator = accountActor(
				"00000000-0000-0000-0000-00000000000b",
				[],
				["person:moderate"],
			);

			const asAuthor = await findProposal(db, proposal, author);
			expect(asAuthor?.content.map((row) => row.name)).toEqual(["Neue Mühle"]);
			expect(asAuthor?.basedOnVersion).toBeNull();

			expect(await findProposal(db, proposal, placeModerator)).not.toBeNull();
			expect(await findProposal(db, proposal, personModerator)).toBeNull();
			expect(await findProposal(db, proposal, anonymous)).toBeNull();
		});

		test("the queue lists only the types the actor moderates, and flags stale proposals", async () => {
			const entityId = await newEntity("story");
			const create = await newProposal(entityId, null);
			await writeProposalRows("story", entityId, create, "v1", {});
			await publish(create);

			const fresh = await newProposal(entityId, 1);
			await writeProposalRows("story", entityId, fresh, "fresh", {});

			const competing = await newProposal(entityId, 1);
			await writeProposalRows("story", entityId, competing, "competing", {});
			await publish(competing);

			const storyModerator = accountActor(system, [], ["story:moderate"]);
			const queue = await pendingProposals(db, storyModerator);
			const entry = queue.find((item) => item.proposalId === fresh);

			expect(entry).toMatchObject({
				type: "story",
				basedOnVersion: 1,
				head: 2,
				stale: true,
			});
			expect(queue.every((item) => item.type === "story")).toBe(true);
			expect(queue.some((item) => item.proposalId === competing)).toBe(false);

			expect(
				await pendingProposals(
					db,
					accountActor(system, [], ["place:moderate"]),
				),
			).not.toContainEqual(expect.objectContaining({ proposalId: fresh }));
			expect(await pendingProposals(db, anonymous)).toEqual([]);
		});

		// §2.3: the common case — a photo proposed together with its new Place.
		test("publishAll puts a photo and its new place out together", async () => {
			const placeId = await newEntity("place");
			const placeProposal = await newProposal(placeId, null);
			await writeProposalRows("place", placeId, placeProposal, "Mühle", {});

			const mediaId = await newEntity("media");
			const mediaProposal = await newProposal(mediaId, null);
			await writeProposalRows(
				"media",
				mediaId,
				mediaProposal,
				"Die Mühle 1952",
				{},
				chip(placeId),
			);

			// Alone, the photo is refused: its place is not published.
			const alone = await publish(mediaProposal).catch(
				(caught) => caught as Error,
			);
			expect(alone).toBeInstanceOf(Error);
			expect(await findPublished(db, mediaId, anonymous)).toBeNull();

			await db.transaction(async (tx) => {
				await publishAll(
					publishDependencies(tx),
					[mediaProposal, placeProposal],
					moderator,
				);
			});

			const photo = await findPublished(db, mediaId, anonymous);
			expect(photo?.references.links).toEqual([placeId]);
			expect(await findPublished(db, placeId, anonymous)).not.toBeNull();
		});
	},
);

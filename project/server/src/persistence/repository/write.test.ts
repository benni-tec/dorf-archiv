import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chip, day, decade, month, year } from "shared";
import { accountActor, anonymousActor } from "../../domain/actor";
import type { Draft, VersionedType } from "../../domain/entity";
import { DraftError, editProposal, propose } from "../../domain/proposing";
import { publishProposal } from "../../domain/publishing";
import { ENTITY_REGISTRY } from "../db/schema/registry";
import {
	connectForTests,
	NO_DATABASE_REASON,
	type TestDatabase,
} from "../db/testing";
import { publishDependencies } from "./publishing";
import { findProposal, findPublished } from "./read";
import { boundingBox, proposeDependencies, WRITERS } from "./write";

/**
 * The write path against a real database — PLAN.md §5.1's `propose`, §11.
 *
 * The test that matters is the **round trip**: for every type, a draft with every field set
 * is proposed, published and read back, and must come back as it went in. `WRITERS` and
 * `READERS` are written by hand as each other's inverse; this is what stops a field being read
 * but never written, written to the wrong column, or quietly dropped on the way.
 */

describe("the writers cover the registry", () => {
	test("every versioned type has a writer", () => {
		expect(Object.keys(WRITERS).sort()).toEqual(
			ENTITY_REGISTRY.filter((item) => item.capabilities.versioned)
				.map((item) => item.type)
				.sort(),
		);
	});
});

describe("boundingBox", () => {
	test("spans every coordinate of a polygon, however nested", () => {
		expect(
			boundingBox({
				type: "Polygon",
				coordinates: [
					[
						[10.1, 48.3],
						[10.4, 48.2],
						[10.2, 48.6],
						[10.1, 48.3],
					],
				],
			}),
		).toEqual({
			minLatitude: 48.2,
			maxLatitude: 48.6,
			minLongitude: 10.1,
			maxLongitude: 10.4,
		});
	});

	test("is empty for no geometry", () => {
		expect(boundingBox(null).minLatitude).toBeNull();
	});
});

const connection = await connectForTests();

describe.skipIf(connection === null)(
	`the write path (${connection === null ? NO_DATABASE_REASON : "live database"})`,
	() => {
		const active = connection as TestDatabase;
		const db = active?.db;
		let contributor = accountActor("", [], []);
		let moderator = accountActor("", [], []);
		/** Another contributor, whose unpublished work is none of the first one's business. */
		let stranger = accountActor("", [], []);
		const references = {
			person: "",
			otherPerson: "",
			tag: "",
			source: "",
			asset: "",
			unpublishedPerson: "",
		};

		const create = (draft: Draft, by = contributor) =>
			db.transaction(
				async (tx) =>
					await propose(
						proposeDependencies(tx, { searchConfig: "german" }),
						{ kind: "create", originalLanguage: "de", draft },
						by,
					),
			);

		/** An uploaded file, as the upload path will record it (§4.5). */
		const upload = async (by: string) => {
			const [asset] = await active.sql<{ id: string }[]>`
				INSERT INTO asset (storage_key, sha256, mime_type, byte_size, created_by, updated_by)
				VALUES (${`test/${crypto.randomUUID()}`}, 'x', 'image/webp', 1, ${by}, ${by})
				RETURNING id
			`;
			return asset?.id ?? "";
		};

		const edit = (entityId: string, basedOnVersion: number, draft: Draft) =>
			db.transaction(
				async (tx) =>
					await propose(
						proposeDependencies(tx, { searchConfig: "german" }),
						{ kind: "edit", entityId, basedOnVersion, draft },
						contributor,
					),
			);

		const publish = (proposalId: string) =>
			db.transaction(
				async (tx) =>
					await publishProposal(publishDependencies(tx), proposalId, moderator),
			);

		/** Creates and publishes, returning the entity id. */
		const published = async (draft: Draft) => {
			const { entityId, proposalId } = await create(draft);
			await publish(proposalId);
			return entityId;
		};

		beforeAll(async () => {
			const [account] = await active.sql<{ id: string }[]>`
				WITH seed AS (SELECT uuidv7() AS id)
				INSERT INTO entity (id, type, created_by, updated_by)
				SELECT id, 'user', id, id FROM seed RETURNING id
			`;
			const id = account?.id ?? "";
			const another = async () => {
				const [row] = await active.sql<{ id: string }[]>`
					INSERT INTO entity (id, type, created_by, updated_by)
					VALUES (uuidv7(), 'user', ${id}, ${id}) RETURNING id
				`;
				return row?.id ?? "";
			};
			contributor = accountActor(id, [], []);
			moderator = accountActor(
				await another(),
				[],
				ENTITY_REGISTRY.map((item) => `${item.type}:moderate` as const),
			);
			stranger = accountActor(await another(), [], []);

			const named = (type: "person" | "source", name: string): Draft =>
				({
					type,
					fields:
						type === "person"
							? { born: null, died: null }
							: { identifier: null, published: null },
					content: [
						{
							language: "de",
							name,
							abstract: null,
							...(type === "person"
								? { description: null }
								: { citationText: null }),
						},
					],
					tags: [],
					citations: [],
				}) as Draft;

			references.person = await published(named("person", "Josef Huber"));
			references.otherPerson = await published(named("person", "Anna Huber"));
			references.source = await published(named("source", "Pfarrchronik"));
			references.tag = await published({
				type: "tag",
				fields: {},
				content: [{ language: "de", name: "Feuerwehr", abstract: null }],
				tags: [],
				citations: [],
			});
			references.unpublishedPerson = (
				await create(named("person", "Noch nicht veröffentlicht"))
			).entityId;

			references.asset = await upload(id);
		});

		afterAll(async () => {
			await active.sql`TRUNCATE entity CASCADE`;
			await active.close();
		});

		/** A draft for every type, with every field set to something other than its default. */
		const fullDraft = (type: VersionedType): Draft => {
			const prose = `Mit ${chip(references.person)}.`;
			const common = {
				tags: [references.tag],
				citations: [{ sourceEntityId: references.source, locator: "S. 12" }],
			};
			switch (type) {
				case "person":
					return {
						type,
						fields: { born: day(1890, 3, 14), died: decade(1960) },
						content: [
							{
								language: "de",
								name: "Maria Huber",
								abstract: prose,
								description: "**Hebamme**",
							},
							{
								language: "en",
								name: "Maria Huber",
								abstract: null,
								description: "Midwife",
							},
						],
						...common,
					};
				case "place":
					return {
						type,
						fields: {
							point: { latitude: 48.3, longitude: 10.2 },
							area: {
								type: "Polygon",
								coordinates: [
									[
										[10.1, 48.3],
										[10.4, 48.2],
										[10.2, 48.6],
										[10.1, 48.3],
									],
								],
							},
							validFrom: year(1850),
							validUntil: month(1972, 6),
						},
						content: [
							{
								language: "de",
								name: "Alte Mühle",
								abstract: prose,
								description: "Am Bach.",
							},
						],
						...common,
					};
				case "media":
					return {
						type,
						fields: {
							captured: year(1952),
							point: { latitude: 48.31, longitude: 10.21 },
						},
						content: [
							{
								language: "de",
								name: "Feuerwehrfest",
								abstract: null,
								description: "Vor dem Gerätehaus.",
								caption: prose,
							},
						],
						files: [
							{
								assetId: references.asset,
								role: "original",
								isPrimary: true,
								sortOrder: 0,
							},
						],
						...common,
					};
				case "story":
					return {
						type,
						fields: {
							occurred: { start: year(1939), end: year(1945) },
						},
						content: [
							{
								language: "de",
								name: "Die Kriegsjahre",
								abstract: null,
								body: prose,
							},
						],
						...common,
					};
				case "relationship":
					return {
						type,
						fields: {
							kind: "married",
							directed: false,
							personA: references.person,
							personB: references.otherPerson,
							start: year(1921),
							end: decade(1960),
						},
						content: [
							{
								language: "de",
								name: "Ehe",
								abstract: null,
								description: prose,
							},
						],
						...common,
					};
				case "source":
					return {
						type,
						fields: {
							identifier: "PfA 12/3",
							published: { start: year(1880), end: year(1920) },
						},
						content: [
							{
								language: "de",
								name: "Taufbuch",
								abstract: null,
								citationText: prose,
							},
						],
						...common,
					};
				case "tag":
					return {
						type,
						fields: {},
						content: [{ language: "de", name: "Mühle", abstract: "Mahlen." }],
						tags: [],
						citations: [],
					};
				case "terms":
					return {
						type,
						fields: { effectiveFrom: "2027-01-01" },
						content: [
							{
								language: "de",
								name: "Nutzungsbedingungen",
								abstract: null,
								body: "§ 1 Geltung.",
							},
						],
						tags: [],
						citations: [],
					};
			}
		};

		const versioned = ENTITY_REGISTRY.filter(
			(item) => item.capabilities.versioned,
		).map((item) => [item.type as VersionedType] as const);

		test.each(versioned)(
			"%s: what is proposed is what is published",
			async (type) => {
				const draft = fullDraft(type);
				const entityId = await published(draft);

				const read = await findPublished(db, entityId, anonymousActor([]));
				const historic = !["tag", "terms"].includes(type);

				expect(read?.type).toBe(type);
				expect(read?.fields).toEqual(draft.fields as never);
				expect(read?.content).toEqual(draft.content as never);
				expect(read?.references).toEqual({
					// The one thing not sent: derived from the bodies (§2.6).
					links: historic ? [references.person] : [],
					tags: draft.tags,
					citations: draft.citations,
				});
				if ("files" in draft)
					expect(read && "files" in read && read.files).toEqual(draft.files);
			},
		);

		test("a proposal carries its derived links before anyone publishes it", async () => {
			const { proposalId } = await create(fullDraft("story"));

			const read = await findProposal(db, proposalId, moderator);

			expect(read?.references.links).toEqual([references.person]);
		});

		test("a death recorded without its date round-trips as unknown", async () => {
			const draft = fullDraft("person");
			const entityId = await published({
				...draft,
				fields: { born: null, died: "unknown" },
			} as Draft);

			const read = await findPublished(db, entityId, anonymousActor([]));
			expect(read?.type === "person" && read.fields.died).toBe("unknown");
		});

		test("bodies are stored canonical", async () => {
			const draft = fullDraft("story");
			const { proposalId } = await create({
				...draft,
				content: [
					{
						language: "de",
						name: "  Die Kriegsjahre  ",
						abstract: null,
						body: "__fett__\n\n* eins",
					},
				],
			} as Draft);

			const [row] = await active.sql<{ name: string; body: string }[]>`
				SELECT name, body FROM story_content WHERE proposal_id = ${proposalId}
			`;
			expect(row).toEqual({
				name: "Die Kriegsjahre",
				body: "**fett**\n\n- eins",
			});
		});

		test("a chip at an unpublished entry may be proposed; publishing then waits for it", async () => {
			const draft = fullDraft("story");
			const { proposalId } = await create({
				...draft,
				content: [
					{
						language: "de",
						name: "Mit Unbekanntem",
						abstract: null,
						body: chip(references.unpublishedPerson),
					},
				],
			} as Draft);

			const error = await publish(proposalId).catch(
				(caught: unknown) => caught as Error,
			);
			expect(error.name).toBe("ClosureViolationError");
		});

		test("a chip at something that is not an entry is refused on save", async () => {
			const draft = fullDraft("story");
			const error = await create({
				...draft,
				content: [
					{
						language: "de",
						name: "x",
						abstract: null,
						body: chip(references.tag),
					},
				],
			} as Draft).catch((caught: unknown) => caught as Error);

			expect(error).toBeInstanceOf(DraftError);
		});

		test("an edit is written whole, and replacing it leaves nothing of the old one", async () => {
			const entityId = await published(fullDraft("story"));
			const draft = fullDraft("story");
			const { proposalId } = await edit(entityId, 1, draft);

			await db.transaction(
				async (tx) =>
					await editProposal(
						proposeDependencies(tx, { searchConfig: "german" }),
						proposalId,
						{ ...draft, tags: [], citations: [] },
						contributor,
					),
			);

			const read = await findProposal(db, proposalId, moderator);
			expect(read?.references.tags).toEqual([]);
			expect(read?.references.citations).toEqual([]);
			expect(read?.content.map((row) => row.name)).toEqual(["Die Kriegsjahre"]);
		});

		// §4.6: the places where a mistake grants more rather than less.
		describe("what a draft cannot do", () => {
			test("write a published row, whatever extra fields it carries", async () => {
				const draft = fullDraft("media");
				const { entityId } = await create({
					...draft,
					files: [
						{
							...("files" in draft ? draft.files[0] : {}),
							// A client sending this must not reach a published version.
							proposalId: null,
							version: 1,
							entityId: references.person,
						} as never,
					],
				} as Draft);

				const published = await active.sql`
					SELECT 1 FROM media_file WHERE proposal_id IS NULL
					  AND (entity_id = ${entityId} OR entity_id = ${references.person})
				`;
				expect(published).toHaveLength(0);
			});

			test("reference somebody else's unpublished entry, or learn that it exists", async () => {
				const { entityId: theirs } = await create(
					{
						...fullDraft("place"),
						content: [
							{
								language: "de",
								name: "Geheim",
								abstract: null,
								description: null,
							},
						],
						tags: [],
						citations: [],
					} as Draft,
					stranger,
				);
				const nonexistent = "0190a8e2-7a3b-7c4d-8e5f-000000000000";

				const refused = async (target: string) =>
					(
						(await create({
							...fullDraft("story"),
							content: [
								{
									language: "de",
									name: "x",
									abstract: null,
									body: chip(target),
								},
							],
						} as Draft).catch((caught: unknown) => caught)) as DraftError
					).problems[0]?.message.replace(target, "<id>");

				// The same answer either way: nothing to tell the two apart.
				expect(await refused(theirs)).toBe(await refused(nonexistent));
			});

			// The only file malformed: nothing is left to ask about, and asking about nothing
			// would have been `IN ()`, which is not SQL.
			test("a draft whose only file id is malformed is a DraftError", async () => {
				const draft = fullDraft("media");
				const error = await create({
					...draft,
					files: [
						{ assetId: "x", role: "original", isPrimary: true, sortOrder: 0 },
					],
				} as Draft).catch((caught: unknown) => caught as Error);

				expect(error).toBeInstanceOf(DraftError);
			});

			test("attach somebody else's upload", async () => {
				const draft = fullDraft("media");
				const theirs = await upload(stranger.id ?? "");

				const error = await create({
					...draft,
					files: [
						{
							assetId: theirs,
							role: "original",
							isPrimary: true,
							sortOrder: 0,
						},
					],
				} as Draft).catch((caught: unknown) => caught as DraftError);

				expect(error).toBeInstanceOf(DraftError);
				expect(error.problems.map((problem) => problem.path)).toEqual([
					"files.0",
				]);
			});

			test("make a moderator the author of a contributor's words", async () => {
				const { proposalId } = await create(fullDraft("story"));

				await db.transaction(
					async (tx) =>
						await editProposal(
							proposeDependencies(tx, { searchConfig: "german" }),
							proposalId,
							fullDraft("story"),
							moderator,
						),
				);

				const rows = await active.sql<
					{ created_by: string; updated_by: string }[]
				>`
					SELECT created_by, updated_by FROM story_content WHERE proposal_id = ${proposalId}
				`;
				expect(rows).toEqual([
					{ created_by: contributor.id ?? "", updated_by: moderator.id ?? "" },
				]);
			});
		});
	},
);

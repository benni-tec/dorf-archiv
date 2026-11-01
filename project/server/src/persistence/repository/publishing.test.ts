import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chip } from "shared";
import { accountActor } from "../../domain/actor";
import { ConflictError, IncompleteProposalError } from "../../domain/merge";
import {
	ClosureViolationError,
	NotPublishableError,
	publishAll,
	publishProposal,
} from "../../domain/publishing";
import { rejectProposal } from "../../domain/rejection";
import { reviewProposal } from "../../domain/review";
import {
	connectForTests,
	NO_DATABASE_REASON,
	type TestDatabase,
} from "../db/testing";
import {
	publishDependencies,
	rehearsal,
	rejectDependencies,
} from "./publishing";
import { findProposal, findPublished, findVersion } from "./read";

/**
 * Publishing, end to end against a real database — PLAN.md §2.2, §2.3, §11.
 *
 * The service's own tests cover the rules with stub dependencies. These cover the half that
 * only SQL can answer: that the merge really writes a published row-set from the right
 * sides, that the proposal keeps its own annotated rows, that links come from the bodies,
 * and that the four `(proposal_id, version)` combinations of §2.2 come out of the database
 * exactly as the table in the plan describes them.
 */

const connection = await connectForTests();

describe.skipIf(connection === null)(
	`publishing (${connection === null ? NO_DATABASE_REASON : "live database"})`,
	() => {
		const active = connection as TestDatabase;
		let system = "";
		let entityId = "";
		let proposalId = "";
		let moderator = accountActor("", [], []);

		// No TRUNCATE between cases: it needs an ACCESS EXCLUSIVE lock on all twenty-eight
		// tables, so it blocks behind anything still holding one and turns a lock wait into a
		// destroyed connection. Each case makes its own entities instead, which is both
		// faster and a better test — these do not need a pristine database, only their own.
		beforeEach(async () => {
			const [account] = await active.sql<{ id: string }[]>`
				WITH seed AS (SELECT uuidv7() AS id)
				INSERT INTO entity (id, type, created_by, updated_by)
				SELECT id, 'user', id, id FROM seed RETURNING id
			`;
			system = account?.id ?? "";
			moderator = accountActor(system, [], ["story:moderate"]);

			const [story] = await active.sql<{ id: string }[]>`
				INSERT INTO entity (id, type, original_language, created_by, updated_by)
				VALUES (uuidv7(), 'story', 'de', ${system}, ${system}) RETURNING id
			`;
			entityId = story?.id ?? "";

			const [proposal] = await active.sql<{ id: string }[]>`
				INSERT INTO proposal (id, entity_id, created_by, updated_by)
				VALUES (uuidv7(), ${entityId}, ${system}, ${system}) RETURNING id
			`;
			proposalId = proposal?.id ?? "";

			await active.sql`
				INSERT INTO story (entity_id, version, proposal_id, created_by, updated_by)
				VALUES (${entityId}, NULL, ${proposalId}, ${system}, ${system})
			`;
			await active.sql`
				INSERT INTO story_content (entity_id, version, proposal_id, language, name, abstract, body, search_config, created_by, updated_by)
				VALUES (${entityId}, NULL, ${proposalId}, 'de', 'Die Kriegsjahre', 'Erinnerungen', 'Es war ein langer Winter.', 'german', ${system}, ${system})
			`;
		});

		afterAll(async () => {
			await active.sql`TRUNCATE entity CASCADE`;
			await active.close();
		});

		// The callback is `async` and awaits, rather than returning the promise straight
		// through. Handing Drizzle's postgres-js transaction a promise it did not await hangs
		// when that promise rejects — the second publish here sat until the test timed out.
		const publish = () =>
			active.db.transaction(
				async (tx) =>
					await publishProposal(publishDependencies(tx), proposalId, moderator),
			);

		const publishTogether = (ids: string[]) =>
			active.db.transaction(
				async (tx) => await publishAll(publishDependencies(tx), ids, moderator),
			);

		/**
		 * A proposal against a published version, made the way the client makes one: load the
		 * base, change what is being changed, and send back the **complete** state (§11). A
		 * language given as null is left out — which publishing refuses.
		 */
		const proposeEdit = async (
			basedOn: number,
			changes: Record<string, { name?: string; body?: string } | null>,
			occurred?: string,
		) => {
			const [edit] = await active.sql<{ id: string }[]>`
				INSERT INTO proposal (id, entity_id, based_on_version, created_by, updated_by)
				VALUES (uuidv7(), ${entityId}, ${basedOn}, ${system}, ${system}) RETURNING id
			`;
			const id = edit?.id ?? "";
			await active.sql`
				INSERT INTO story (entity_id, proposal_id, occurred_start, occurred_start_granularity,
				                   occurred_end, occurred_end_granularity, created_by, updated_by)
				SELECT entity_id, ${id}, occurred_start, occurred_start_granularity,
				       occurred_end, occurred_end_granularity, ${system}, ${system}
				FROM story WHERE entity_id = ${entityId} AND version = ${basedOn} AND proposal_id IS NULL
			`;
			await active.sql`
				INSERT INTO story_content (entity_id, proposal_id, language, name, abstract, body,
				                           search_config, created_by, updated_by)
				SELECT entity_id, ${id}, language, name, abstract, body, search_config, ${system}, ${system}
				FROM story_content WHERE entity_id = ${entityId} AND version = ${basedOn} AND proposal_id IS NULL
			`;
			if (occurred !== undefined) {
				await active.sql`
					UPDATE story SET occurred_start = ${occurred}, occurred_start_granularity = 'year'
					WHERE proposal_id = ${id}
				`;
			}
			for (const [language, change] of Object.entries(changes)) {
				if (change === null) {
					await active.sql`
						DELETE FROM story_content WHERE proposal_id = ${id} AND language = ${language}
					`;
					continue;
				}
				const [existing] = await active.sql`
					SELECT 1 FROM story_content WHERE proposal_id = ${id} AND language = ${language}
				`;
				if (!existing) {
					await active.sql`
						INSERT INTO story_content (entity_id, proposal_id, language, name, search_config, created_by, updated_by)
						VALUES (${entityId}, ${id}, ${language}, ${change.name ?? ""}, 'german', ${system}, ${system})
					`;
				}
				if (change.name !== undefined) {
					await active.sql`
						UPDATE story_content SET name = ${change.name}
						WHERE proposal_id = ${id} AND language = ${language}
					`;
				}
				if (change.body !== undefined) {
					await active.sql`
						UPDATE story_content SET body = ${change.body}
						WHERE proposal_id = ${id} AND language = ${language}
					`;
				}
			}
			return id;
		};

		/** A person entity, published or not, for chips to point at. */
		const person = async (published: boolean) => {
			const [row] = await active.sql<{ id: string }[]>`
				INSERT INTO entity (id, type, original_language, version, created_by, updated_by)
				VALUES (uuidv7(), 'person', 'de', ${published ? 1 : null}, ${system}, ${system})
				RETURNING id
			`;
			return row?.id ?? "";
		};

		test("creates version 1 and makes the content readable as published", async () => {
			const result = await publish();

			expect(result).toEqual({
				entityId,
				version: 1,
				proposalIds: [proposalId],
			});

			const published = await active.sql`
				SELECT name, body FROM story_content
				WHERE entity_id = ${entityId} AND proposal_id IS NULL
			`;

			expect(published).toHaveLength(1);
			expect(published[0]?.name).toBe("Die Kriegsjahre");
			// The whole row is carried over, not just the fields the preview needs.
			expect(published[0]?.body).toBe("Es war ein langer Winter.");
		});

		// PLAN.md §2.2's table, read back out of the database.
		test("leaves the proposal's own rows in place, annotated with the version", async () => {
			await publish();

			const rows = await active.sql<
				{ version: number | null; proposal_id: string | null }[]
			>`
				SELECT version, proposal_id FROM story_content WHERE entity_id = ${entityId}
				ORDER BY proposal_id NULLS FIRST
			`;

			expect(rows).toHaveLength(2);
			// proposal_id NULL + version 1 — the published content of version 1.
			expect(rows[0]).toMatchObject({ version: 1, proposal_id: null });
			// proposal_id set + version 1 — the proposal incorporated into version 1.
			expect(rows[1]).toMatchObject({ version: 1, proposal_id: proposalId });
		});

		test("records who published it, and moves the entity's head", async () => {
			await publish();

			const [version] = await active.sql<{ published_by: string }[]>`
				SELECT published_by FROM entity_version WHERE entity_id = ${entityId}
			`;
			const [entity] = await active.sql<{ version: number }[]>`
				SELECT version FROM entity WHERE id = ${entityId}
			`;

			expect(version?.published_by).toBe(system);
			expect(entity?.version).toBe(1);
		});

		test("marks the proposal accepted", async () => {
			await publish();

			const [row] = await active.sql<{ status: string }[]>`
				SELECT status FROM proposal WHERE id = ${proposalId}
			`;

			expect(row?.status).toBe("accepted");
		});

		// An id that is not one is "no such proposal" — not a failed cast from the database.
		test("something that is not an id is no proposal", async () => {
			proposalId = "not-an-id";
			const error = await publish().catch((caught: unknown) => caught as Error);

			expect(error).toBeInstanceOf(NotPublishableError);
			expect(error.message).toBe("No proposal not-an-id.");
		});

		test("a second publish of the same proposal is refused", async () => {
			await publish();

			// Caught by hand rather than with `.rejects.toThrow(/accepted/)`: that form hangs
			// here until the test times out, while the same matcher with an error *class*
			// resolves fine. Not worth chasing — this reads no worse.
			const error = await publish().catch((caught: unknown) => caught as Error);

			expect(error).toBeInstanceOf(NotPublishableError);
			expect(error.message).toMatch(/accepted/);
		});

		test("the next publish of the same entity is version 2", async () => {
			await publish();

			proposalId = await proposeEdit(1, {
				de: { name: "Die Kriegsjahre, korrigiert" },
			});

			expect(await publish()).toEqual({
				entityId,
				version: 2,
				proposalIds: [proposalId],
			});
		});

		// PLAN.md §2.3, through the real query rather than a stub.
		test("refuses while the proposal links to something unpublished, and writes nothing", async () => {
			await active.sql`
				INSERT INTO link (entity_id, version, proposal_id, target_entity_id, created_by, updated_by)
				VALUES (${entityId}, NULL, ${proposalId}, ${await person(false)}, ${system}, ${system})
			`;

			const error = await publish().catch((caught: unknown) => caught as Error);

			expect(error).toBeInstanceOf(ClosureViolationError);

			const [entity] = await active.sql<{ version: number | null }[]>`
				SELECT version FROM entity WHERE id = ${entityId}
			`;
			const versions = await active.sql`
				SELECT 1 FROM entity_version WHERE entity_id = ${entityId}
			`;

			expect(entity?.version).toBeNull();
			expect(versions).toHaveLength(0);
		});

		// PLAN.md §2.4 and §11: a version snapshots all languages together, a proposal is a
		// complete state, and publishing merges it three ways — so nothing the proposer did not
		// change is lost, and nothing that landed after they started is reverted.
		describe("a version is the three-way merge of base, proposal and head", () => {
			const contentOf = (version: number) => active.sql<
				{ language: string; name: string }[]
			>`
				SELECT language, name FROM story_content
				WHERE entity_id = ${entityId} AND version = ${version} AND proposal_id IS NULL
				ORDER BY language
			`;

			const addEnglish = () => active.sql`
				INSERT INTO story_content (entity_id, version, proposal_id, language, name, search_config, created_by, updated_by)
				VALUES (${entityId}, NULL, ${proposalId}, 'en', 'The war years', 'english', ${system}, ${system})
			`;

			test("an edit keeps every language, changed or not", async () => {
				await addEnglish();
				await publish();

				proposalId = await proposeEdit(1, {
					de: { name: "Die Kriegsjahre, korrigiert" },
				});
				await publish();

				expect(await contentOf(2)).toEqual([
					{ language: "de", name: "Die Kriegsjahre, korrigiert" },
					{ language: "en", name: "The war years" },
				]);
			});

			test("a proposal that drops a published language is refused", async () => {
				await addEnglish();
				await publish();

				proposalId = await proposeEdit(1, { en: null });
				const error = await publish().catch(
					(caught: unknown) => caught as Error,
				);

				expect(error).toBeInstanceOf(IncompleteProposalError);
			});

			test("a stale proposal does not revert what was published after it was made", async () => {
				await publish();
				const stale = await proposeEdit(1, {}, "[1944-01-01,1945-01-01)");

				// Meanwhile someone else's correction to the title lands as version 2.
				proposalId = await proposeEdit(1, {
					de: { name: "Die Kriegsjahre 1939–45" },
				});
				await publish();

				proposalId = stale;
				await publish();

				const [row] = await active.sql<
					{ name: string; occurred_start: string }[]
				>`
					SELECT c.name, s.occurred_start FROM story_content c
					JOIN story s ON s.entity_id = c.entity_id AND s.version = c.version AND s.proposal_id IS NULL
					WHERE c.entity_id = ${entityId} AND c.version = 3 AND c.proposal_id IS NULL
				`;
				// Version 2's title stands; the stale proposal's date goes in.
				expect(row?.name).toBe("Die Kriegsjahre 1939–45");
				expect(row?.occurred_start).toBe("[1944-01-01,1945-01-01)");
			});

			test("two proposals changing the same thing differently conflict", async () => {
				await publish();
				const first = await proposeEdit(1, { de: { name: "Erster Titel" } });
				const second = await proposeEdit(1, { de: { name: "Zweiter Titel" } });

				const error = await publishTogether([first, second]).catch(
					(caught: unknown) => caught as Error,
				);

				expect(error).toBeInstanceOf(ConflictError);
			});

			test("two proposals changing different things become one version", async () => {
				await publish();
				const title = await proposeEdit(1, { de: { name: "Neuer Titel" } });
				const date = await proposeEdit(1, {}, "[1940-01-01,1941-01-01)");

				expect(await publishTogether([title, date])).toEqual([
					{ entityId, version: 2, proposalIds: [title, date] },
				]);
				expect((await contentOf(2))[0]?.name).toBe("Neuer Titel");
			});
		});

		// PLAN.md §2.6: the link set is exactly the chips in the bodies — derived from the
		// version as merged, never taken from the proposal's rows.
		describe("links are derived from the published bodies", () => {
			const linksOf = async (version: number) =>
				(
					await active.sql<{ target_entity_id: string }[]>`
						SELECT target_entity_id FROM link
						WHERE entity_id = ${entityId} AND version = ${version} AND proposal_id IS NULL
						ORDER BY target_entity_id
					`
				).map((row) => row.target_entity_id);

			test("a chip in a body becomes a link of the version", async () => {
				const josef = await person(true);
				await active.sql`
					UPDATE story_content SET body = ${`Mit ${chip(josef)} im Keller.`}
					WHERE proposal_id = ${proposalId}
				`;

				await publish();

				expect(await linksOf(1)).toEqual([josef]);
			});

			test("removing the chip removes the link", async () => {
				const josef = await person(true);
				await active.sql`
					UPDATE story_content SET body = ${chip(josef)} WHERE proposal_id = ${proposalId}
				`;
				await publish();

				proposalId = await proposeEdit(1, { de: { body: "Ohne ihn." } });
				await publish();

				expect(await linksOf(2)).toEqual([]);
			});

			test("a chip pointing at something unpublished blocks, even with no link row", async () => {
				await active.sql`
					UPDATE story_content SET body = ${chip(await person(false))}
					WHERE proposal_id = ${proposalId}
				`;

				const error = await publish().catch(
					(caught: unknown) => caught as Error,
				);

				expect(error).toBeInstanceOf(ClosureViolationError);
				const [spine] = await active.sql<{ version: number | null }[]>`
					SELECT version FROM entity WHERE id = ${entityId}
				`;
				expect(spine?.version).toBeNull();
			});
		});

		// PLAN.md §2.2a: the moderator sees what publishing would produce — produced for real
		// in a transaction that is rolled back, so it cannot disagree with publishing.
		describe("reviewing rehearses the publish", () => {
			const review = () =>
				reviewProposal(
					{
						findProposal: (id) => findProposal(active.db, id, moderator),
						findVersion: (id, version) =>
							findVersion(active.db, id, version, moderator),
						findPublished: (id) => findPublished(active.db, id, moderator),
						rehearse: rehearsal(active.db),
					},
					proposalId,
					moderator,
				);

			test("shows the version publishing would write, and writes nothing", async () => {
				const josef = await person(true);
				await active.sql`
					UPDATE story_content SET body = ${chip(josef)} WHERE proposal_id = ${proposalId}
				`;

				const result = await review();

				expect(result?.blocked).toBeNull();
				expect(result?.outcome?.content[0]?.name).toBe("Die Kriegsjahre");
				// Derived links included — the rehearsal ran the whole publish.
				expect(result?.outcome?.references.links).toEqual([josef]);

				const [spine] = await active.sql<{ version: number | null }[]>`
					SELECT version FROM entity WHERE id = ${entityId}
				`;
				const versions = await active.sql`
					SELECT 1 FROM entity_version WHERE entity_id = ${entityId}
				`;
				const [proposal] = await active.sql<{ status: string }[]>`
					SELECT status FROM proposal WHERE id = ${proposalId}
				`;
				expect(spine?.version).toBeNull();
				expect(versions).toHaveLength(0);
				expect(proposal?.status).toBe("pending");
			});

			test("says why publishing would refuse, rather than showing an outcome", async () => {
				await publish();
				const first = await proposeEdit(1, { de: { name: "Erster Titel" } });
				proposalId = await proposeEdit(1, { de: { name: "Zweiter Titel" } });
				await active.db.transaction(
					async (tx) =>
						await publishProposal(publishDependencies(tx), first, moderator),
				);

				const result = await review();

				expect(result?.stale).toBe(true);
				expect(result?.outcome).toBeNull();
				expect(result?.blocked?.kind).toBe("conflict");
			});
		});

		// PLAN.md §2.2: proposals are never deleted — a rejected one persists with its reason
		// and its moderator, and the contribution itself stays exactly where it was.
		describe("rejection", () => {
			const reject = (reason: string) =>
				active.db.transaction(
					async (tx) =>
						await rejectProposal(
							rejectDependencies(tx),
							proposalId,
							reason,
							moderator,
						),
				);

			test("records the reason and the moderator, and keeps the rows", async () => {
				await reject("Das Foto zeigt eine lebende Person.");

				const [row] = await active.sql<
					{ status: string; rejection_reason: string; moderator_id: string }[]
				>`
					SELECT status, rejection_reason, moderator_id FROM proposal WHERE id = ${proposalId}
				`;
				const content = await active.sql`
					SELECT 1 FROM story_content WHERE proposal_id = ${proposalId}
				`;

				expect(row?.status).toBe("rejected");
				expect(row?.rejection_reason).toBe(
					"Das Foto zeigt eine lebende Person.",
				);
				expect(row?.moderator_id).toBe(system);
				expect(content).toHaveLength(1);
			});

			test("a rejected proposal can no longer be published", async () => {
				await reject("Unbelegt.");

				const error = await publish().catch(
					(caught: unknown) => caught as Error,
				);

				expect(error).toBeInstanceOf(NotPublishableError);
			});

			test("rejecting twice leaves the first decision standing", async () => {
				await reject("Der erste Grund.");

				const error = await reject("Der zweite Grund.").catch(
					(caught: unknown) => caught as Error,
				);
				const [row] = await active.sql<{ rejection_reason: string }[]>`
					SELECT rejection_reason FROM proposal WHERE id = ${proposalId}
				`;

				expect(error).toBeInstanceOf(NotPublishableError);
				expect(row?.rejection_reason).toBe("Der erste Grund.");
			});
		});
	},
);

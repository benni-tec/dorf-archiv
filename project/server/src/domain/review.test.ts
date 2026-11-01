import { describe, expect, test } from "bun:test";
import { year } from "shared";
import { accountActor } from "./actor";
import type { ProposedEntity, PublishedEntity } from "./entity";
import { ConflictError } from "./merge";
import {
	diffSnapshots,
	MissingBaseVersionError,
	type ReviewDependencies,
	reviewProposal,
	type Snapshot,
} from "./review";

/**
 * PLAN.md §2.2a and §6: a field-level diff before publishing, what the proposer changed and
 * what publishing would actually do — the latter rehearsed rather than predicted (§11).
 */

const moderator = accountActor("mod-1", [], ["story:moderate"]);

const contentOf = (content: Record<string, string>) =>
	Object.entries(content).map(([language, name]) => ({
		language,
		name,
		abstract: null,
		body: null,
	}));

const story = (
	version: number,
	content: Record<string, string>,
	links: string[] = [],
): PublishedEntity => ({
	id: "s-1",
	type: "story",
	version,
	originalLanguage: "de",
	fields: { occurred: { start: year(1945) } },
	content: contentOf(content),
	references: { links, tags: [], citations: [] },
});

const proposalOf = (
	basedOnVersion: number | null,
	content: Record<string, string>,
): ProposedEntity => ({
	id: "s-1",
	type: "story",
	originalLanguage: "de",
	proposalId: "p-1",
	status: "pending",
	basedOnVersion,
	proposedBy: "u-1",
	fields: { occurred: { start: year(1945) } },
	content: contentOf(content),
	references: { links: [], tags: [], citations: [] },
});

const snapshot = (
	content: Record<string, string>,
	links: string[] = [],
	fields: Record<string, unknown> = { occurred: { start: year(1945) } },
): Snapshot => ({
	fields,
	content: contentOf(content),
	references: { links, tags: [], citations: [] },
});

describe("diffSnapshots", () => {
	test("reports changed fields, and only those", () => {
		const before = snapshot({ de: "A" });
		const after = snapshot({ de: "A" }, [], {
			occurred: { start: year(1946) },
		});

		expect(diffSnapshots(before, after).fields).toEqual([
			{
				field: "occurred",
				before: { start: year(1945) },
				after: { start: year(1946) },
			},
		]);
		expect(diffSnapshots(before, before).fields).toEqual([]);
	});

	test("reports languages added, removed and changed", () => {
		const diff = diffSnapshots(
			snapshot({ de: "Alt", fr: "Vieux" }),
			snapshot({ de: "Neu", en: "New" }),
		);

		expect(diff.content).toEqual([
			{
				language: "de",
				kind: "changed",
				changes: [{ field: "name", before: "Alt", after: "Neu" }],
			},
			{
				language: "en",
				kind: "added",
				changes: [{ field: "name", before: null, after: "New" }],
			},
			{
				language: "fr",
				kind: "removed",
				changes: [{ field: "name", before: "Vieux", after: null }],
			},
		]);
	});

	test("reports references gained and lost", () => {
		const diff = diffSnapshots(
			snapshot({ de: "x" }, ["a", "b"]),
			snapshot({ de: "x" }, ["b", "c"]),
		);
		expect(diff.links).toEqual({ added: ["c"], removed: ["a"] });
	});
});

describe("reviewProposal", () => {
	/**
	 * Review dependencies over a list of versions, where the rehearsal "publishes" by
	 * returning `outcome` — or throws `refusal`, as publishing would.
	 */
	const deps = (
		proposal: ProposedEntity | null,
		versions: PublishedEntity[],
		outcome: PublishedEntity | null = null,
		refusal: Error | null = null,
	): ReviewDependencies => ({
		findProposal: async () => proposal,
		findVersion: async (_, version) =>
			versions.find((entry) => entry.version === version) ?? null,
		findPublished: async () => versions.at(-1) ?? null,
		// Stands in for the publish itself; the real rehearsal is covered against a database.
		rehearse: async () => {
			if (refusal) throw refusal;
			return outcome as never;
		},
	});

	// §6: "nothing for a create proposal".
	test("a create has no change diff, and is not stale while nothing is published", async () => {
		const review = await reviewProposal(
			deps(proposalOf(null, { de: "Neu" }), [], story(1, { de: "Neu" })),
			"p-1",
			moderator,
		);

		expect(review?.isCreate).toBe(true);
		expect(review?.changes).toBeNull();
		expect(review?.stale).toBe(false);
		expect(review?.againstHead).toBeNull();
		expect(review?.outcome?.content[0]?.name).toBe("Neu");
		expect(review?.blocked).toBeNull();
	});

	test("an edit shows what the proposer changed against their base", async () => {
		const review = await reviewProposal(
			deps(
				proposalOf(1, { de: "Neu" }),
				[story(1, { de: "Alt" })],
				story(2, { de: "Neu" }),
			),
			"p-1",
			moderator,
		);

		expect(review?.stale).toBe(false);
		expect(review?.changes?.content).toEqual([
			{
				language: "de",
				kind: "changed",
				changes: [{ field: "name", before: "Alt", after: "Neu" }],
			},
		]);
		expect(review?.againstHead).toBeNull();
	});

	// The proposer changed only the German; version 2 meanwhile fixed the English. The
	// change diff shows the German alone, and the head diff shows what publishing really
	// does to the live version — which, merged, keeps the fixed English.
	test("a stale edit shows both what was proposed and what publishing would do", async () => {
		const review = await reviewProposal(
			deps(
				proposalOf(1, { de: "Neu", en: "Typo" }),
				[
					story(1, { de: "Alt", en: "Typo" }),
					story(2, { de: "Alt", en: "Fixed" }),
				],
				story(3, { de: "Neu", en: "Fixed" }),
			),
			"p-1",
			moderator,
		);

		expect(review?.stale).toBe(true);
		expect(review?.changes?.content.map((change) => change.language)).toEqual([
			"de",
		]);
		expect(review?.againstHead?.content).toEqual([
			{
				language: "de",
				kind: "changed",
				changes: [{ field: "name", before: "Alt", after: "Neu" }],
			},
		]);
	});

	test("a proposal publishing would refuse says why instead of showing an outcome", async () => {
		const conflict = new ConflictError([
			{ key: "de", kind: "language", proposalId: "p-1" },
		]);
		const review = await reviewProposal(
			deps(
				proposalOf(1, { de: "Neu" }),
				[story(1, { de: "Alt" }), story(2, { de: "Anders" })],
				null,
				conflict,
			),
			"p-1",
			moderator,
		);

		expect(review?.outcome).toBeNull();
		expect(review?.blocked).toEqual({
			kind: "conflict",
			conflicts: conflict.conflicts,
		});
		// What the proposer changed is still worth showing — it is what needs deciding.
		expect(review?.changes).not.toBeNull();
	});

	test("a create whose entity was published meanwhile is stale", async () => {
		const review = await reviewProposal(
			deps(
				proposalOf(null, { de: "Neu" }),
				[story(1, { de: "Schon da" })],
				story(2, { de: "Neu" }),
			),
			"p-1",
			moderator,
		);

		expect(review?.stale).toBe(true);
		expect(review?.againstHead).not.toBeNull();
	});

	// The author can read their own proposal, but a review shows the full base version — a
	// moderator's tool, and content the author may not be allowed to view (§4.4).
	test("nothing to see for anyone who does not moderate the type, its author included", async () => {
		const review = deps(
			proposalOf(1, { de: "Neu" }),
			[story(1, { de: "Alt" })],
			story(2, { de: "Neu" }),
		);
		expect(
			await reviewProposal(review, "p-1", accountActor("u-1", [], [])),
		).toBeNull();
		expect(
			await reviewProposal(
				review,
				"p-1",
				accountActor("mod-2", [], ["place:moderate"]),
			),
		).toBeNull();
	});

	test("nothing to see when the proposal is not visible", async () => {
		expect(await reviewProposal(deps(null, []), "p-1", moderator)).toBeNull();
	});

	test("refuses to diff against a base that cannot be read", async () => {
		const error = await reviewProposal(
			deps(proposalOf(3, { de: "x" }), [story(1, { de: "y" })]),
			"p-1",
			moderator,
		).catch((caught) => caught as Error);
		expect(error).toBeInstanceOf(MissingBaseVersionError);
	});

	test("an unexpected failure in the rehearsal is not dressed up as a refusal", async () => {
		const review = deps(proposalOf(1, { de: "x" }), [story(1, { de: "y" })]);
		review.rehearse = async () => {
			throw new TypeError("database went away");
		};

		const error = await reviewProposal(review, "p-1", moderator).catch(
			(caught) => caught as Error,
		);
		expect(error).toBeInstanceOf(TypeError);
	});
});

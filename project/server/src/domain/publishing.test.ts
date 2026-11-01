import { describe, expect, test } from "bun:test";
import { accountActor } from "./actor";
import {
	ConflictError,
	IncompleteProposalError,
	type Merged,
	type Part,
	type State,
} from "./merge";
import {
	type BlockingReference,
	ClosureViolationError,
	NotPublishableError,
	type ProposalSummary,
	type PublishDependencies,
	publishAll,
	publishProposal,
} from "./publishing";

/**
 * PLAN.md §2.2, §2.3 and §11. A version is a published state, created **at publish time,
 * never at proposal time**; a proposal is a complete state, merged three ways against its
 * base and the head; and nothing may be published while it references something
 * unpublished.
 *
 * The service takes its dependencies as arguments, so the rules can be tested without a
 * database — and so a background job or an import path can reuse them (§5.1).
 */

const moderator = accountActor("mod-1", [], ["story:moderate"]);

const own = (value: string): Part => ({ kind: "own", value });
const language = (value: string): Part => ({ kind: "language", value });
const state = (entries: Record<string, Part>): State =>
	new Map(Object.entries(entries));

const v1 = state({ story: own("1940"), de: language("Erste Fassung") });

type Proposal = ProposalSummary & { state: State; refs?: string[] };

/**
 * A small archive: entities with published versions, proposals, and a record of what was
 * written. A reference blocks while its target has no published head.
 */
const world = (
	proposals: Proposal[],
	versions: Record<string, State[]> = {},
) => {
	const heads = new Map(
		Object.entries(versions).map(([id, list]) => [id, list.length]),
	);
	const calls: string[] = [];
	const written = new Map<string, Merged>();

	const blockingFor = (refs: string[]): BlockingReference[] =>
		refs
			.filter((target) => !heads.has(target))
			.map((target) => ({
				referenceTable: "link",
				referenceColumn: "target_entity_id",
				targetEntityId: target,
				targetType: "place",
			}));

	const deps: PublishDependencies = {
		loadProposal: async (id) => {
			const found = proposals.find((proposal) => proposal.id === id);
			return found
				? {
						id: found.id,
						entityId: found.entityId,
						type: found.type,
						status: found.status,
						basedOnVersion: found.basedOnVersion,
					}
				: null;
		},
		findUnpublishedReferences: async (id) => ({
			blocking: blockingFor(
				proposals.find((proposal) => proposal.id === id)?.refs ?? [],
			),
			tablesSearched: ["link"],
		}),
		findUnpublishedInVersion: async (entityId) => ({
			blocking: blockingFor(
				proposals
					.filter((proposal) => proposal.entityId === entityId)
					.flatMap((proposal) => proposal.refs ?? []),
			),
			tablesSearched: ["link"],
		}),
		lockHead: async (entityId) => heads.get(entityId) ?? null,
		loadState: async (entityId, origin) => {
			if (origin.kind === "proposal") {
				return (
					proposals.find((proposal) => proposal.id === origin.proposalId)
						?.state ?? new Map()
				);
			}
			return versions[entityId]?.[origin.version - 1] ?? new Map();
		},
		nextVersion: async (entityId) => (heads.get(entityId) ?? 0) + 1,
		recordVersion: async (entityId, version) => {
			calls.push(`record ${entityId} v${version}`);
		},
		writeVersion: async (entityId, version, merged) => {
			calls.push(`write ${entityId} v${version}`);
			written.set(entityId, merged);
		},
		deriveLinks: async (entityId, version) => {
			calls.push(`links ${entityId} v${version}`);
		},
		markIncorporated: async (proposalId, version) => {
			calls.push(`incorporated ${proposalId} v${version}`);
		},
		markAccepted: async (proposalId) => {
			calls.push(`accepted ${proposalId}`);
		},
		setPublishedHead: async (entityId, version) => {
			calls.push(`head ${entityId} v${version}`);
			heads.set(entityId, version);
		},
	};

	return { deps, calls, written };
};

const pending = (
	id: string,
	entityId: string,
	basedOnVersion: number | null,
	proposed: State,
	refs: string[] = [],
): Proposal => ({
	id,
	entityId,
	type: "story",
	status: "pending",
	basedOnVersion,
	state: proposed,
	refs,
});

/** Where each part of what was written came from. */
const sources = (merged: Merged | undefined) =>
	Object.fromEntries(
		[...(merged ?? [])].map(([key, { origin }]) => [
			key,
			origin.kind === "version" ? `v${origin.version}` : origin.proposalId,
		]),
	);

describe("publishProposal", () => {
	const edit = pending(
		"p-1",
		"e-1",
		1,
		state({ story: own("1940"), de: language("Zweite Fassung") }),
	);

	test("returns the version it created and the proposal that made it", async () => {
		const { deps } = world([edit], { "e-1": [v1] });

		expect(await publishProposal(deps, "p-1", moderator)).toEqual({
			entityId: "e-1",
			version: 2,
			proposalIds: ["p-1"],
		});
	});

	test("records the version, writes it, derives its links, accepts and moves the head", async () => {
		const { calls, deps } = world([edit], { "e-1": [v1] });

		await publishProposal(deps, "p-1", moderator);

		// The set, not the sequence: only one ordering actually matters, and the test below
		// states it. Pinning all of them here would be testing the implementation.
		expect(calls.toSorted()).toEqual(
			[
				"record e-1 v2",
				"write e-1 v2",
				"links e-1 v2",
				"incorporated p-1 v2",
				"accepted p-1",
				"head e-1 v2",
			].toSorted(),
		);
	});

	// §4.6 #6: the head is what a read path may take as evidence that content is public. It
	// must move last — after the rows it points at exist.
	test("moves the head only after the content and its links are there", async () => {
		const { calls, deps } = world([edit], { "e-1": [v1] });

		await publishProposal(deps, "p-1", moderator);

		expect(calls.indexOf("head e-1 v2")).toBeGreaterThan(
			calls.indexOf("links e-1 v2"),
		);
		expect(calls.indexOf("links e-1 v2")).toBeGreaterThan(
			calls.indexOf("write e-1 v2"),
		);
	});

	test("writes the merge: changed parts from the proposal, the rest from the head", async () => {
		const { deps, written } = world([edit], { "e-1": [v1] });

		await publishProposal(deps, "p-1", moderator);

		expect(sources(written.get("e-1"))).toEqual({ story: "v1", de: "p-1" });
	});

	test("a stale proposal keeps what landed after it was made", async () => {
		const v2 = state({ story: own("1945"), de: language("Erste Fassung") });
		const stale = pending(
			"p-1",
			"e-1",
			1,
			state({ story: own("1940"), de: language("Zweite Fassung") }),
		);
		const { deps, written } = world([stale], { "e-1": [v1, v2] });

		await publishProposal(deps, "p-1", moderator);

		// v2's date survives; the proposal's German goes in.
		expect(sources(written.get("e-1"))).toEqual({ story: "v2", de: "p-1" });
	});

	describe("the closure invariant", () => {
		test("refuses while a reference points at something unpublished, writing nothing", async () => {
			const { calls, deps } = world(
				[pending("p-1", "e-1", 1, edit.state, ["person-9"])],
				{ "e-1": [v1] },
			);

			const error = await publishProposal(deps, "p-1", moderator).catch(
				(caught) => caught as ClosureViolationError,
			);

			expect(error).toBeInstanceOf(ClosureViolationError);
			// The moderation queue lists the dependencies with inline publish/remove, so the
			// error carries them rather than just saying no.
			expect(error.blocking.map((item) => item.targetEntityId)).toEqual([
				"person-9",
			]);
			expect(calls).toEqual([]);
		});

		test("is checked on the version written too, and the head never moves to it", async () => {
			const { calls, deps } = world([edit], { "e-1": [v1] });
			deps.findUnpublishedInVersion = async () => ({
				blocking: [
					{
						referenceTable: "link",
						referenceColumn: "target_entity_id",
						targetEntityId: "person-9",
						targetType: "person",
					},
				],
				tablesSearched: ["link"],
			});

			const error = await publishProposal(deps, "p-1", moderator).catch(
				(caught) => caught as Error,
			);

			expect(error).toBeInstanceOf(ClosureViolationError);
			expect(calls.some((call) => call.startsWith("head"))).toBe(false);
		});
	});

	describe("what cannot be published", () => {
		test.each(["accepted", "rejected"] as const)(
			"a proposal that was %s",
			async (status) => {
				const { deps } = world([{ ...edit, status }], { "e-1": [v1] });

				expect(
					await publishProposal(deps, "p-1", moderator).catch(
						(caught) => caught,
					),
				).toBeInstanceOf(NotPublishableError);
			},
		);

		// §4.4: the route cannot know a proposal's type from its id, so the check that
		// counts is here — and refusing reads exactly like a proposal that is not there.
		test("a proposal of a type the actor does not moderate", async () => {
			const { calls, deps } = world([edit], { "e-1": [v1] });
			const placeModerator = accountActor("mod-2", [], ["place:moderate"]);

			const error = await publishProposal(deps, "p-1", placeModerator).catch(
				(caught) => caught as Error,
			);

			expect(error).toBeInstanceOf(NotPublishableError);
			expect(error.message).toBe("No proposal p-1.");
			expect(calls).toEqual([]);
		});

		test("a proposal that does not exist", async () => {
			const { deps } = world([]);

			expect(
				await publishProposal(deps, "p-1", moderator).catch((caught) => caught),
			).toBeInstanceOf(NotPublishableError);
		});

		test("a proposal that drops a published language", async () => {
			const { calls, deps } = world(
				[pending("p-1", "e-1", 1, state({ story: own("1940") }))],
				{ "e-1": [v1] },
			);

			expect(
				await publishProposal(deps, "p-1", moderator).catch((caught) => caught),
			).toBeInstanceOf(IncompleteProposalError);
			expect(calls).toEqual([]);
		});

		test("a proposal that changes nothing — it should be rejected instead", async () => {
			const { deps } = world([pending("p-1", "e-1", 1, v1)], { "e-1": [v1] });

			expect(
				await publishProposal(deps, "p-1", moderator).catch((caught) => caught),
			).toBeInstanceOf(NotPublishableError);
		});

		test("a stale proposal changing what the head changed differently", async () => {
			const v2 = state({ story: own("1945"), de: language("Erste Fassung") });
			const { calls, deps } = world(
				[
					pending(
						"p-1",
						"e-1",
						1,
						state({ story: own("1950"), de: language("Erste Fassung") }),
					),
				],
				{ "e-1": [v1, v2] },
			);

			expect(
				await publishProposal(deps, "p-1", moderator).catch((caught) => caught),
			).toBeInstanceOf(ConflictError);
			expect(calls).toEqual([]);
		});
	});
});

/**
 * §2.3's "publish all": the closure invariant checked for the set, so a photo and its new
 * Place go out together — and so do two new entities that mention each other.
 */
describe("publishAll", () => {
	const created = (id: string, entityId: string, refs: string[] = []) =>
		pending(
			id,
			entityId,
			null,
			state({ [entityId]: own(id), de: language(id) }),
			refs,
		);

	test("a photo goes out together with its new Place", async () => {
		const { deps } = world([
			created("photo", "media-1", ["place-1"]),
			created("place", "place-1"),
		]);

		const results = await publishAll(deps, ["photo", "place"], moderator);

		expect(results.map((result) => result.entityId).sort()).toEqual([
			"media-1",
			"place-1",
		]);
	});

	// Impossible one at a time: each would block the other forever.
	test("two new entities that reference each other publish together", async () => {
		const { deps } = world([
			created("a", "e-a", ["e-b"]),
			created("b", "e-b", ["e-a"]),
		]);

		expect(await publishAll(deps, ["a", "b"], moderator)).toHaveLength(2);
	});

	test("a reference outside the set still blocks, and nothing is published", async () => {
		const { calls, deps } = world([
			created("photo", "media-1", ["place-1", "person-9"]),
			created("place", "place-1"),
		]);

		const error = await publishAll(deps, ["photo", "place"], moderator).catch(
			(caught) => caught as ClosureViolationError,
		);

		expect(error).toBeInstanceOf(ClosureViolationError);
		expect(error.blocking.map((item) => item.targetEntityId)).toEqual([
			"person-9",
		]);
		expect(calls).toEqual([]);
	});

	// §2.2a: moderators combine several proposals into one version.
	test("two proposals for one entity become one version when they touch different parts", async () => {
		const withEnglish = state({
			...Object.fromEntries(v1),
			en: language("First"),
		});
		const withDate = state({ ...Object.fromEntries(v1), story: own("1941") });
		const { deps, written } = world(
			[
				pending("p-1", "e-1", 1, withEnglish),
				pending("p-2", "e-1", 1, withDate),
			],
			{ "e-1": [v1] },
		);

		const results = await publishAll(deps, ["p-2", "p-1"], moderator);

		expect(results).toEqual([
			{ entityId: "e-1", version: 2, proposalIds: ["p-1", "p-2"] },
		]);
		expect(sources(written.get("e-1"))).toEqual({
			story: "p-2",
			de: "v1",
			en: "p-1",
		});
	});

	test("two proposals for one entity that conflict publish neither", async () => {
		const { calls, deps } = world(
			[
				pending(
					"p-1",
					"e-1",
					1,
					state({ ...Object.fromEntries(v1), story: own("1941") }),
				),
				pending(
					"p-2",
					"e-1",
					1,
					state({ ...Object.fromEntries(v1), story: own("1942") }),
				),
			],
			{ "e-1": [v1] },
		);

		const error = await publishAll(deps, ["p-1", "p-2"], moderator).catch(
			(caught) => caught as ConflictError,
		);

		expect(error).toBeInstanceOf(ConflictError);
		expect(error.conflicts).toEqual([
			{ key: "story", kind: "own", proposalId: "p-2" },
		]);
		expect(calls).toEqual([]);
	});

	test("refuses a set containing a proposal that does not exist", async () => {
		const { calls, deps } = world([created("one", "e-1")]);

		const error = await publishAll(deps, ["one", "ghost"], moderator).catch(
			(caught) => caught as Error,
		);

		expect(error).toBeInstanceOf(NotPublishableError);
		expect(calls).toEqual([]);
	});
});

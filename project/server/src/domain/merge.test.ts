import { describe, expect, test } from "bun:test";
import {
	assertComplete,
	ConflictError,
	changesAnything,
	EMPTY,
	fromVersion,
	IncompleteProposalError,
	type Merged,
	mergeProposal,
	type Part,
	type State,
} from "./merge";

const own = (value: string): Part => ({ kind: "own", value });
const language = (value: string): Part => ({ kind: "language", value });
const member = (value = "{}"): Part => ({ kind: "member", value });

const state = (entries: Record<string, Part>): State =>
	new Map(Object.entries(entries));

/** What a merged state holds and where each part came from, for compact assertions. */
const summary = (merged: Merged) =>
	Object.fromEntries(
		[...merged].map(([key, { part, origin }]) => [
			key,
			`${part.value} ← ${origin.kind === "version" ? `v${origin.version}` : origin.proposalId}`,
		]),
	);

// The running example of PLAN.md §11: a photo at version 3.
const v3 = state({
	media: own("captured 1952"),
	"content:de": language("caption A"),
	"content:en": language("caption B"),
	"tag:feuerwehr": member(),
});

describe("mergeProposal", () => {
	test("a proposal on the head takes exactly what it changed", () => {
		const anna = state({
			media: own("captured 1952"),
			"content:de": language("caption A′"),
			"content:en": language("caption B"),
			"tag:feuerwehr": member(),
		});

		const merged = mergeProposal(v3, fromVersion(v3, 3), anna, "anna");

		expect(summary(merged)).toEqual({
			media: "captured 1952 ← v3",
			"content:de": "caption A′ ← anna",
			"content:en": "caption B ← v3",
			"tag:feuerwehr": "{} ← v3",
		});
	});

	test("a stale proposal does not revert what landed in between", () => {
		// Anna's caption fix was published as v4. Bernd, working from v3, adds names as tags —
		// and his complete state still carries v3's caption, which he never touched.
		const v4 = fromVersion(
			state({
				...Object.fromEntries(v3),
				"content:de": language("caption A′"),
			}),
			4,
		);
		const bernd = state({
			...Object.fromEntries(v3),
			"tag:josef": member(),
			"tag:hans": member(),
		});

		const merged = mergeProposal(v3, v4, bernd, "bernd");

		expect(summary(merged)).toEqual({
			media: "captured 1952 ← v4",
			"content:de": "caption A′ ← v4",
			"content:en": "caption B ← v4",
			"tag:feuerwehr": "{} ← v4",
			"tag:hans": "{} ← bernd",
			"tag:josef": "{} ← bernd",
		});
	});

	test("proposals touching different parts combine into one version", () => {
		const anna = state({
			...Object.fromEntries(v3),
			"content:de": language("caption A′"),
		});
		const bernd = state({ ...Object.fromEntries(v3), "tag:josef": member() });

		const withAnna = mergeProposal(v3, fromVersion(v3, 3), anna, "anna");
		const both = mergeProposal(v3, withAnna, bernd, "bernd");

		expect(summary(both)["content:de"]).toBe("caption A′ ← anna");
		expect(summary(both)["tag:josef"]).toBe("{} ← bernd");
	});

	test("two proposals adding different tags keep both", () => {
		const anna = state({ ...Object.fromEntries(v3), "tag:josef": member() });
		const bernd = state({ ...Object.fromEntries(v3), "tag:hans": member() });

		const both = mergeProposal(
			v3,
			mergeProposal(v3, fromVersion(v3, 3), anna, "anna"),
			bernd,
			"bernd",
		);

		expect(
			[...both.keys()].filter((key) => key.startsWith("tag:")).sort(),
		).toEqual(["tag:feuerwehr", "tag:hans", "tag:josef"]);
	});

	test("removing a member removes it", () => {
		const { "tag:feuerwehr": _, ...rest } = Object.fromEntries(v3);
		const merged = mergeProposal(v3, fromVersion(v3, 3), state(rest), "p");

		expect(merged.has("tag:feuerwehr")).toBe(false);
	});

	test("a member someone else added meanwhile is not removed by a proposal that never saw it", () => {
		const v4 = fromVersion(
			state({ ...Object.fromEntries(v3), "tag:josef": member() }),
			4,
		);
		const stale = state({
			...Object.fromEntries(v3),
			"content:en": language("caption B′"),
		});

		const merged = mergeProposal(v3, v4, stale, "p");

		expect(merged.has("tag:josef")).toBe(true);
	});

	test("both changing a part the same way is agreement, not a conflict", () => {
		const v4 = fromVersion(
			state({ ...Object.fromEntries(v3), "content:de": language("fixed") }),
			4,
		);
		const same = state({
			...Object.fromEntries(v3),
			"content:de": language("fixed"),
		});

		expect(summary(mergeProposal(v3, v4, same, "p"))["content:de"]).toBe(
			"fixed ← v4",
		);
	});

	test("both changing a part differently is a conflict naming every such part", () => {
		const v4 = fromVersion(
			state({
				...Object.fromEntries(v3),
				media: own("captured 1953"),
				"content:de": language("one fix"),
			}),
			4,
		);
		const other = state({
			...Object.fromEntries(v3),
			media: own("captured 1951"),
			"content:de": language("another fix"),
		});

		const error = (() => {
			try {
				mergeProposal(v3, v4, other, "p");
			} catch (caught) {
				return caught;
			}
		})();

		expect(error).toBeInstanceOf(ConflictError);
		expect((error as ConflictError).conflicts.map((item) => item.key)).toEqual([
			"content:de",
			"media",
		]);
	});

	test("one side removing what the other changed is a conflict too", () => {
		const v4 = fromVersion(
			state({ ...Object.fromEntries(v3), "tag:feuerwehr": member("primary") }),
			4,
		);
		const { "tag:feuerwehr": _, ...removed } = Object.fromEntries(v3);

		expect(() => mergeProposal(v3, v4, state(removed), "p")).toThrow(
			ConflictError,
		);
	});

	test("a create merges into nothing and takes everything", () => {
		const created = state({ media: own("x"), "content:de": language("y") });

		expect(summary(mergeProposal(EMPTY, new Map(), created, "p"))).toEqual({
			media: "x ← p",
			"content:de": "y ← p",
		});
	});
});

describe("assertComplete", () => {
	test("a proposal may not drop a published language", () => {
		const { "content:en": _, ...withoutEnglish } = Object.fromEntries(v3);

		expect(() => assertComplete("p", v3, state(withoutEnglish))).toThrow(
			IncompleteProposalError,
		);
	});

	test("nor the entity's own row", () => {
		const { media: _, ...withoutOwn } = Object.fromEntries(v3);

		expect(() => assertComplete("p", v3, state(withoutOwn))).toThrow(
			IncompleteProposalError,
		);
	});

	test("a create needs its own row too", () => {
		expect(() =>
			assertComplete("p", EMPTY, state({ "content:de": language("x") })),
		).toThrow(IncompleteProposalError);
	});

	test("dropping members is an edit, not an omission", () => {
		const { "tag:feuerwehr": _, ...withoutTag } = Object.fromEntries(v3);

		expect(() => assertComplete("p", v3, state(withoutTag))).not.toThrow();
	});

	test("adding a language is fine", () => {
		expect(() =>
			assertComplete(
				"p",
				v3,
				state({ ...Object.fromEntries(v3), "content:fr": language("légende") }),
			),
		).not.toThrow();
	});
});

describe("changesAnything", () => {
	test("a merge that changed nothing is noticed", () => {
		const head = fromVersion(v3, 3);
		expect(changesAnything(mergeProposal(v3, head, v3, "p"), head)).toBe(false);
	});

	test("a merge that changed something is noticed", () => {
		const head = fromVersion(v3, 3);
		const edited = state({ ...Object.fromEntries(v3), "tag:josef": member() });
		expect(changesAnything(mergeProposal(v3, head, edited, "p"), head)).toBe(
			true,
		);
	});
});

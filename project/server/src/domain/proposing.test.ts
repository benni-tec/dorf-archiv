import { describe, expect, test } from "bun:test";
import { chip, year } from "shared";
import { AnonymousActorError, accountActor, anonymousActor } from "./actor";
import type { Draft, DraftOf } from "./entity";
import {
	checkDraft,
	DraftError,
	editProposal,
	ProposalNotEditableError,
	type ProposalRecord,
	type ProposeDependencies,
	propose,
} from "./proposing";

/**
 * PLAN.md §2.2, §2.6, §11: a proposal is a complete state, written whole; its bodies are
 * stored canonical; its chips, tags, citations and people point at what they claim to.
 */

const josef = "0190a8e2-7a3b-7c4d-8e5f-0123456789ab";
const kirche = "0190a8e2-7a3b-7c4d-8e5f-ba9876543210";
const feuerwehr = "0190a8e2-7a3b-7c4d-8e5f-aaaaaaaaaaaa";
const chronik = "0190a8e2-7a3b-7c4d-8e5f-bbbbbbbbbbbb";
/** An upload of the proposer's own, and one of somebody else's. */
const mine = "0190a8e2-7a3b-7c4d-8e5f-111111111111";
const theirs = "0190a8e2-7a3b-7c4d-8e5f-222222222222";

const anna = accountActor("anna", [], ["story:propose"]);
const bernd = accountActor("bernd", [], ["story:propose"]);
const moderator = accountActor("mod", [], ["story:moderate"]);

const story = (
	content: Partial<DraftOf<"story">["content"][number]>[] = [{}],
	extra: Partial<DraftOf<"story">> = {},
): Draft => ({
	type: "story",
	fields: { occurred: { start: year(1945) } },
	content: content.map((row) => ({
		language: "de",
		name: "Die Kriegsjahre",
		abstract: null,
		body: null,
		...row,
	})),
	tags: [],
	citations: [],
	...extra,
});

const paths = (draft: Draft) =>
	checkDraft(draft).problems.map((problem) => problem.path);

describe("checkDraft", () => {
	test("stores bodies in canonical form", () => {
		const { draft } = checkDraft(
			story([{ body: "__fett__ und\n\n* eins\n* zwei\n\n" }]),
		);

		expect(
			draft.content[0] && "body" in draft.content[0] && draft.content[0].body,
		).toBe("**fett** und\n\n- eins\n- zwei");
	});

	test("an empty body is no body", () => {
		const { draft } = checkDraft(story([{ body: "   \n" }]));
		expect(
			draft.content[0] && "body" in draft.content[0] && draft.content[0].body,
		).toBeNull();
	});

	test("prose is text or nothing — anything else would skip the chip checks", () => {
		expect(paths(story([{ body: { chip: josef } as never }]))).toEqual([
			"content.de.body",
		]);
	});

	test("trims the name, and needs one", () => {
		expect(paths(story([{ name: "  " }]))).toEqual(["content.de.name"]);
	});

	test("refuses a chip that is not exactly :entity{#<uuid>}, wherever it is", () => {
		expect(
			paths(
				story([{ abstract: ":entity[Josef]{#x}", body: ":entity{#josef}" }]),
			),
		).toEqual(["content.de.abstract", "content.de.body"]);
	});

	test("a chip is refused with what was typed, not its stored form", () => {
		const { problems } = checkDraft(
			story([{ body: `:entity[Josef Huber]{#${josef}}` }]),
		);
		// Canonicalising would quietly drop the label and keep a valid chip; refusing says
		// why, and the contributor removes the label themselves (§4.6 #4).
		expect(problems).toEqual([
			{
				path: "content.de.body",
				message: `:entity[Josef Huber]{#${josef}} is not a valid chip (label)`,
			},
		]);
	});

	test("text that only looks like a chip stays text and references nothing", () => {
		const { draft, problems, references } = checkDraft(
			story([{ body: `So schreibt man es: \\:entity{#${josef}}` }]),
		);
		expect(problems).toEqual([]);
		expect(references).toEqual([]);
		expect(
			draft.content[0] && "body" in draft.content[0] && draft.content[0].body,
		).toContain("\\:entity");
	});

	test("a citation appears once — the same source and locator twice says nothing more", () => {
		expect(
			paths(
				story([{}], {
					citations: [
						{ sourceEntityId: chronik, locator: "S. 12" },
						{ sourceEntityId: chronik, locator: "S. 12" },
					],
				}),
			),
		).toEqual(["citations"]);
		expect(
			paths(
				story([{}], {
					citations: [
						{ sourceEntityId: chronik, locator: "S. 12" },
						{ sourceEntityId: chronik, locator: "S. 13" },
					],
				}),
			),
		).toEqual([]);
	});

	test("collects every chip as something that must be a linkable entry", () => {
		const { references } = checkDraft(
			story([{ body: `${chip(josef)} vor der ${chip(kirche)}` }]),
		);
		expect(references).toEqual([
			{ id: josef, must: "linkable", path: "content.de.body" },
			{ id: kirche, must: "linkable", path: "content.de.body" },
		]);
	});

	test("a tag cannot reference other entries — it has no links (§2.1)", () => {
		const draft: Draft = {
			type: "tag",
			fields: {},
			content: [{ language: "de", name: "Feuerwehr", abstract: chip(josef) }],
			tags: [],
			citations: [],
		};
		expect(paths(draft)).toEqual(["content.de.abstract"]);
	});

	test("languages must be language tags, and each appears once", () => {
		expect(paths(story([{ language: "Deutsch" }]))).toEqual([
			"content.Deutsch",
		]);
		expect(paths(story([{}, {}]))).toEqual(["content.de"]);
		expect(paths(story([]))).toEqual(["content"]);
	});

	test("tags point at tags, citations at sources", () => {
		const { references } = checkDraft(
			story([{}], {
				tags: [feuerwehr],
				citations: [{ sourceEntityId: chronik, locator: "S. 12" }],
			}),
		);
		expect(references).toEqual([
			{ id: feuerwehr, must: "tag", path: "tags.0" },
			{ id: chronik, must: "source", path: "citations.0" },
		]);
	});

	test("a draft that is not of any kind of entry is refused, not guessed at", () => {
		expect(paths({ ...story(), type: "letter" } as never)).toEqual(["type"]);
	});

	test("a name that is not text is refused rather than thrown on", () => {
		expect(paths(story([{ name: 42 as never }]))).toEqual(["content.de.name"]);
	});

	test("files carry an id, a known role and a position", () => {
		const draft = {
			type: "media",
			fields: { captured: null, point: null },
			content: [
				{
					language: "de",
					name: "Foto",
					abstract: null,
					description: null,
					caption: null,
				},
			],
			tags: [],
			citations: [],
			files: [
				{ assetId: "x", role: "poster", isPrimary: true, sortOrder: 0.5 },
			],
		} as never as Draft;
		expect(paths(draft)).toEqual([
			"files.0",
			"files.0.role",
			"files.0.sortOrder",
		]);
	});

	test("a relationship is between two different people", () => {
		const draft: Draft = {
			type: "relationship",
			fields: {
				kind: "married",
				directed: false,
				personA: josef,
				personB: josef,
				start: null,
				end: null,
			},
			content: [
				{ language: "de", name: "Ehe", abstract: null, description: null },
			],
			tags: [],
			citations: [],
		};
		expect(paths(draft)).toEqual(["fields.personB"]);
	});
});

/** An archive of entity types by id, a published head per entity, and what got written. */
const archive = (proposals: Record<string, ProposalRecord> = {}) => {
	const types = new Map<string, string>([
		[josef, "person"],
		[kirche, "place"],
		[feuerwehr, "tag"],
		[chronik, "source"],
		["story-1", "story"],
	]);
	const written: { proposalId: string; draft: Draft; authorId: string }[] = [];
	/** Who was asked about, for references and for assets. */
	const askedFor: string[][] = [];
	const rebased: { proposalId: string; version: number }[] = [];

	const deps: ProposeDependencies = {
		findEntity: async (id) =>
			id === "story-1" ? { type: "story", head: 2 } : null,
		languagesOf: async () => ["de", "en"],
		referenceable: async (ids, accounts) => {
			askedFor.push([...accounts]);
			return new Map(
				ids.flatMap((id) => {
					const type = types.get(id);
					return type ? [[id, type] as const] : [];
				}),
			);
		},
		usableAssets: async (ids) => new Set(ids.filter((id) => id === mine)),
		createEntity: async () => "new-entity",
		createProposal: async () => "new-proposal",
		loadProposal: async (id) => proposals[id] ?? null,
		writeDraft: async (_, proposalId, draft, authorId) => {
			written.push({ proposalId, draft, authorId });
		},
		rebase: async (proposalId, version) => {
			rebased.push({ proposalId, version });
		},
	};
	return { deps, written, rebased, askedFor };
};

const refusal = async (promise: Promise<unknown>) =>
	(await promise.catch((caught) => caught)) as DraftError;

describe("propose", () => {
	test("a create makes the entity and its proposal and writes the draft", async () => {
		const { deps, written } = archive();

		const result = await propose(
			deps,
			{ kind: "create", originalLanguage: "de", draft: story() },
			anna,
		);

		expect(result).toEqual({
			proposalId: "new-proposal",
			entityId: "new-entity",
		});
		expect(written).toHaveLength(1);
	});

	test("the original language must be one the draft has", async () => {
		const { deps, written } = archive();

		const error = await refusal(
			propose(
				deps,
				{ kind: "create", originalLanguage: "en", draft: story() },
				anna,
			),
		);

		expect(error).toBeInstanceOf(DraftError);
		expect(written).toEqual([]);
	});

	test("chips, tags and citations must point at what they claim to", async () => {
		const { deps } = archive();
		const unknown = "0190a8e2-7a3b-7c4d-8e5f-cccccccccccc";

		const error = await refusal(
			propose(
				deps,
				{
					kind: "create",
					originalLanguage: "de",
					draft: story([{ body: `${chip(unknown)} und ${chip(feuerwehr)}` }], {
						tags: [josef],
						citations: [{ sourceEntityId: kirche, locator: null }],
					}),
				},
				anna,
			),
		);

		expect(error.problems.map((problem) => problem.path)).toEqual([
			"content.de.body",
			"content.de.body",
			"tags.0",
			"citations.0",
		]);
		// One message whether an id is unknown, someone else's unpublished entry or the wrong
		// type — a proposer cannot probe the archive for what exists.
		expect(
			error.problems.slice(0, 2).map((problem) => problem.message),
		).toEqual([
			`${feuerwehr} is not an entry you can reference here`,
			`${unknown} is not an entry you can reference here`,
		]);
	});

	test("a malformed file id is refused before anything is asked about it", async () => {
		const { deps } = archive();
		let asked = false;
		deps.usableAssets = async (ids) => {
			asked = ids.length > 0;
			return new Set();
		};
		const error = await refusal(
			propose(
				deps,
				{
					kind: "create",
					originalLanguage: "de",
					draft: {
						type: "media",
						fields: { captured: null, point: null },
						content: [
							{
								language: "de",
								name: "Foto",
								abstract: null,
								description: null,
								caption: null,
							},
						],
						tags: [],
						citations: [],
						files: [
							{ assetId: "x", role: "original", isPrimary: true, sortOrder: 0 },
						],
					},
				},
				anna,
			),
		);
		expect(error.problems.map((problem) => problem.path)).toEqual(["files.0"]);
		// The id never reached the query, which would have failed on the cast.
		expect(asked).toBe(false);
	});

	test("files must be the proposer's own uploads", async () => {
		const { deps } = archive();
		const error = await refusal(
			propose(
				deps,
				{
					kind: "create",
					originalLanguage: "de",
					draft: {
						type: "media",
						fields: { captured: null, point: null },
						content: [
							{
								language: "de",
								name: "Foto",
								abstract: null,
								description: null,
								caption: null,
							},
						],
						tags: [],
						citations: [],
						files: [
							{
								assetId: mine,
								role: "original",
								isPrimary: true,
								sortOrder: 0,
							},
							{
								assetId: theirs,
								role: "web",
								isPrimary: false,
								sortOrder: 1,
							},
						],
					},
				},
				anna,
			),
		);
		expect(error.problems.map((problem) => problem.path)).toEqual(["files.1"]);
	});

	test("an edit may not drop a published language", async () => {
		const { deps, written } = archive();

		const error = await refusal(
			propose(
				deps,
				{
					kind: "edit",
					entityId: "story-1",
					basedOnVersion: 2,
					draft: story(),
				},
				anna,
			),
		);

		expect(error.problems).toEqual([
			{
				path: "content.en",
				message:
					"a published language cannot be removed by a proposal; content that must go is a redaction",
			},
		]);
		expect(written).toEqual([]);
	});

	test("an edit is based on a version that exists, of an entry of the same type", async () => {
		const { deps } = archive();
		const both = story([{}, { language: "en", name: "The war years" }]);

		const future = await refusal(
			propose(
				deps,
				{ kind: "edit", entityId: "story-1", basedOnVersion: 3, draft: both },
				anna,
			),
		);
		const missing = await refusal(
			propose(
				deps,
				{ kind: "edit", entityId: "ghost", basedOnVersion: 1, draft: both },
				anna,
			),
		);

		expect(future.problems.map((problem) => problem.path)).toEqual([
			"basedOnVersion",
		]);
		expect(missing.problems.map((problem) => problem.path)).toEqual([
			"entityId",
		]);
	});

	test("an anonymous visitor cannot propose", async () => {
		const { deps, written } = archive();
		const error = await propose(
			deps,
			{ kind: "create", originalLanguage: "de", draft: story() },
			anonymousActor(["story:propose"]),
		).catch((caught) => caught as Error);
		expect(error).toBeInstanceOf(AnonymousActorError);
		expect(written).toEqual([]);
	});
});

describe("editProposal", () => {
	const pending: ProposalRecord = {
		entityId: "story-1",
		type: "story",
		originalLanguage: "de",
		status: "pending",
		basedOnVersion: 1,
		proposedBy: "anna",
	};
	const both = story([{}, { language: "en", name: "The war years" }]);

	test("its author may replace it", async () => {
		const { deps, written } = archive({ p: pending });
		await editProposal(deps, "p", both, anna);
		expect(written.map((entry) => entry.proposalId)).toEqual(["p"]);
	});

	test("a moderator of its type may too — and the proposer stays the author", async () => {
		const { deps, written, askedFor } = archive({ p: pending });
		await editProposal(
			deps,
			"p",
			story([{ body: chip(josef) }, { language: "en", name: "The war years" }]),
			moderator,
		);
		expect(written.map((entry) => entry.authorId)).toEqual(["anna"]);
		// The proposer's own unpublished entries stay referenceable when a moderator edits.
		expect(askedFor).toEqual([["anna", "mod"]]);
	});

	test("somebody else may not, and cannot tell it exists", async () => {
		const { deps, written } = archive({ p: pending });

		const theirs = await editProposal(deps, "p", both, bernd).catch(
			(caught) => caught as Error,
		);
		const none = await editProposal(deps, "ghost", both, bernd).catch(
			(caught) => caught as Error,
		);

		expect(theirs).toBeInstanceOf(ProposalNotEditableError);
		expect(theirs.message).toBe(none.message.replace("ghost", "p"));
		expect(written).toEqual([]);
	});

	test.each(["accepted", "rejected"] as const)(
		"a %s proposal is part of the record and stays as it was",
		async (status) => {
			const { deps } = archive({ p: { ...pending, status } });
			expect(
				await editProposal(deps, "p", both, anna).catch((caught) => caught),
			).toBeInstanceOf(ProposalNotEditableError);
		},
	);

	// How a conflict is resolved: restate the proposal against the current head.
	test("a moderator may rebase it onto the head", async () => {
		const { deps, rebased } = archive({ p: pending });
		await editProposal(deps, "p", both, moderator, { rebaseTo: 2 });
		expect(rebased).toEqual([{ proposalId: "p", version: 2 }]);
	});

	// Each of these once reached a query with something it could not hold.
	test("an unknown type or a refused rebase never reaches the archive", async () => {
		const { deps } = archive({ p: pending });
		deps.languagesOf = async (_, type, version) => {
			if (!Number.isInteger(version) || type !== "story")
				throw new Error(`asked about ${type} v${version}`);
			return ["de", "en"];
		};

		const bogus = await refusal(
			editProposal(deps, "p", { ...both, type: "letter" } as never, anna),
		);
		const fractional = await refusal(
			editProposal(deps, "p", both, moderator, { rebaseTo: 1.5 }),
		);

		expect(bogus).toBeInstanceOf(DraftError);
		expect(fractional).toBeInstanceOf(DraftError);
	});

	test("a rebase only moves forward", async () => {
		const { deps, rebased } = archive({ p: { ...pending, basedOnVersion: 2 } });
		const error = await refusal(
			editProposal(deps, "p", both, moderator, { rebaseTo: 1 }),
		);
		expect(error.problems.map((problem) => problem.path)).toEqual(["rebaseTo"]);
		expect(rebased).toEqual([]);
	});

	test("its author may not rebase it — that is a moderator's decision", async () => {
		const { deps, rebased } = archive({ p: pending });
		const error = await refusal(
			editProposal(deps, "p", both, anna, { rebaseTo: 2 }),
		);
		expect(error.problems.map((problem) => problem.path)).toEqual(["rebaseTo"]);
		expect(rebased).toEqual([]);
	});

	// A create has no base to compare with, but it has the language it was written in.
	test("an edited create cannot lose its original language", async () => {
		const { deps, written } = archive({
			p: { ...pending, basedOnVersion: null },
		});
		const error = await refusal(
			editProposal(
				deps,
				"p",
				story([{ language: "en", name: "The war years" }]),
				anna,
			),
		);
		expect(error.problems.map((problem) => problem.path)).toEqual([
			"content.de",
		]);
		expect(written).toEqual([]);
	});

	test("the type cannot change", async () => {
		const { deps } = archive({ p: pending });
		const error = await refusal(
			editProposal(
				deps,
				"p",
				{
					type: "tag",
					fields: {},
					content: [{ language: "de", name: "x", abstract: null }],
					tags: [],
					citations: [],
				},
				anna,
			),
		);
		expect(error.problems.map((problem) => problem.path)).toContain("type");
	});
});

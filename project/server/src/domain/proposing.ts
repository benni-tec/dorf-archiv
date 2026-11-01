import { extractLinks, isUuid, normalize, parse, validate } from "shared";
import { type Actor, can, requireAccountId } from "./actor";
import {
	type Draft,
	LINKABLE_TYPES,
	PLAIN_TEXT_CONTENT_FIELDS,
	PREVIEW_FIELDS,
	type VersionedType,
} from "./entity";

/**
 * Proposing and editing proposals — PLAN.md §2.2, §5.1's `propose` / `editProposal`, §11.
 *
 * **A proposal is the entity's complete state, never a delta.** The client loads the head,
 * edits it, and sends the whole thing; what the proposer *changed* is derived later, by
 * comparing it with the version it was based on (`merge.ts`). That makes this side simple —
 * a proposal is written whole, and editing one replaces it whole — and puts the checking
 * here, before anything reaches a moderator:
 *
 * - every body is stored in **canonical** directive-Markdown (`shared`'s `normalize`), so
 *   diffs between versions show what changed rather than how it was typed;
 * - every chip is exactly `:entity{#<uuid>}` and points at an entity that exists and can be
 *   linked to; chips appear only on types that have links at all (§2.1);
 * - tags point at tags, citations at sources, relationships at people;
 * - a published language is never dropped (§2.4) — refused here with a reason, rather than
 *   discovered at publish time.
 *
 * Whether the actor may propose this type at all is the route's question (§4.4). Whether
 * they may edit *this* proposal is a condition on the row — its author, or a moderator of
 * the type — and is answered here.
 */

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export type DraftProblem = {
	/** Where — `content.de.abstract`, `tags.0`, `fields.personA`. */
	path: string;
	/** What is wrong, in words an editor could show next to the field. */
	message: string;
};

/** A draft that cannot be stored as it is. Every problem at once, not the first. */
export class DraftError extends Error {
	readonly problems: DraftProblem[];

	constructor(problems: DraftProblem[]) {
		super(
			`The proposal cannot be saved: ${problems
				.map((problem) => `${problem.path}: ${problem.message}`)
				.join("; ")}`,
		);
		this.name = "DraftError";
		this.problems = problems;
	}
}

export class ProposalNotEditableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProposalNotEditableError";
	}
}

export type ProposalRecord = {
	entityId: string;
	type: VersionedType;
	/** The entity's original language — the one a draft of it may never be without. */
	originalLanguage: string;
	status: "pending" | "accepted" | "rejected";
	basedOnVersion: number | null;
	proposedBy: string;
};

export type ProposeDependencies = {
	/** The entity's spine, or null if there is no such versioned entity. */
	findEntity: (
		entityId: string,
	) => Promise<{ type: VersionedType; head: number | null } | null>;
	/** The languages a published version of an entity of this type has. */
	languagesOf: (
		entityId: string,
		type: VersionedType,
		version: number,
	) => Promise<string[]>;
	/**
	 * The type of each id that may be referenced: a published entity, or one created by one
	 * of `accounts` and not yet published — so a photo can be proposed with the new Place it
	 * shows (§2.3). Everything else is absent, whether it does not exist or is somebody
	 * else's unpublished entry, so the answer reveals neither.
	 */
	referenceable: (
		ids: readonly string[],
		accounts: readonly string[],
	) => Promise<Map<string, string>>;
	/**
	 * The assets that may be attached to this entity: uploaded by one of `accounts`, or
	 * already in a published version of it. Unpublished blobs sit in storage from upload
	 * (§4.6 #3), so attaching somebody else's would be a way to see it.
	 */
	usableAssets: (
		assetIds: readonly string[],
		entityId: string | null,
		accounts: readonly string[],
	) => Promise<Set<string>>;
	createEntity: (
		type: VersionedType,
		originalLanguage: string,
		actor: Actor,
	) => Promise<string>;
	createProposal: (
		entityId: string,
		basedOnVersion: number | null,
		actor: Actor,
	) => Promise<string>;
	/**
	 * The proposal, **locked** for the rest of the transaction — so a publish or rejection
	 * racing this edit either finishes first, and this one sees it decided, or waits.
	 */
	loadProposal: (proposalId: string) => Promise<ProposalRecord | null>;
	/**
	 * Replaces every row the proposal holds with the draft's, and derives its link set from
	 * the bodies. The draft is already validated and normalised.
	 *
	 * `authorId` is who proposed it — recorded as the author of the words even when a
	 * moderator is the one writing this state of them (§2.2a).
	 */
	writeDraft: (
		entityId: string,
		proposalId: string,
		draft: Draft,
		authorId: string,
		actor: Actor,
	) => Promise<void>;
	/** Moves the proposal onto a newer base — how a moderator resolves a conflict. */
	rebase: (proposalId: string, version: number, actor: Actor) => Promise<void>;
};

/** The directive-Markdown fields of a content row — see `PLAIN_TEXT_CONTENT_FIELDS`. */
const proseOf = (row: Record<string, unknown>) =>
	Object.entries(row).filter(
		([field, value]) =>
			!PLAIN_TEXT_CONTENT_FIELDS.includes(field) && typeof value === "string",
	) as [string, string][];

/**
 * The draft with every body in canonical form, and every problem the draft has on its own —
 * before anything is looked up. Pure, so it is tested without a database.
 */
const FILE_ROLES: readonly string[] = ["original", "web", "thumb"];

export function checkDraft(draft: Draft): {
	draft: Draft;
	problems: DraftProblem[];
	/** Every entity the draft references, by what it must be. */
	references: {
		id: string;
		must: "linkable" | "tag" | "source" | "person";
		path: string;
	}[];
} {
	if (!Object.hasOwn(PREVIEW_FIELDS, draft.type)) {
		// Not a type with versions at all — nothing below would know how to read it.
		return {
			draft,
			problems: [{ path: "type", message: "not a kind of entry" }],
			references: [],
		};
	}

	const problems: DraftProblem[] = [];
	const references: ReturnType<typeof checkDraft>["references"] = [];
	const linkable = LINKABLE_TYPES.has(draft.type);

	if (draft.content.length === 0)
		problems.push({
			path: "content",
			message: "at least one language is needed",
		});

	const seen = new Set<string>();
	const content = draft.content.map((row) => {
		const at = `content.${row.language}`;
		if (!LANGUAGE.test(row.language))
			problems.push({
				path: at,
				message: "not a language tag such as de or en-GB",
			});
		if (seen.has(row.language))
			problems.push({ path: at, message: "this language appears twice" });
		seen.add(row.language);
		if (typeof row.name !== "string" || row.name.trim() === "")
			problems.push({ path: `${at}.name`, message: "a name is needed" });
		// Every other field is prose or absent. Anything else would skip the chip checks
		// below — they only read text — and be stored as it came.
		for (const [field, value] of Object.entries(row)) {
			if (
				!PLAIN_TEXT_CONTENT_FIELDS.includes(field) &&
				value !== null &&
				typeof value !== "string"
			)
				problems.push({ path: `${at}.${field}`, message: "must be text" });
		}

		const normalised: Record<string, unknown> = {
			...row,
			name: typeof row.name === "string" ? row.name.trim() : row.name,
		};
		for (const [field, markdown] of proseOf(row)) {
			const path = `${at}.${field}`;

			// Checked twice, on purpose. The input is what the contributor typed, so its
			// problems are the ones to show them — a labelled chip is refused here rather than
			// having its label silently dropped. The canonical form is what is **stored**, and
			// must hold exactly the same chips: checking one text and keeping another is how
			// a chip would reach the link set without passing a single check.
			const typed = parse(markdown);
			const typedProblems = validate(typed, markdown);
			for (const problem of typedProblems) {
				problems.push({
					path,
					message: `${problem.source} is not a valid chip (${problem.reason})`,
				});
			}

			const canonical = normalize(markdown).trimEnd();
			normalised[field] = canonical === "" ? null : canonical;
			const doc = parse(canonical);
			if (
				typedProblems.length === 0 &&
				(validate(doc).length > 0 ||
					extractLinks(doc).join() !== extractLinks(typed).join())
			) {
				problems.push({
					path,
					message: "this text means something different once stored",
				});
			}

			const links = extractLinks(doc);
			if (links.length > 0 && !linkable) {
				problems.push({
					path,
					message: `a ${draft.type} cannot reference other entries`,
				});
			}
			for (const id of links) references.push({ id, must: "linkable", path });
		}
		return normalised;
	});

	draft.tags.forEach((id, index) => {
		references.push({ id, must: "tag", path: `tags.${index}` });
	});
	if ("files" in draft) {
		draft.files.forEach((file, index) => {
			if (!isUuid(file.assetId))
				problems.push({ path: `files.${index}`, message: "not a file id" });
			if (!FILE_ROLES.includes(file.role))
				problems.push({
					path: `files.${index}.role`,
					message: "not a file role",
				});
			if (!Number.isInteger(file.sortOrder))
				problems.push({
					path: `files.${index}.sortOrder`,
					message: "not a position",
				});
		});
	}
	if (new Set(draft.tags).size !== draft.tags.length)
		problems.push({ path: "tags", message: "a tag appears twice" });

	draft.citations.forEach((citation, index) => {
		references.push({
			id: citation.sourceEntityId,
			must: "source",
			path: `citations.${index}`,
		});
	});
	// A citation is its source and its locator; the same pair twice says nothing more, and
	// the published version holds each pair once.
	const cited = draft.citations.map((citation) =>
		JSON.stringify([citation.sourceEntityId, citation.locator]),
	);
	if (new Set(cited).size !== cited.length)
		problems.push({ path: "citations", message: "a citation appears twice" });

	if (draft.type === "relationship") {
		const { personA, personB } = draft.fields;
		references.push({ id: personA, must: "person", path: "fields.personA" });
		references.push({ id: personB, must: "person", path: "fields.personB" });
		if (personA === personB)
			problems.push({
				path: "fields.personB",
				message: "a relationship is between two different people",
			});
	}

	if ("files" in draft) {
		const primaries = draft.files.filter((file) => file.isPrimary).length;
		if (primaries > 1)
			problems.push({ path: "files", message: "only one file can be primary" });
		const assets = draft.files.map((file) => file.assetId);
		if (new Set(assets).size !== assets.length)
			problems.push({ path: "files", message: "a file appears twice" });
	}

	// An id that is not even shaped like one is refused here, with a path, rather than
	// reaching a query as a cast that fails with a database error.
	for (const reference of references) {
		if (!isUuid(reference.id))
			problems.push({ path: reference.path, message: "not an entry id" });
	}

	return {
		draft: { ...draft, content: content as Draft["content"] } as Draft,
		problems,
		references: references.filter((reference) => isUuid(reference.id)),
	};
}

/** Problems that need the database: what referenced ids are, and what the base had. */
async function checkAgainstArchive(
	deps: ProposeDependencies,
	checked: ReturnType<typeof checkDraft>,
	entityId: string | null,
	base: number | null,
	/** Whose unpublished entries and uploads count: the author, and whoever is editing. */
	accounts: readonly string[],
): Promise<DraftProblem[]> {
	const problems = [...checked.problems];
	// Nothing below can be asked about a draft that is not a kind of entry at all.
	if (!Object.hasOwn(PREVIEW_FIELDS, checked.draft.type)) return problems;

	const ids = [...new Set(checked.references.map((reference) => reference.id))];
	const types =
		ids.length > 0 ? await deps.referenceable(ids, accounts) : new Map();
	for (const reference of checked.references) {
		const type = types.get(reference.id);
		const fits =
			type !== undefined &&
			(reference.must === "linkable"
				? LINKABLE_TYPES.has(type)
				: type === reference.must);
		if (!fits) {
			// One message whether the id is unknown, someone else's unpublished entry or the
			// wrong type, so a proposer cannot probe the archive for what exists.
			problems.push({
				path: reference.path,
				message: `${reference.id} is not ${reference.must === "linkable" ? "an entry" : `a ${reference.must}`} you can reference here`,
			});
		}
	}

	// Malformed ids were refused by `checkDraft`; only ids reach the query — and none at
	// all when there are none, since an empty `IN ()` is not SQL.
	const wanted =
		"files" in checked.draft
			? checked.draft.files.map((file) => file.assetId).filter(isUuid)
			: [];
	if ("files" in checked.draft && wanted.length > 0) {
		const usable = await deps.usableAssets(wanted, entityId, accounts);
		checked.draft.files.forEach((file, index) => {
			if (isUuid(file.assetId) && !usable.has(file.assetId)) {
				problems.push({
					path: `files.${index}`,
					message: `${file.assetId} is not a file you can attach here`,
				});
			}
		});
	}

	if (entityId !== null && base !== null) {
		const kept = new Set(checked.draft.content.map((row) => row.language));
		for (const language of await deps.languagesOf(
			entityId,
			checked.draft.type,
			base,
		)) {
			if (!kept.has(language)) {
				problems.push({
					path: `content.${language}`,
					message:
						"a published language cannot be removed by a proposal; content that must go is a redaction",
				});
			}
		}
	}

	return problems;
}

export type ProposeRequest =
	| {
			/** A new entity. */
			kind: "create";
			originalLanguage: string;
			draft: Draft;
	  }
	| {
			/** A change to a published one, made from the version the client loaded. */
			kind: "edit";
			entityId: string;
			basedOnVersion: number;
			draft: Draft;
	  };

/**
 * Proposes a new entity, or a change to a published one.
 *
 * Run inside a transaction: a proposal is several rows, and half of one is worse than none.
 *
 * @returns the proposal and the entity it is about.
 * @throws {DraftError} listing every problem with the draft.
 */
export async function propose(
	deps: ProposeDependencies,
	request: ProposeRequest,
	actor: Actor,
): Promise<{ proposalId: string; entityId: string }> {
	const actorId = requireAccountId(actor, "propose");
	const checked = checkDraft(request.draft);

	if (request.kind === "create") {
		if (
			!checked.draft.content.some(
				(row) => row.language === request.originalLanguage,
			)
		) {
			checked.problems.push({
				path: "originalLanguage",
				message: "the original language must be one of the draft's languages",
			});
		}
		const problems = await checkAgainstArchive(deps, checked, null, null, [
			actorId,
		]);
		if (problems.length > 0) throw new DraftError(problems);

		const entityId = await deps.createEntity(
			checked.draft.type,
			request.originalLanguage,
			actor,
		);
		const proposalId = await deps.createProposal(entityId, null, actor);
		await deps.writeDraft(entityId, proposalId, checked.draft, actorId, actor);
		return { proposalId, entityId };
	}

	const entity = await deps.findEntity(request.entityId);
	const spine: DraftProblem[] = [];
	if (!entity || entity.head === null) {
		spine.push({
			path: "entityId",
			message: "there is no published entry to change",
		});
	} else {
		if (entity.type !== checked.draft.type)
			spine.push({ path: "type", message: `this entry is a ${entity.type}` });
		if (
			!Number.isInteger(request.basedOnVersion) ||
			request.basedOnVersion < 1 ||
			request.basedOnVersion > entity.head
		)
			spine.push({ path: "basedOnVersion", message: "no such version" });
	}
	if (spine.length > 0) throw new DraftError(spine);

	const problems = await checkAgainstArchive(
		deps,
		checked,
		request.entityId,
		request.basedOnVersion,
		[actorId],
	);
	if (problems.length > 0) throw new DraftError(problems);

	const proposalId = await deps.createProposal(
		request.entityId,
		request.basedOnVersion,
		actor,
	);
	await deps.writeDraft(
		request.entityId,
		proposalId,
		checked.draft,
		actorId,
		actor,
	);
	return { proposalId, entityId: request.entityId };
}

/**
 * Replaces a pending proposal's state — "editing a proposal is normal and expected" (§2.2a).
 *
 * Its author may, and so may a moderator of its type: contributors refine before review,
 * moderators adjust before merging. A moderator may also **rebase** it onto a newer version,
 * which is how a conflict is resolved — the proposal is restated against the current head,
 * and the merge then has nothing left to disagree about.
 *
 * Run inside a transaction.
 *
 * @throws {ProposalNotEditableError} if it is missing, decided, or not the actor's to edit.
 * @throws {DraftError} as for {@link propose}.
 */
export async function editProposal(
	deps: ProposeDependencies,
	proposalId: string,
	draft: Draft,
	actor: Actor,
	options: { rebaseTo?: number } = {},
): Promise<void> {
	const actorId = requireAccountId(actor, "edit a proposal");
	const proposal = await deps.loadProposal(proposalId);

	// Missing and not-yours read the same, so nobody can probe for proposals by id.
	if (
		!proposal ||
		(proposal.proposedBy !== actorId &&
			!can(actor, `${proposal.type}:moderate`))
	) {
		throw new ProposalNotEditableError(`No proposal ${proposalId} to edit.`);
	}
	if (proposal.status !== "pending") {
		throw new ProposalNotEditableError(
			`Proposal ${proposalId} is ${proposal.status}; a decided proposal is part of the record and stays as it was.`,
		);
	}

	const checked = checkDraft(draft);
	if (checked.draft.type !== proposal.type)
		checked.problems.push({
			path: "type",
			message: `this entry is a ${proposal.type}`,
		});
	// A create has no base version to compare languages against, but it does have the
	// language it was written in, and the entity records that one as its original (§2.4).
	if (
		!checked.draft.content.some(
			(row) => row.language === proposal.originalLanguage,
		)
	)
		checked.problems.push({
			path: `content.${proposal.originalLanguage}`,
			message: "the original language cannot be removed",
		});

	let basedOn = proposal.basedOnVersion;
	if (options.rebaseTo !== undefined) {
		const entity = await deps.findEntity(proposal.entityId);
		if (!can(actor, `${proposal.type}:moderate`)) {
			checked.problems.push({
				path: "rebaseTo",
				message: "only a moderator moves a proposal onto a newer version",
			});
		} else if (
			!entity?.head ||
			!Number.isInteger(options.rebaseTo) ||
			options.rebaseTo < 1 ||
			options.rebaseTo > entity.head ||
			// Forward only: moving onto an older version would make everything published
			// since look like the proposer's own reversion.
			options.rebaseTo < (proposal.basedOnVersion ?? 0)
		) {
			checked.problems.push({ path: "rebaseTo", message: "no such version" });
		} else {
			// Only a rebase that passed is compared against; a refused one never reaches a query.
			basedOn = options.rebaseTo;
		}
	}

	const problems = await checkAgainstArchive(
		deps,
		checked,
		proposal.entityId,
		basedOn,
		[proposal.proposedBy, actorId],
	);
	if (problems.length > 0) throw new DraftError(problems);

	if (
		options.rebaseTo !== undefined &&
		options.rebaseTo !== proposal.basedOnVersion
	)
		await deps.rebase(proposalId, options.rebaseTo, actor);
	// The proposer stays the author of the words, whoever wrote this state of them (§2.2a).
	await deps.writeDraft(
		proposal.entityId,
		proposalId,
		checked.draft,
		proposal.proposedBy,
		actor,
	);
}

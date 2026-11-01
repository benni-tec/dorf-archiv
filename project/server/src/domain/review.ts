import type { Actor } from "./actor";
import type {
	Citation,
	MediaFile,
	ProposedEntity,
	PublishedEntity,
	References,
} from "./entity";
import { type Conflict, ConflictError, IncompleteProposalError } from "./merge";
import {
	type BlockingReference,
	ClosureViolationError,
	maySettle,
	NotPublishableError,
	type PublishDependencies,
	publishAll,
} from "./publishing";

/**
 * Reviewing a proposal before publishing it — PLAN.md §2.2a, §6 (`ProposalDiff`,
 * `StaleProposalWarning`, `DependencyList`).
 *
 * The moderation UI needs a **field-level diff** before publishing, and must flag a proposal
 * whose `based_on_version` is no longer the head, showing what publishing would actually do.
 *
 * Two diffs, answering two questions:
 *
 * - **What did the proposer change?** A proposal is a complete state (§11), so this is the
 *   plain difference between it and the version it was based on.
 * - **What would publishing do?** The outcome is **rehearsed, not predicted**: the publish
 *   runs for real inside a transaction that is always rolled back, and the version it wrote
 *   is read back before the rollback. An earlier version of this module computed the outcome
 *   with its own copy of the publishing rules, and the copy was exactly as correct as the
 *   last time someone remembered to update it. Rehearsing cannot drift: it *is* publishing.
 *
 * When publishing would refuse — a conflict, a dropped language, an unpublished dependency —
 * the review says why instead of an outcome, which is what the moderator needs to act on.
 */

/** What a version consists of, independent of whether it exists yet. */
export type Snapshot = {
	fields: Record<string, unknown>;
	content: { language: string; [field: string]: unknown }[];
	references: References;
	/** Media only. */
	files?: MediaFile[];
};

export type FieldChange = { field: string; before: unknown; after: unknown };

export type ContentChange = {
	language: string;
	/** `added` and `removed` are whole languages; `changed` lists the fields that moved. */
	kind: "added" | "removed" | "changed";
	changes: FieldChange[];
};

export type SetChange<T> = { added: T[]; removed: T[] };

export type Diff = {
	fields: FieldChange[];
	content: ContentChange[];
	links: SetChange<string>;
	tags: SetChange<string>;
	citations: SetChange<Citation>;
	/** Media only: files added to or dropped from the version. */
	files: SetChange<MediaFile>;
};

/** Values are plain data — rough dates, strings, GeoJSON — so structure is identity. */
const same = (a: unknown, b: unknown) =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function diffRecords(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	ignore: readonly string[] = [],
): FieldChange[] {
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter((key) => !ignore.includes(key))
		.sort();

	return keys
		.filter((key) => !same(before[key], after[key]))
		.map((key) => ({
			field: key,
			before: before[key] ?? null,
			after: after[key] ?? null,
		}));
}

function diffSets<T>(
	before: T[],
	after: T[],
	key: (item: T) => string,
): SetChange<T> {
	const beforeKeys = new Set(before.map(key));
	const afterKeys = new Set(after.map(key));

	return {
		added: after.filter((item) => !beforeKeys.has(key(item))),
		removed: before.filter((item) => !afterKeys.has(key(item))),
	};
}

const citationKey = (item: Citation) =>
	JSON.stringify([item.sourceEntityId, item.locator]);

/** A file is the same file only if every property is — a new primary is a change. */
const fileKey = (item: MediaFile) =>
	JSON.stringify([item.assetId, item.role, item.isPrimary, item.sortOrder]);

/** Field-level differences between two states of one entity. */
export function diffSnapshots(before: Snapshot, after: Snapshot): Diff {
	const beforeContent = new Map(
		before.content.map((row) => [row.language, row]),
	);
	const afterContent = new Map(after.content.map((row) => [row.language, row]));
	const languages = [
		...new Set([...beforeContent.keys(), ...afterContent.keys()]),
	].sort();

	const content: ContentChange[] = [];
	for (const language of languages) {
		const was = beforeContent.get(language);
		const is = afterContent.get(language);

		if (!was && is) {
			content.push({
				language,
				kind: "added",
				changes: diffRecords({}, is, ["language"]),
			});
		} else if (was && !is) {
			content.push({
				language,
				kind: "removed",
				changes: diffRecords(was, {}, ["language"]),
			});
		} else if (was && is) {
			const changes = diffRecords(was, is, ["language"]);
			if (changes.length > 0)
				content.push({ language, kind: "changed", changes });
		}
	}

	return {
		fields: diffRecords(before.fields, after.fields),
		content,
		links: diffSets(before.references.links, after.references.links, String),
		tags: diffSets(before.references.tags, after.references.tags, String),
		citations: diffSets(
			before.references.citations,
			after.references.citations,
			citationKey,
		),
		files: diffSets(before.files ?? [], after.files ?? [], fileKey),
	};
}

const snapshotOf = (entity: PublishedEntity | ProposedEntity): Snapshot => ({
	fields: (entity.fields ?? {}) as Record<string, unknown>,
	content: entity.content,
	references: entity.references,
	...("files" in entity ? { files: entity.files } : {}),
});

/** Why a proposal cannot be published as it stands. */
export type Blocked =
	| { kind: "conflict"; conflicts: Conflict[] }
	| { kind: "incomplete"; missing: IncompleteProposalError["missing"] }
	| { kind: "closure"; blocking: BlockingReference[] }
	| { kind: "not-publishable"; reason: string };

export type Review = {
	proposal: ProposedEntity;
	/** A create has nothing to diff against — §6: "nothing for a `create` proposal". */
	isCreate: boolean;
	/** Base → proposal: what the proposer changed. Null for a create. */
	changes: Diff | null;
	/**
	 * The head has moved since the proposer's base. True as well for a create whose entity
	 * someone else has published meanwhile.
	 */
	stale: boolean;
	/** The version publishing would produce, rehearsed. Null when it would be refused. */
	outcome: Snapshot | null;
	/**
	 * Current head → outcome: what publishing would *actually* do to the live version. Set
	 * only when stale, where it can differ from `changes`.
	 */
	againstHead: Diff | null;
	/** Why publishing would be refused, or null if it would succeed. */
	blocked: Blocked | null;
};

/**
 * Runs `work` inside a transaction that is always rolled back, with publishing and reading
 * dependencies bound to it. Whatever `work` returns is returned; whatever it throws is thrown,
 * after the rollback.
 */
export type Rehearsal = <T>(
	/** Who would publish — recorded on rows the rehearsal then rolls back. */
	actor: Actor,
	work: (deps: {
		publish: PublishDependencies;
		findVersion: (
			entityId: string,
			version: number,
		) => Promise<PublishedEntity | null>;
	}) => Promise<T>,
) => Promise<T>;

export type ReviewDependencies = {
	findProposal: (proposalId: string) => Promise<ProposedEntity | null>;
	findVersion: (
		entityId: string,
		version: number,
	) => Promise<PublishedEntity | null>;
	findPublished: (entityId: string) => Promise<PublishedEntity | null>;
	rehearse: Rehearsal;
};

export class MissingBaseVersionError extends Error {
	constructor(proposalId: string, version: number) {
		super(
			`Proposal ${proposalId} is based on version ${version}, which cannot be read. ` +
				"There is nothing honest to diff it against.",
		);
		this.name = "MissingBaseVersionError";
	}
}

/** Publishing's refusals, as data a moderation UI can show. Anything else is rethrown. */
function blockedBy(error: unknown): Blocked {
	if (error instanceof ConflictError)
		return { kind: "conflict", conflicts: error.conflicts };
	if (error instanceof IncompleteProposalError)
		return { kind: "incomplete", missing: error.missing };
	if (error instanceof ClosureViolationError)
		return { kind: "closure", blocking: error.blocking };
	if (error instanceof NotPublishableError)
		return { kind: "not-publishable", reason: error.message };
	throw error;
}

/**
 * Everything a moderator needs to decide on one proposal, or null if the actor behind the
 * dependencies may not see it.
 *
 * `actor` is who would publish — the rehearsal records them on rows it then rolls back.
 *
 * @throws {MissingBaseVersionError} if the proposal's base version cannot be read — showing
 * a diff against something else would misdescribe what the proposer changed.
 */
export async function reviewProposal(
	deps: ReviewDependencies,
	proposalId: string,
	actor: Actor,
): Promise<Review | null> {
	const proposal = await deps.findProposal(proposalId);
	// The author may read their own proposal, but a review shows the full base version and
	// the rehearsed outcome — content the author may not be allowed to view (§4.4). It is a
	// moderator's tool, so a moderator of the type is what it requires.
	if (!proposal || !maySettle(actor, proposal)) return null;

	const head = await deps.findPublished(proposal.id);

	let base: PublishedEntity | null = null;
	if (proposal.basedOnVersion !== null) {
		base = await deps.findVersion(proposal.id, proposal.basedOnVersion);
		if (!base)
			throw new MissingBaseVersionError(proposalId, proposal.basedOnVersion);
	}

	let outcome: Snapshot | null = null;
	let blocked: Blocked | null = null;
	try {
		const version = await deps.rehearse(
			actor,
			async ({ publish, findVersion }) => {
				const [result] = await publishAll(publish, [proposalId], actor);
				return result ? findVersion(result.entityId, result.version) : null;
			},
		);
		outcome = version ? snapshotOf(version) : null;
	} catch (error) {
		blocked = blockedBy(error);
	}

	const stale = head !== null && head.version > (proposal.basedOnVersion ?? 0);

	return {
		proposal,
		isCreate: proposal.basedOnVersion === null,
		changes: base
			? diffSnapshots(snapshotOf(base), snapshotOf(proposal))
			: null,
		stale,
		outcome,
		againstHead:
			stale && head && outcome
				? diffSnapshots(snapshotOf(head), outcome)
				: null,
		blocked,
	};
}

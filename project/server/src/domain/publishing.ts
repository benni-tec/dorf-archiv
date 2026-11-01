import { type Actor, can } from "./actor";
import type { VersionedType } from "./entity";
import {
	assertComplete,
	changesAnything,
	EMPTY,
	fromVersion,
	type Merged,
	mergeProposal,
	type Origin,
	type State,
} from "./merge";

/**
 * Publishing — PLAN.md §2.2, §2.3, §11.
 *
 * **A version is a published state, created at publish time and never at proposal time.**
 * Version numbers are per-entity integers, so `(entity_id, version)` is the natural key and
 * "Version 3" means something to a human reading a citation.
 *
 * **A proposal is the entity's complete state**, and publishing is a **three-way merge** of
 * the version the proposal was based on, the proposal, and the current head (`merge.ts`).
 * So a stale proposal keeps what landed after it was made, and several proposals for one
 * entity combine into one version unless two of them changed the same part differently.
 *
 * Framework-free, with its dependencies passed in (§5.1): no Hono types and no Drizzle, so
 * a background job or a future import path reuses these rules rather than reimplementing
 * them — and so the rules can be tested without a database.
 *
 * The caller runs this inside a transaction. Everything below writes, and a half-published
 * entity is worse than an unpublished one.
 */

export type ProposalSummary = {
	id: string;
	entityId: string;
	/** What it is a proposal for — and so which `<type>:moderate` decides it (§4.4). */
	type: VersionedType;
	status: "pending" | "accepted" | "rejected";
	/** Null when the proposal introduces a new entity. */
	basedOnVersion: number | null;
};

export type BlockingReference = {
	referenceTable: string;
	referenceColumn: string;
	targetEntityId: string;
	targetType: string;
};

type ClosureResult = Promise<{
	blocking: BlockingReference[];
	tablesSearched: string[];
}>;

export type PublishDependencies = {
	loadProposal: (proposalId: string) => Promise<ProposalSummary | null>;
	/** What a proposal's own rows reference that is unpublished — what the queue lists. */
	findUnpublishedReferences: (proposalId: string) => ClosureResult;
	/** The same, for a version just written — the invariant itself. */
	findUnpublishedInVersion: (
		entityId: string,
		version: number,
	) => ClosureResult;
	/**
	 * The entity's published head, **locked** for the rest of the transaction, so two
	 * moderators publishing the same entity at once serialise rather than both merging
	 * against the same head. Null if it was never published.
	 */
	lockHead: (entityId: string) => Promise<number | null>;
	/** One version or one proposal of the entity, as merge parts. */
	loadState: (entityId: string, origin: Origin) => Promise<State>;
	/** The next per-entity integer. 1 for an entity that has never been published. */
	nextVersion: (entityId: string) => Promise<number>;
	recordVersion: (
		entityId: string,
		version: number,
		actor: Actor,
	) => Promise<void>;
	/** Writes the merged state as the version's rows — each part from the side that won it. */
	writeVersion: (
		entityId: string,
		version: number,
		merged: Merged,
		actor: Actor,
	) => Promise<void>;
	/** Derives the version's link set from its bodies (§2.6). */
	deriveLinks: (
		entityId: string,
		version: number,
		actor: Actor,
	) => Promise<void>;
	/** Annotates the proposal's own rows with the version they fed into. */
	markIncorporated: (
		proposalId: string,
		version: number,
		actor: Actor,
	) => Promise<void>;
	/** Moves the proposal to `accepted` — its own step, not a side effect of another. */
	markAccepted: (proposalId: string, actor: Actor) => Promise<void>;
	setPublishedHead: (
		entityId: string,
		version: number,
		actor: Actor,
	) => Promise<void>;
};

export type PublishResult = {
	entityId: string;
	version: number;
	/** Every proposal incorporated into this version, in the order they were merged. */
	proposalIds: string[];
};

/**
 * Whether the actor may decide this proposal — publish it, reject it, rehearse it.
 *
 * **Checked here, not only on the route.** A moderation route takes a proposal id, and an
 * id does not say what type it is a proposal *for*: `requires("place:moderate")` on the route
 * would let a place moderator publish a person. The type is known once the proposal is
 * loaded, which is here, so this is where the check that counts happens.
 */
export function maySettle(actor: Actor, proposal: { type: VersionedType }) {
	return can(actor, `${proposal.type}:moderate`);
}

export class NotPublishableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NotPublishableError";
	}
}

/**
 * Carries the blocking references, because refusing is only half the job: the moderation UI
 * lists a proposal's unpublished dependencies with inline publish/remove, and a "publish
 * all" for the common case of a photo proposed together with its new Place (§2.3).
 */
export class ClosureViolationError extends Error {
	readonly blocking: BlockingReference[];

	constructor(blocking: BlockingReference[]) {
		const described = blocking
			.map(
				(item) =>
					`${item.targetType} ${item.targetEntityId} (via ${item.referenceTable})`,
			)
			.join(", ");

		super(
			`Cannot publish: this references content that is not published — ${described}. ` +
				"Published content may only reference published content, so publish or remove " +
				"each of these first.",
		);
		this.name = "ClosureViolationError";
		this.blocking = blocking;
	}
}

/**
 * Publishes one pending proposal as a new version of its entity.
 *
 * @throws {NotPublishableError} if the proposal is missing, not pending, or changes nothing.
 * @throws {IncompleteProposalError} if it drops a published language or its own fields.
 * @throws {ConflictError} if it changed a part the head has since changed differently.
 * @throws {ClosureViolationError} if the version would reference anything unpublished.
 */
export async function publishProposal(
	deps: PublishDependencies,
	proposalId: string,
	actor: Actor,
): Promise<PublishResult> {
	const [result] = await publishAll(deps, [proposalId], actor);
	if (!result) throw new NotPublishableError(`No proposal ${proposalId}.`);
	return result;
}

/**
 * Publishes several proposals together — the moderation queue's "publish all" (§2.3), and
 * the way several proposals for **one** entity become one version (§2.2a).
 *
 * The closure invariant is checked **for the set**: a reference is satisfied if its target
 * is already published *or is being published by this same call*. Everything happens in the
 * caller's one transaction, so by the time anything is visible the whole set is. That is
 * strictly more than publishing one at a time can do — two new entities that mention each
 * other could never go out otherwise, since each would block the other.
 *
 * Proposals for the same entity are merged in creation order, each against its own base,
 * into one new version. Order matters only to which proposal a conflict is reported
 * against; a merge that succeeds produces the same state either way.
 *
 * @throws {NotPublishableError} if any proposal is missing or not pending, or an entity's
 * merged state changes nothing.
 * @throws {IncompleteProposalError}, {ConflictError} as for {@link publishProposal}.
 * @throws {ClosureViolationError} listing every reference that points outside the set at
 * something unpublished.
 */
export async function publishAll(
	deps: PublishDependencies,
	proposalIds: readonly string[],
	actor: Actor,
): Promise<PublishResult[]> {
	// UUIDv7: sorting ids is sorting by creation (§5.2).
	const ids = [...new Set(proposalIds)].sort();
	const byEntity = new Map<string, ProposalSummary[]>();

	for (const id of ids) {
		const proposal = await deps.loadProposal(id);
		// A proposal of a type the actor does not moderate reads exactly like one that does
		// not exist — so nobody can probe for proposals by id.
		if (!proposal || !maySettle(actor, proposal))
			throw new NotPublishableError(`No proposal ${id}.`);
		if (proposal.status !== "pending") {
			// Proposals are never deleted, so an accepted or rejected one is still here to be
			// asked about — and publishing it again would mint a second version from the same
			// change (§2.2).
			throw new NotPublishableError(
				`Proposal ${id} is ${proposal.status}, not pending, so there is nothing to publish.`,
			);
		}
		byEntity.set(proposal.entityId, [
			...(byEntity.get(proposal.entityId) ?? []),
			proposal,
		]);
	}

	const insideTheSet = (reference: BlockingReference) =>
		byEntity.has(reference.targetEntityId);

	// Every proposal's dependencies at once, before anything is written, so the moderator
	// sees the whole list rather than the first entity's share of it.
	const outside: BlockingReference[] = [];
	for (const id of ids) {
		const { blocking } = await deps.findUnpublishedReferences(id);
		outside.push(...blocking.filter((reference) => !insideTheSet(reference)));
	}
	if (outside.length > 0) throw new ClosureViolationError(outside);

	const published: PublishResult[] = [];
	for (const [entityId, proposals] of byEntity) {
		published.push(
			await publishEntity(deps, entityId, proposals, insideTheSet, actor),
		);
	}
	return published;
}

/** Merges an entity's proposals into the head and publishes the result as one version. */
async function publishEntity(
	deps: PublishDependencies,
	entityId: string,
	proposals: readonly ProposalSummary[],
	insideTheSet: (reference: BlockingReference) => boolean,
	actor: Actor,
): Promise<PublishResult> {
	const head = await deps.lockHead(entityId);
	const headState: Merged =
		head === null
			? new Map()
			: fromVersion(
					await deps.loadState(entityId, { kind: "version", version: head }),
					head,
				);

	let merged = headState;
	for (const proposal of proposals) {
		const base =
			proposal.basedOnVersion === null
				? EMPTY
				: await deps.loadState(entityId, {
						kind: "version",
						version: proposal.basedOnVersion,
					});
		const state = await deps.loadState(entityId, {
			kind: "proposal",
			proposalId: proposal.id,
		});

		assertComplete(proposal.id, base, state);
		merged = mergeProposal(base, merged, state, proposal.id);
	}

	if (head !== null && !changesAnything(merged, headState)) {
		throw new NotPublishableError(
			`Publishing ${proposals.map((item) => item.id).join(", ")} would change nothing in ` +
				`version ${head} — everything proposed is already there. Reject it instead.`,
		);
	}

	const version = await deps.nextVersion(entityId);

	// Every step takes the actor: §2.2a wants who did it recorded on each row it touches,
	// not only on the version record.
	await deps.recordVersion(entityId, version, actor);
	await deps.writeVersion(entityId, version, merged, actor);
	await deps.deriveLinks(entityId, version, actor);

	// The invariant is about what is published, and what is published is the merge — which
	// can hold references from the head as well as from the proposals. Checked on the rows
	// just written, before the head moves to them.
	const { blocking } = await deps.findUnpublishedInVersion(entityId, version);
	const outside = blocking.filter((reference) => !insideTheSet(reference));
	if (outside.length > 0) throw new ClosureViolationError(outside);

	for (const proposal of proposals) {
		await deps.markIncorporated(proposal.id, version, actor);
		await deps.markAccepted(proposal.id, actor);
	}

	// Last, after the row-set it points at exists: the head is one of the things a read path
	// may take as evidence that content is public (§4.6 #6), so moving it first would expose
	// an entity whose published rows have not been written yet.
	await deps.setPublishedHead(entityId, version, actor);

	return {
		entityId,
		version,
		proposalIds: proposals.map((proposal) => proposal.id),
	};
}

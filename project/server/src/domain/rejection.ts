import { type Actor, requireAccountId } from "./actor";
import {
	maySettle,
	NotPublishableError,
	type ProposalSummary,
} from "./publishing";

/**
 * Rejecting a proposal — PLAN.md §2.2.
 *
 * **Proposals are never deleted.** A rejected one persists with its reason and the moderator
 * who rejected it, which is the point of the operation: not to make a contribution
 * disappear, but to record what happened to it and why. A villager who took the trouble to
 * photograph and upload something is owed an answer, and an archive that quietly drops
 * contributions stops receiving them.
 *
 * The other half of the moderation pair; `publishing.ts` holds publish.
 */

export type RejectDependencies = {
	loadProposal: (proposalId: string) => Promise<ProposalSummary | null>;
	recordRejection: (
		proposalId: string,
		reason: string,
		moderatorId: string,
	) => Promise<void>;
};

export type RejectResult = { proposalId: string; entityId: string };

export class RejectionReasonRequiredError extends Error {
	constructor() {
		super(
			"A rejection needs a reason. It is what the contributor is told, and what a later " +
				"reader of the moderation history has to go on.",
		);
		this.name = "RejectionReasonRequiredError";
	}
}

/**
 * Rejects a pending proposal, recording the reason and the moderator.
 *
 * The database refuses a rejected row missing either (`proposal_rejection_documented`), but
 * a constraint violation is not something a moderator can act on, so the rule is also here —
 * where the reason is actually written, and where the message can say what is wrong.
 *
 * @throws {RejectionReasonRequiredError} if the reason is blank.
 * @throws {NotPublishableError} if the proposal is missing or already decided.
 * @throws {AnonymousActorError} if the actor is anonymous — there is no anonymous
 * moderator, and the audit trail must not record one.
 */
export async function rejectProposal(
	deps: RejectDependencies,
	proposalId: string,
	reason: string,
	actor: Actor,
): Promise<RejectResult> {
	const moderatorId = requireAccountId(actor, "reject a proposal");

	// Trimmed at the edges only: the reason is prose a person wrote and a person will read,
	// and its internal shape is theirs.
	const written = reason.trim();
	if (written.length === 0) throw new RejectionReasonRequiredError();

	const proposal = await deps.loadProposal(proposalId);

	// Not theirs to decide reads the same as not there (`publishing.ts`, `maySettle`).
	if (!proposal || !maySettle(actor, proposal)) {
		throw new NotPublishableError(`No proposal ${proposalId}.`);
	}

	if (proposal.status !== "pending") {
		throw new NotPublishableError(
			`Proposal ${proposalId} is already ${proposal.status}; the decision on it stands.`,
		);
	}

	await deps.recordRejection(proposalId, written, moderatorId);

	return { proposalId, entityId: proposal.entityId };
}

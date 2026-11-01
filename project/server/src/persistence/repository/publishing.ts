import { getTableName, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { isUuid } from "shared";
import { requireAccountId } from "../../domain/actor";
import type {
	ProposalSummary,
	PublishDependencies,
} from "../../domain/publishing";
import type { RejectDependencies } from "../../domain/rejection";
import type { Rehearsal } from "../../domain/review";
import { VERSIONED_CONTENT_TABLES } from "../db/schema/registry";
import { findUnpublishedReferences } from "./closure";
import { findVersion } from "./read";
import { deriveLinks, loadState, writeVersion } from "./state";

/**
 * The Drizzle half of publishing — PLAN.md §5.1.
 *
 * The rules live in `domain/publishing.ts` and `domain/merge.ts`, framework-free. This is the
 * only place the base tables are touched for them, and it exists to be handed to that service
 * inside a transaction: everything here writes, and a half-published entity is worse than an
 * unpublished one. Reading and writing states as merge parts is `state.ts`.
 */

type Database = PostgresJsDatabase<Record<string, unknown>>;

/**
 * Annotates the proposal's own rows with the version they fed into (PLAN.md §2.2).
 *
 * Only that. Moving the proposal to `accepted` is its own step — hiding a state transition
 * inside a function named for something else means the domain cannot be read to learn that
 * publishing accepts the proposal.
 */
async function markIncorporated(
	db: Database,
	proposalId: string,
	version: number,
	actorId: string,
): Promise<void> {
	for (const table of VERSIONED_CONTENT_TABLES) {
		const name = sql.identifier(getTableName(table));

		await db.execute(sql`
			UPDATE ${name}
			SET version = ${version}, updated_at = now(), updated_by = ${actorId}
			WHERE proposal_id = ${proposalId}
		`);
	}
}

/** Both moderation transitions start by reading the same row. */
async function loadProposal(
	db: Database,
	proposalId: string,
): Promise<ProposalSummary | null> {
	// Not an id at all reads as no such proposal, rather than as a failed cast.
	if (!isUuid(proposalId)) return null;
	const rows = await db.execute<{
		id: string;
		entity_id: string;
		type: ProposalSummary["type"];
		status: ProposalSummary["status"];
		based_on_version: number | null;
	}>(sql`
		SELECT p.id, p.entity_id, e.type, p.status, p.based_on_version
		FROM proposal p JOIN entity e ON e.id = p.entity_id
		WHERE p.id = ${proposalId}
		-- Locked for the transaction: a publish, a rejection and an edit of one proposal
		-- serialise, and whichever waits sees the others' decision rather than overwriting it.
		FOR UPDATE OF p
	`);

	const row = rows[0];
	if (!row) return null;

	return {
		id: row.id,
		entityId: row.entity_id,
		type: row.type,
		status: row.status,
		basedOnVersion: row.based_on_version,
	};
}

/**
 * Builds the dependency set the publishing service needs.
 *
 * Pass a transaction-scoped `db`; the service performs several writes that must land or fail
 * together.
 */
export function publishDependencies(db: Database): PublishDependencies {
	return {
		loadProposal: (proposalId) => loadProposal(db, proposalId),

		findUnpublishedReferences: (proposalId) =>
			findUnpublishedReferences(db, { proposalId }),

		findUnpublishedInVersion: (entityId, version) =>
			findUnpublishedReferences(db, { entityId, version }),

		lockHead: async (entityId) => {
			const rows = await db.execute<{ version: number | null }>(sql`
				SELECT version FROM entity WHERE id = ${entityId} FOR UPDATE
			`);
			return rows[0]?.version ?? null;
		},

		loadState: (entityId, source) => loadState(db, entityId, source),

		nextVersion: async (entityId) => {
			// Read from entity_version rather than from entity.version: the head is null until
			// the first publish, and a gap would be worse than a recount.
			const rows = await db.execute<{ next: number }>(sql`
				SELECT COALESCE(MAX(version), 0) + 1 AS next
				FROM entity_version WHERE entity_id = ${entityId}
			`);

			return Number(rows[0]?.next ?? 1);
		},

		recordVersion: async (entityId, version, actor) => {
			const actorId = requireAccountId(actor, "publish");

			await db.execute(sql`
				INSERT INTO entity_version (entity_id, version, published_by, created_by, updated_by)
				VALUES (${entityId}, ${version}, ${actorId}, ${actorId}, ${actorId})
			`);
		},

		writeVersion: (entityId, version, merged, actor) =>
			writeVersion(
				db,
				entityId,
				version,
				merged,
				requireAccountId(actor, "publish"),
			),

		deriveLinks: async (entityId, version, actor) => {
			await deriveLinks(
				db,
				entityId,
				{ kind: "version", version },
				requireAccountId(actor, "publish"),
			);
		},

		markIncorporated: (proposalId, version, actor) =>
			markIncorporated(
				db,
				proposalId,
				version,
				requireAccountId(actor, "publish"),
			),

		markAccepted: async (proposalId, actor) => {
			const actorId = requireAccountId(actor, "publish");

			await db.execute(sql`
				UPDATE proposal
				SET status = 'accepted', updated_at = now(), updated_by = ${actorId}
				WHERE id = ${proposalId}
			`);
		},

		setPublishedHead: async (entityId, version, actor) => {
			const actorId = requireAccountId(actor, "publish");

			await db.execute(sql`
				UPDATE entity
				SET version = ${version}, updated_at = now(), updated_by = ${actorId}
				WHERE id = ${entityId}
			`);
		},
	};
}

/**
 * Builds the dependency set the rejection service needs.
 *
 * The proposal's rows stay exactly where they are — rejecting records a decision, it does not
 * remove a contribution (PLAN.md §2.2).
 */
export function rejectDependencies(db: Database): RejectDependencies {
	return {
		loadProposal: (proposalId) => loadProposal(db, proposalId),

		recordRejection: async (proposalId, reason, moderatorId) => {
			await db.execute(sql`
				UPDATE proposal
				SET status = 'rejected',
				    rejection_reason = ${reason},
				    moderator_id = ${moderatorId},
				    updated_at = now(),
				    updated_by = ${moderatorId}
				WHERE id = ${proposalId} AND status = 'pending'
			`);
		},
	};
}

/** Thrown to roll a rehearsal back once its result is in hand. Never escapes. */
class RehearsalOver extends Error {
	constructor(readonly result: unknown) {
		super("rehearsal over");
	}
}

/**
 * Runs work against publishing in a transaction that is **always rolled back** — how the
 * moderation review shows what publishing would produce without producing it (§2.2a).
 *
 * Rows written in the rehearsal, audit columns included, are gone afterwards; the entity's
 * head and version numbers are exactly as they were.
 */
export function rehearsal(db: Database): Rehearsal {
	return async (actor, work) => {
		try {
			// `async` and awaiting, never returning the promise straight through: a transaction
			// handed a promise it did not await hangs when that promise rejects (AGENTS.md).
			await db.transaction(async (tx) => {
				const result = await work({
					publish: publishDependencies(tx),
					findVersion: (entityId, version) =>
						findVersion(tx, entityId, version, actor),
				});
				throw new RehearsalOver(result);
			});
		} catch (caught) {
			if (caught instanceof RehearsalOver) return caught.result as never;
			throw caught;
		}
		throw new Error(
			"A rehearsal transaction committed; it must always roll back.",
		);
	};
}

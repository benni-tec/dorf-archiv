import { getTableName, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { REFERENCE_TABLES } from "../db/schema/registry";

/**
 * The publish closure invariant — PLAN.md §2.3.
 *
 * > **An entity cannot be published while any reference it holds points at something
 * > unpublished.**
 *
 * One rule covering tags, entity links, sources and relationships alike, stated once as a
 * named invariant because every new reference type would otherwise need its own gate.
 *
 * §4.6 #5 names how that goes wrong: written as a hand-written loop it silently permits
 * publishing the moment a fourth reference type exists. So this iterates `REFERENCE_TABLES`
 * and reports which tables it looked in, which makes "did it check everywhere" an
 * observable property rather than a promise.
 *
 * This is the query. Refusing the publish is the service's job — the moderation UI is meant
 * to list the dependencies with inline publish/remove and a "publish all" for the common
 * case of a photo proposed together with its new Place, and that needs the list, not a
 * boolean.
 */

export type UnpublishedReference = {
	/** Which reference table holds it — `link`, `entity_tag`, `citation`, `relationship`. */
	referenceTable: string;
	/** The column that pointed at it, for a UI that wants to say how it is referenced. */
	referenceColumn: string;
	targetEntityId: string;
	/** The target's entity type, so the queue can offer the right "publish" action. */
	targetType: string;
};

export type ClosureCheck = {
	/** Empty means the proposal may be published, as far as this invariant is concerned. */
	blocking: UnpublishedReference[];
	/**
	 * The reference tables actually searched, in registry order. Reported so a caller — or a
	 * test — can see that the check covered every registered kind rather than trusting it.
	 */
	tablesSearched: string[];
};

/** Whose references to check: one proposal's own rows, or one published version's. */
export type ReferenceScope =
	| { proposalId: string }
	| { entityId: string; version: number };

/**
 * Finds everything a proposal — or a version about to be published — references that is not
 * published.
 *
 * "Published" means the target entity has a published head: `entity.version IS NOT NULL`.
 * An entity is created with that null (§4.6 #6 lists setting it eagerly as a fail-open
 * hazard), so an unpublished dependency reads as one here without any extra bookkeeping.
 *
 * Asked of a proposal, it is what the moderation queue lists. Asked of a version, it is the
 * invariant itself: publishing merges a proposal with whatever is current, so the version
 * written is the thing that must hold only published references, and it is checked after
 * it is written and before the head moves to it.
 */
export async function findUnpublishedReferences(
	db: PostgresJsDatabase<Record<string, unknown>>,
	of: ReferenceScope,
): Promise<ClosureCheck> {
	const rowsOf =
		"proposalId" in of
			? sql`reference.proposal_id = ${of.proposalId}`
			: sql`reference.entity_id = ${of.entityId}
			      AND reference.version = ${of.version}
			      AND reference.proposal_id IS NULL`;

	const blocking: UnpublishedReference[] = [];
	const tablesSearched: string[] = [];

	for (const reference of REFERENCE_TABLES) {
		tablesSearched.push(reference.name);
		const table = sql.identifier(getTableName(reference.table));

		for (const column of reference.targetColumns) {
			const target = sql.identifier(column);

			const rows = await db.execute<{
				target_entity_id: string;
				target_type: string;
			}>(sql`
				SELECT DISTINCT
					reference.${target} AS target_entity_id,
					target.type         AS target_type
				FROM ${table} AS reference
				JOIN entity AS target ON target.id = reference.${target}
				WHERE ${rowsOf}
				  AND target.version IS NULL
			`);

			for (const row of rows) {
				blocking.push({
					referenceTable: reference.name,
					referenceColumn: column,
					targetEntityId: row.target_entity_id,
					targetType: row.target_type,
				});
			}
		}
	}

	return { blocking, tablesSearched };
}

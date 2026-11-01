import { eq, isNull, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { type Actor, isAnonymous } from "../../domain/actor";

/**
 * Permission query handlers — PLAN.md §5.1, §4.6 #7.
 *
 * The layer that turns an effective permission set into query *constraints*, rather than
 * leaving each read to remember them. That is what makes §4.6 #7 hold: backlinks, full-text
 * search and translation lookups are separate queries built on the base tables, and built by
 * hand each of them would expose proposals and superseded versions. Built through here they
 * inherit correctness by construction.
 *
 * These return conditions rather than running queries, so they compose into whatever a read
 * path actually needs — a join, an aggregate, a viewport box — without that path being free
 * to skip them.
 */

/** The columns of any content table these constraints need. */
export type ScopableContent = {
	proposalId: PgColumn;
	createdBy: PgColumn;
};

/**
 * Published content, and nothing else.
 *
 * The rule the whole design rests on, in one place: **a query that forgets
 * `proposal_id IS NULL` returns proposals to the public** — that is, it publishes
 * unmoderated content, and also duplicates a version once per proposal incorporated into it
 * (§2.2).
 *
 * This is the constraint every public read path uses. `assertPublished` in `mapper.ts` is the
 * belt to this pair of braces: if a path is built without this, the mapper throws rather than
 * quietly returning the row.
 */
export function publishedOnly(table: ScopableContent): SQL {
	return isNull(table.proposalId);
}

/**
 * Published content plus the actor's own proposals — the "my contributions" view.
 *
 * PLAN.md §4.4 puts ownership filtering in the query layer rather than in a permission
 * engine, because it is a condition on rows rather than a capability, and a role-based
 * module cannot express it.
 *
 * **Results from this must not go through `assertPublished`**, which is the point of it
 * being a separate function rather than a flag: a caller has to choose the wider read
 * deliberately, and having chosen it, has to handle proposals in the rows it gets back. An
 * anonymous actor gets exactly {@link publishedOnly}, since it owns nothing.
 */
export function publishedOrOwnProposals(
	table: ScopableContent,
	actor: Actor,
): SQL {
	if (isAnonymous(actor)) return publishedOnly(table);

	// `or` cannot return undefined for two defined arguments, but its signature allows it.
	return or(isNull(table.proposalId), eq(table.createdBy, actor.id)) as SQL;
}

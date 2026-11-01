/**
 * The published-row assertion — PLAN.md §4.6 #1, §5.1.
 *
 * Published-content views (`published_media` et al.) were considered and rejected: they
 * double the schema surface, since a column added to a table is silently invisible until it
 * is added to the view, and read paths here are the join-heavy ones where Drizzle's
 * relational query builder earns its keep. What the view was really buying was a *type-level*
 * guarantee, and that belongs to the mapper.
 *
 * So the mapper asserts. That distinction matters: a mapper that merely dropped
 * `proposal_id` would **hide** proposal-ness rather than catch it, turning a leak into a
 * silently well-typed one. Forgetting `proposal_id IS NULL` in a query is the single fault
 * that publishes unmoderated content — the one thing the design forbids — so the last thing
 * between that query and a caller is a throw, not a cast.
 */

/** The two columns any content row carries that decide whether it is published. */
type ContentRow = {
	readonly proposalId?: string | null;
	readonly version?: number | null;
	readonly entityId?: string;
};

export class ProposalLeakError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProposalLeakError";
	}
}

/**
 * Returns the row if it is published content; throws otherwise.
 *
 * A row is published when `proposal_id` is null — **not** when it has a version. A proposal
 * incorporated into version 4 keeps its own rows annotated with that version, so reading a
 * version number as evidence of publication both leaks the proposal and duplicates the
 * version once per proposal that fed into it (§2.2).
 *
 * A row that does not carry the column at all fails too: the query did not select it, so
 * nothing here can tell what it was, and §4.6 #9 says to deny on doubt rather than read
 * absence as permission.
 *
 * @throws {ProposalLeakError}
 */
export function assertPublished<Row extends ContentRow>(row: Row): Row {
	if (!("proposalId" in row)) {
		throw new ProposalLeakError(
			"This row does not carry proposal_id, so nothing can tell whether it is published. " +
				"Select the column, or read through a repository function that does.",
		);
	}

	if (row.proposalId !== null && row.proposalId !== undefined) {
		throw new ProposalLeakError(
			`A proposal reached a published read path: proposal_id ${row.proposalId}` +
				`${row.entityId ? ` on entity ${row.entityId}` : ""}. ` +
				"Published reads must constrain on `proposal_id IS NULL`; without it this content " +
				"would have been published without a moderator seeing it.",
		);
	}

	return row;
}

/** {@link assertPublished} over a result set. Returns the same array, unmapped. */
export function assertPublishedRows<Row extends ContentRow>(
	rows: Row[],
): Row[] {
	for (const row of rows) assertPublished(row);
	return rows;
}

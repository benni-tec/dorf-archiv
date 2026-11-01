import { sql } from "drizzle-orm";
import { index, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import {
	auditColumns,
	contentRowColumns,
	entity,
	versionOrProposalCheck,
} from "./entity";

/**
 * `Link` — a pointer from one `HistoricEntity` to another. PLAN.md §2.6.
 *
 * **Deliberately bare: no kind, no label.** It exists for SQL discovery — backlinks,
 * traversal — rather than for display, and a link table with kinds and labels invites a
 * taxonomy nobody agreed on and a second, competing way of saying what the prose already
 * says. What the reader sees is the chip in the body text; this is how the database finds it.
 *
 * Every reference in an entity's body must be unioned into its link set on save, which is
 * what makes "every photo and story mentioning this person" a query rather than a full-text
 * scan. It is versioned with its parent, because what a version linked to is part of what
 * that version said.
 */
export const link = pgTable(
	"link",
	{
		...contentRowColumns(),

		targetEntityId: uuid()
			.notNull()
			.references(() => entity.id),

		...auditColumns(),
	},
	(table) => [
		index("link_entity_version_idx").on(table.entityId, table.version),
		index("link_proposal_idx").on(table.proposalId),
		// The backlink query reads this one, and it is the reason the table exists. Partial,
		// because that query only ever asks about published content (§5.3).
		index("link_target_idx")
			.on(table.targetEntityId)
			.where(sql`${table.proposalId} IS NULL`),
		// A version links to a target once; saying it twice says nothing more. Two indexes
		// rather than one, because the key differs: a published row is identified by its
		// version, a proposal's by the proposal. Caught on save either way, rather than at
		// the moment a moderator tries to publish.
		uniqueIndex("link_published_unique")
			.on(table.entityId, table.version, table.targetEntityId)
			.where(sql`${table.proposalId} IS NULL`),
		uniqueIndex("link_proposal_unique")
			.on(table.proposalId, table.targetEntityId)
			.where(sql`${table.proposalId} IS NOT NULL`),
		versionOrProposalCheck("link"),
	],
);

import { sql } from "drizzle-orm";
import {
	type AnyPgColumn,
	boolean,
	check,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKeyColumn } from "./columns";
import { entityType, proposalKind, proposalStatus } from "./enums";

/**
 * The entity spine — PLAN.md §2.1, §2.2 and §5.2.
 *
 * The model has four layers (Entity → VersionedEntity → LocalizedEntity → HistoricEntity),
 * but **the spine is one physical table**. Taken literally, loading a Person would join six
 * tables, three of which carry almost nothing: `versioned_entity` would hold one column,
 * `localized_entity` one, and `historic_entity` none at all — links and sources are their
 * own tables keyed by `entity_id`, so it is a pure marker.
 *
 * So `version` and `original_language` are nullable columns here, null for the types that
 * descend from `Entity` directly. That nullability *is* the layer distinction, expressed in
 * table terms. Table-per-type still applies where it earns its keep: the subtypes and their
 * content companions.
 */
export const entity = pgTable(
	"entity",
	{
		id: primaryKeyColumn(),

		type: entityType().notNull(),

		/**
		 * The current published version, or null until the entity is first published.
		 *
		 * Null is the correct initial state and must stay that way: §4.6 #6 lists a create
		 * path that sets this eagerly as a fail-open hazard, because a version pointer is
		 * one of the things a read path may take as evidence that content is public.
		 *
		 * Null for `user`, `thread` and `comment`, which have no versions at all — the plan
		 * calls this column `version` in §5.2 and `published_version` in §4.6; they are the
		 * same column, and it holds the *published* head.
		 */
		version: integer(),

		/**
		 * The language the entity was authored in — the source for auto-translation and the
		 * fallback for display (PLAN.md §2.4). Null for the unversioned, unlocalized types.
		 *
		 * A BCP-47 code in text rather than an enum: languages are peers and the set is not
		 * fixed, so adding one should be data rather than a migration.
		 */
		originalLanguage: text(),

		...auditColumns(),
	},
	(table) => [
		index("entity_type_idx").on(table.type),
		// A versioned type must not be published without a version, and an unversioned type
		// must never acquire one.
		check(
			"entity_published_version_positive",
			sql`${table.version} IS NULL OR ${table.version} >= 1`,
		),
	],
);

/**
 * The audit quartet — PLAN.md §2.2a.
 *
 * **Every mutable row carries it**, not just entities: join tables, role grants and account
 * approvals too, so "who made this person a moderator" and "who approved this account to see
 * people-data" are answerable questions rather than folklore. New tables get it by default.
 *
 * Spread into a table definition with `...auditColumns()`.
 *
 * It lives in this module because it points back at `entity.id`, and the reference is
 * written as a lazy arrow so the entity table can carry its own quartet — the first account
 * is inserted referencing its own id, which a row-level foreign key accepts inside a single
 * statement.
 */
export function auditColumns() {
	return {
		createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		createdBy: uuid()
			.notNull()
			.references((): AnyPgColumn => entity.id),
		updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		updatedBy: uuid()
			.notNull()
			.references((): AnyPgColumn => entity.id),
	};
}

/**
 * An account. Descends from `Entity` directly — identity and audit, no versions.
 *
 * Two flags, independent of each other (PLAN.md §4.4):
 *
 * - `emailVerified` is automatic and gates *contributing*;
 * - `approved` is a manual moderator action and gates *seeing people-data*, because email
 *   verification only proves someone owns an inbox, which is no barrier to a scraper, and
 *   the gated material is exactly the KUG-sensitive content.
 *
 * `approved` defaults to false, and §4.6 #6 names a truthy default as a fail-open hazard.
 */
export const user = pgTable("user", {
	entityId: uuid()
		.primaryKey()
		.references(() => entity.id),

	email: text().notNull().unique(),
	alias: text().notNull(),

	emailVerified: boolean().notNull().default(false),
	approved: boolean().notNull().default(false),

	...auditColumns(),
});

/**
 * A published state — PLAN.md §2.2.
 *
 * Created **at publish time, never at proposal time**. Version numbers are per-entity
 * integers, so `(entity_id, version)` is the natural key and "Version 3" means something to
 * a human reading a citation.
 *
 * `redactionReason` carries the one exceptional case (§2.2a): editing a published version
 * exists for legal redaction — a KUG or Urheberrecht takedown, a DSGVO Art. 17 erasure —
 * because publishing a correction does not help when every prior version still renders the
 * offending content. It must never be the path a normal feature reaches for.
 */
export const entityVersion = pgTable(
	"entity_version",
	{
		entityId: uuid()
			.notNull()
			.references(() => entity.id),
		version: integer().notNull(),

		publishedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		publishedBy: uuid()
			.notNull()
			.references(() => entity.id),

		redactionReason: text(),

		...auditColumns(),
	},
	(table) => [
		primaryKey({ columns: [table.entityId, table.version] }),
		check("entity_version_positive", sql`${table.version} >= 1`),
	],
);

/**
 * A suggested change — PLAN.md §2.2.
 *
 * Content rows for proposals live in the *same tables* as published content, told apart by a
 * nullable `proposal_id`. All four combinations are meaningful:
 *
 * | `proposal_id` | `version` | meaning |
 * | --- | --- | --- |
 * | NULL | 4 | published content of version 4 |
 * | set | NULL | pending proposal |
 * | set | 4 | proposal incorporated into version 4 |
 * | set | NULL + rejected | rejected proposal, kept with its reason |
 *
 * That is what keeps `WHERE proposal_id IS NULL` a *complete* read rule: merging three
 * proposals produces a fresh published row-set, and the three proposals keep their own rows
 * annotated with the version they fed into. A direct edit is simply a version with no
 * proposals pointing at it — derivable, so there is no extra column for it.
 *
 * The type is deliberately **not** duplicated here; it is one join to `entity`.
 */
export const proposal = pgTable(
	"proposal",
	{
		id: primaryKeyColumn(),

		entityId: uuid()
			.notNull()
			.references(() => entity.id),

		kind: proposalKind().notNull(),
		status: proposalStatus().notNull().default("pending"),

		/**
		 * The version the proposer was working from. The moderation UI must flag a proposal
		 * whose `basedOnVersion` is no longer the head and show both diffs — otherwise
		 * publishing a stale proposal silently reverts whatever landed in between (§2.2a).
		 *
		 * Null for a `create`, which is based on nothing.
		 */
		basedOnVersion: integer(),

		/** Set when the proposal is rejected, alongside the moderator who rejected it. */
		rejectionReason: text(),
		moderatorId: uuid().references(() => entity.id),

		/** Which terms the contributor accepted at submission time (PLAN.md §7). */
		termsVersion: integer(),

		...auditColumns(),
	},
	(table) => [
		index("proposal_entity_idx").on(table.entityId),
		index("proposal_status_idx").on(table.status),
		// A rejection without a reason is not a rejection anyone can learn from, and the
		// moderator is the other half of the audit trail.
		check(
			"proposal_rejection_documented",
			sql`(${table.status} <> 'rejected') OR (${table.rejectionReason} IS NOT NULL AND ${table.moderatorId} IS NOT NULL)`,
		),
		// A create proposal is based on nothing; an edit is always based on some version.
		check(
			"proposal_based_on_matches_kind",
			sql`(${table.kind} = 'create') = (${table.basedOnVersion} IS NULL)`,
		),
	],
);

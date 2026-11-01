import { type SQL, sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import {
	daterange,
	regconfig,
	searchVectorExpression,
	tsvector,
} from "./columns";
import {
	auditColumns,
	contentRowColumns,
	versionOrProposalCheck,
} from "./entity";
import { dateGranularity } from "./enums";

/**
 * `Person` — a `HistoricEntity` subtype, and the pattern every other subtype follows.
 *
 * Each subtype is a **pair**: `person` for what does not vary by language, `person_content`
 * for what does, one row per language (PLAN.md §2.4, §5.2). There is deliberately no shared
 * `LocalizedContent` table — Media has a caption, Story a body, Source its citation text, and
 * forcing all of them through one row means columns that are always null for half the types.
 *
 * Both tables carry `version` and `proposal_id`, which is the whole versioning mechanism:
 * proposal rows and published rows live side by side, told apart by `proposal_id IS NULL`.
 */
export const person = pgTable(
	"person",
	{
		...contentRowColumns(),

		/**
		 * A birth happens once, so this is a single rough date: "1890er" is *granularity*,
		 * not an interval (PLAN.md §2.5).
		 */
		born: daterange(),
		bornGranularity: dateGranularity(),

		/**
		 * **Not deceased means living**, not unknown — a deliberate assertion rather than a
		 * gap. It fails in the safe direction for the living-person gate (§4.4): someone whose
		 * death simply has not been researched is treated as alive and therefore gated, so
		 * the error is over-protection and the fix is data entry — work the archive wants
		 * doing anyway. Nothing infers death from age; a moderator records it by hand.
		 *
		 * A flag as well as `died` because a death can be known without its date, and a
		 * decade picked to stand in for "some time" would be invented precision. The check
		 * below stops the two disagreeing: a death date implies deceased.
		 */
		deceased: boolean().notNull().default(false),
		/** Null on a deceased person means the date is unknown — not that they are alive. */
		died: daterange(),
		diedGranularity: dateGranularity(),

		...auditColumns(),
	},
	(table) => [
		// PLAN.md §5.3: a partial index behind every public read path.
		uniqueIndex("person_published_unique")
			.on(table.entityId, table.version)
			.where(sql`${table.proposalId} IS NULL`),
		index("person_entity_version_idx").on(table.entityId, table.version),
		index("person_proposal_idx").on(table.proposalId),
		// The timeline overlaps against these with `&&`.
		index("person_born_idx").using("gist", table.born),
		index("person_died_idx").using("gist", table.died),
		// A granularity without a date, or a date without one, is a half-written value —
		// the rough date is two columns and they are meaningless apart.
		check(
			"person_born_granularity_paired",
			sql`(${table.born} IS NULL) = (${table.bornGranularity} IS NULL)`,
		),
		check(
			"person_died_granularity_paired",
			sql`(${table.died} IS NULL) = (${table.diedGranularity} IS NULL)`,
		),
		check(
			"person_died_implies_deceased",
			sql`${table.died} IS NULL OR ${table.deceased}`,
		),
		// Nobody dies before they are born. Rough spans may touch but must not overlap.
		check(
			"person_died_after_born",
			sql`${table.born} IS NULL OR ${table.died} IS NULL OR upper(${table.born}) <= lower(${table.died})`,
		),
		versionOrProposalCheck("person"),
	],
);

export const personContent = pgTable(
	"person_content",
	{
		...contentRowColumns(),

		/** BCP-47. One row per language; languages are peers (PLAN.md §2.4). */
		language: text().notNull(),

		/**
		 * `name` and `abstract` are carried by **every** `<type>_content` table by
		 * convention — the preview projection (§4.4), the detail page and search all depend
		 * on them being present everywhere. A registry test enforces the convention, since
		 * there is no shared base table to enforce it structurally.
		 */
		name: text().notNull(),
		abstract: text(),
		description: text(),

		/**
		 * Which text-search configuration this row is indexed with (PLAN.md §4.3). Set from
		 * the `TEXT_SEARCH_CONFIG` setting, never hard-coded: full quality where the Hunspell
		 * dictionary exists, graceful degradation to stock `german` where it does not.
		 */
		searchConfig: regconfig().notNull(),
		searchVector: tsvector().generatedAlwaysAs(
			(): SQL =>
				searchVectorExpression(
					personContent.searchConfig,
					personContent.name,
					personContent.abstract,
					personContent.description,
				),
		),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("person_content_published_unique")
			.on(table.entityId, table.version, table.language)
			.where(sql`${table.proposalId} IS NULL`),
		index("person_content_entity_version_idx").on(
			table.entityId,
			table.version,
		),
		index("person_content_proposal_idx").on(table.proposalId),
		index("person_content_search_idx").using("gin", table.searchVector),
		versionOrProposalCheck("person_content"),
	],
);

import { type SQL, sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	daterange,
	extentExpression,
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
 * `Story` — PLAN.md §5.2.
 *
 * The first type to carry a `DateOrInterval` rather than a single date: a story about the
 * war years genuinely occupies a stretch of time, which is what an interval is for. A birth
 * or a shutter firing does not, and "1890er" there is granularity's job (§2.5).
 */
export const story = pgTable(
	"story",
	{
		...contentRowColumns(),

		occurredStart: daterange(),
		occurredStartGranularity: dateGranularity(),
		occurredEnd: daterange(),
		occurredEndGranularity: dateGranularity(),

		/**
		 * The hull of both ends, and what the timeline's `&&` overlap test runs against. A
		 * generated column rather than a written one, so it cannot disagree with the dates
		 * it summarises.
		 */
		occurredExtent: daterange().generatedAlwaysAs(
			(): SQL => extentExpression(story.occurredStart, story.occurredEnd),
		),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("story_published_unique")
			.on(table.entityId, table.version)
			.where(sql`${table.proposalId} IS NULL`),
		index("story_entity_version_idx").on(table.entityId, table.version),
		index("story_proposal_idx").on(table.proposalId),
		index("story_extent_idx").using("gist", table.occurredExtent),
		check(
			"story_occurred_start_granularity_paired",
			sql`(${table.occurredStart} IS NULL) = (${table.occurredStartGranularity} IS NULL)`,
		),
		check(
			"story_occurred_end_granularity_paired",
			sql`(${table.occurredEnd} IS NULL) = (${table.occurredEndGranularity} IS NULL)`,
		),
		// An end with no start is a corrupt value, not an open-ended period (PLAN.md §2.5).
		check(
			"story_occurred_end_needs_start",
			sql`${table.occurredStart} IS NOT NULL OR ${table.occurredEnd} IS NULL`,
		),
		// Rough boundaries must not overlap: "from the 1920s to 1925" is a contradiction.
		check(
			"story_occurred_ordered",
			sql`${table.occurredEnd} IS NULL OR upper(${table.occurredStart}) <= lower(${table.occurredEnd})`,
		),
		versionOrProposalCheck("story"),
	],
);

export const storyContent = pgTable(
	"story_content",
	{
		...contentRowColumns(),

		language: text().notNull(),
		name: text().notNull(),
		abstract: text(),
		/** A story has a body rather than a description — the field a shared content table
		 * would have had nowhere to put (PLAN.md §2.4). */
		body: text(),

		searchConfig: regconfig().notNull(),
		searchVector: tsvector().generatedAlwaysAs(
			(): SQL =>
				searchVectorExpression(
					storyContent.searchConfig,
					storyContent.name,
					storyContent.abstract,
					storyContent.body,
				),
		),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("story_content_published_unique")
			.on(table.entityId, table.version, table.language)
			.where(sql`${table.proposalId} IS NULL`),
		index("story_content_entity_version_idx").on(table.entityId, table.version),
		index("story_content_proposal_idx").on(table.proposalId),
		index("story_content_search_idx").using("gin", table.searchVector),
		versionOrProposalCheck("story_content"),
	],
);

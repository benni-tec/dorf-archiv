import { type SQL, sql } from "drizzle-orm";
import {
	check,
	index,
	pgTable,
	text,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
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
	entity,
	versionOrProposalCheck,
} from "./entity";
import { dateGranularity } from "./enums";

/**
 * `Source` — PLAN.md §2.6, §5.2.
 *
 * Everything assertable is citable: people, places, photographs, stories and the
 * relationships between them carry sources, so a reader can see *why* the archive claims
 * two people married.
 *
 * Modelled as a `HistoricEntity` subtype, which §9 records as **inferred rather than
 * decided** — it may yet turn out to be a plain reusable table.
 */
export const source = pgTable(
	"source",
	{
		...contentRowColumns(),

		/** A signature, an ISBN, an archive reference — whatever identifies the thing itself. */
		identifier: text(),

		/** A church book covers 1850–1900: that is an interval, not a date (PLAN.md §2.5). */
		publishedStart: daterange(),
		publishedStartGranularity: dateGranularity(),
		publishedEnd: daterange(),
		publishedEndGranularity: dateGranularity(),
		publishedExtent: daterange().generatedAlwaysAs(
			(): SQL => extentExpression(source.publishedStart, source.publishedEnd),
		),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("source_published_unique")
			.on(table.entityId, table.version)
			.where(sql`${table.proposalId} IS NULL`),
		index("source_entity_version_idx").on(table.entityId, table.version),
		index("source_proposal_idx").on(table.proposalId),
		index("source_extent_idx").using("gist", table.publishedExtent),
		check(
			"source_published_start_granularity_paired",
			sql`(${table.publishedStart} IS NULL) = (${table.publishedStartGranularity} IS NULL)`,
		),
		check(
			"source_published_end_granularity_paired",
			sql`(${table.publishedEnd} IS NULL) = (${table.publishedEndGranularity} IS NULL)`,
		),
		check(
			"source_published_end_needs_start",
			sql`${table.publishedStart} IS NOT NULL OR ${table.publishedEnd} IS NULL`,
		),
		check(
			"source_published_ordered",
			sql`${table.publishedEnd} IS NULL OR upper(${table.publishedStart}) <= lower(${table.publishedEnd})`,
		),
		versionOrProposalCheck("source"),
	],
);

export const sourceContent = pgTable(
	"source_content",
	{
		...contentRowColumns(),

		language: text().notNull(),
		name: text().notNull(),
		abstract: text(),
		/** The citation as it should be rendered — a field with no home in a generic
		 * name/abstract/description row (PLAN.md §2.4). */
		citationText: text(),

		searchConfig: regconfig().notNull(),
		searchVector: tsvector().generatedAlwaysAs(
			(): SQL =>
				searchVectorExpression(
					sourceContent.searchConfig,
					sourceContent.name,
					sourceContent.abstract,
					sourceContent.citationText,
				),
		),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("source_content_published_unique")
			.on(table.entityId, table.version, table.language)
			.where(sql`${table.proposalId} IS NULL`),
		index("source_content_entity_version_idx").on(
			table.entityId,
			table.version,
		),
		index("source_content_proposal_idx").on(table.proposalId),
		index("source_content_search_idx").using("gin", table.searchVector),
		versionOrProposalCheck("source_content"),
	],
);

/**
 * An entity's citation of a source, with the locator that says *where* in it.
 *
 * Versioned with its parent, like `link`: what a version cites is part of what that version
 * said, so it travels with it rather than floating free.
 */
export const citation = pgTable(
	"citation",
	{
		...contentRowColumns(),

		sourceEntityId: uuid()
			.notNull()
			.references(() => entity.id),

		/** A page, a date, a timestamp — whatever narrows the source to the claim. */
		locator: text(),

		...auditColumns(),
	},
	(table) => [
		index("citation_entity_version_idx").on(table.entityId, table.version),
		index("citation_proposal_idx").on(table.proposalId),
		// The backlink: "what cites this source" — a public read, so partial (§5.3).
		index("citation_source_idx")
			.on(table.sourceEntityId)
			.where(sql`${table.proposalId} IS NULL`),
		uniqueIndex("citation_published_unique")
			.on(table.entityId, table.version, table.sourceEntityId, table.locator)
			.where(sql`${table.proposalId} IS NULL`),
		versionOrProposalCheck("citation"),
	],
);

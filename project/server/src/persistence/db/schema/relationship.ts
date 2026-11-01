import { type SQL, sql } from "drizzle-orm";
import {
	boolean,
	check,
	index,
	pgTable,
	text,
	uniqueIndex,
	uuid,
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
	entity,
	versionOrProposalCheck,
} from "./entity";
import { dateGranularity } from "./enums";

/**
 * `Relationship` — a full entity between exactly two `Person`s, and what the ancestry graph
 * is drawn from (PLAN.md §2.6, §5.2).
 *
 * The opposite of `link`, deliberately: a link is a bare pointer with no kind or label,
 * existing for SQL discovery. A relationship is an assertion about two people that can be
 * dated, cited and argued with, so it is versioned and moderated like any other record.
 */
export const relationship = pgTable(
	"relationship",
	{
		...contentRowColumns(),

		/**
		 * Free text rather than an enum: the plan names the field but not its values, and a
		 * village archive will want kinds nobody listed up front. Adding a constraint later
		 * is a migration either way.
		 */
		kind: text().notNull(),

		/**
		 * Whether the two sides mean different things. "Parent of" is directed and reads
		 * wrongly reversed; "married to" is not.
		 */
		directed: boolean().notNull().default(false),

		personAId: uuid()
			.notNull()
			.references(() => entity.id),
		personBId: uuid()
			.notNull()
			.references(() => entity.id),

		/** Two independent moments, each optional — a marriage may have a start and no end. */
		startedAt: daterange(),
		startedAtGranularity: dateGranularity(),
		endedAt: daterange(),
		endedAtGranularity: dateGranularity(),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("relationship_published_unique")
			.on(table.entityId, table.version)
			.where(sql`${table.proposalId} IS NULL`),
		index("relationship_entity_version_idx").on(table.entityId, table.version),
		index("relationship_proposal_idx").on(table.proposalId),
		// Both directions, because the ancestry view walks from either person.
		index("relationship_person_a_idx").on(table.personAId),
		index("relationship_person_b_idx").on(table.personBId),
		check(
			"relationship_two_people",
			sql`${table.personAId} <> ${table.personBId}`,
		),
		check(
			"relationship_started_granularity_paired",
			sql`(${table.startedAt} IS NULL) = (${table.startedAtGranularity} IS NULL)`,
		),
		check(
			"relationship_ended_granularity_paired",
			sql`(${table.endedAt} IS NULL) = (${table.endedAtGranularity} IS NULL)`,
		),
		check(
			"relationship_ended_after_started",
			sql`${table.startedAt} IS NULL OR ${table.endedAt} IS NULL OR upper(${table.startedAt}) <= lower(${table.endedAt})`,
		),
		versionOrProposalCheck("relationship"),
	],
);

export const relationshipContent = pgTable(
	"relationship_content",
	{
		...contentRowColumns(),

		language: text().notNull(),
		name: text().notNull(),
		abstract: text(),
		description: text(),

		searchConfig: regconfig().notNull(),
		searchVector: tsvector().generatedAlwaysAs(
			(): SQL =>
				searchVectorExpression(
					relationshipContent.searchConfig,
					relationshipContent.name,
					relationshipContent.abstract,
					relationshipContent.description,
				),
		),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("relationship_content_published_unique")
			.on(table.entityId, table.version, table.language)
			.where(sql`${table.proposalId} IS NULL`),
		index("relationship_content_entity_version_idx").on(
			table.entityId,
			table.version,
		),
		index("relationship_content_proposal_idx").on(table.proposalId),
		index("relationship_content_search_idx").using("gin", table.searchVector),
		versionOrProposalCheck("relationship_content"),
	],
);

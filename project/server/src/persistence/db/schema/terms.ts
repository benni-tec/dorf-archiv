import { type SQL, sql } from "drizzle-orm";
import {
	date,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { regconfig, searchVectorExpression, tsvector } from "./columns";
import {
	auditColumns,
	contentRowColumns,
	entity,
	user,
	versionOrProposalCheck,
} from "./entity";

/**
 * `TermsAndConditions` — a `LocalizedEntity` (PLAN.md §2.1, §7).
 *
 * Versioned like everything else, because which terms a contributor accepted is a question
 * the archive must be able to answer years later.
 */
export const terms = pgTable(
	"terms",
	{
		...contentRowColumns(),

		/**
		 * A **`CalendarDate`**, not the project's rough `Date` — an exact SQL `date`. This is
		 * legal rather than archival: it is not "about 1920", it is the day these terms came
		 * into force, and the naming keeps the two from being confused (PLAN.md §2.5).
		 */
		effectiveFrom: date().notNull(),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("terms_published_unique")
			.on(table.entityId, table.version)
			.where(sql`${table.proposalId} IS NULL`),
		index("terms_entity_version_idx").on(table.entityId, table.version),
		index("terms_proposal_idx").on(table.proposalId),
		// "Which terms were in force on this date" is the query this exists for.
		index("terms_effective_from_idx").on(table.effectiveFrom),
		versionOrProposalCheck("terms"),
	],
);

export const termsContent = pgTable(
	"terms_content",
	{
		...contentRowColumns(),

		language: text().notNull(),
		name: text().notNull(),
		abstract: text(),
		body: text(),

		searchConfig: regconfig().notNull(),
		searchVector: tsvector().generatedAlwaysAs(
			(): SQL =>
				searchVectorExpression(
					termsContent.searchConfig,
					termsContent.name,
					termsContent.abstract,
					termsContent.body,
				),
		),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("terms_content_published_unique")
			.on(table.entityId, table.version, table.language)
			.where(sql`${table.proposalId} IS NULL`),
		index("terms_content_entity_version_idx").on(table.entityId, table.version),
		index("terms_content_proposal_idx").on(table.proposalId),
		index("terms_content_search_idx").using("gin", table.searchVector),
		versionOrProposalCheck("terms_content"),
	],
);

/**
 * Who accepted which version of the terms, and when.
 *
 * Not versioned: an acceptance is an event, not a record with revisions. It names the terms
 * *version* rather than the terms entity, because "they agreed to something called the
 * terms" is not an answer anyone can rely on.
 */
export const termsAcceptance = pgTable(
	"terms_acceptance",
	{
		userId: uuid()
			.notNull()
			.references(() => user.entityId),
		termsEntityId: uuid()
			.notNull()
			.references(() => entity.id),
		termsVersion: integer().notNull(),

		acceptedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("terms_acceptance_unique").on(
			table.userId,
			table.termsEntityId,
			table.termsVersion,
		),
		index("terms_acceptance_user_idx").on(table.userId),
	],
);

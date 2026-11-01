import { type SQL, sql } from "drizzle-orm";
import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { regconfig, searchVectorExpression, tsvector } from "./columns";
import {
	auditColumns,
	contentRowColumns,
	entity,
	versionOrProposalCheck,
} from "./entity";

/**
 * `Tag` — a `LocalizedEntity`, but not a `HistoricEntity`: it is vocabulary, not a record
 * about the village, so it carries no links, sources or discussion (PLAN.md §2.1).
 *
 * **No columns of its own.** The label lives in `tag_content`, and a tag is addressed by its
 * entity id like everything else. It used to carry a `slug`, unique across published rows —
 * which made a tag's second version collide with its first, so a tag could only ever be
 * published once. Readable URLs, if wanted, belong in an unversioned alias table (§5.2).
 * The row stays, because every type has one and the registry depends on it.
 */
export const tag = pgTable(
	"tag",
	{
		...contentRowColumns(),
		...auditColumns(),
	},
	(table) => [
		uniqueIndex("tag_published_unique")
			.on(table.entityId, table.version)
			.where(sql`${table.proposalId} IS NULL`),
		index("tag_entity_version_idx").on(table.entityId, table.version),
		index("tag_proposal_idx").on(table.proposalId),
		versionOrProposalCheck("tag"),
	],
);

/**
 * A tag's label, per language. **No description**: a tag is a label, and giving it prose
 * invites it to become a record of its own (PLAN.md §2.4).
 */
export const tagContent = pgTable(
	"tag_content",
	{
		...contentRowColumns(),

		language: text().notNull(),
		name: text().notNull(),
		abstract: text(),

		searchConfig: regconfig().notNull(),
		searchVector: tsvector().generatedAlwaysAs(
			(): SQL =>
				searchVectorExpression(
					tagContent.searchConfig,
					tagContent.name,
					tagContent.abstract,
				),
		),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("tag_content_published_unique")
			.on(table.entityId, table.version, table.language)
			.where(sql`${table.proposalId} IS NULL`),
		index("tag_content_entity_version_idx").on(table.entityId, table.version),
		index("tag_content_proposal_idx").on(table.proposalId),
		index("tag_content_search_idx").using("gin", table.searchVector),
		versionOrProposalCheck("tag_content"),
	],
);

/**
 * Which tags an entity version carries.
 *
 * One of the reference kinds the publish closure invariant covers (§2.3): published content
 * may only reference published content, tags included.
 */
export const entityTag = pgTable(
	"entity_tag",
	{
		...contentRowColumns(),

		tagEntityId: uuid()
			.notNull()
			.references(() => entity.id),

		...auditColumns(),
	},
	(table) => [
		index("entity_tag_entity_version_idx").on(table.entityId, table.version),
		index("entity_tag_proposal_idx").on(table.proposalId),
		// The index behind "everything tagged Feuerwehr" — a public read, so partial (§5.3).
		index("entity_tag_tag_idx")
			.on(table.tagEntityId)
			.where(sql`${table.proposalId} IS NULL`),
		uniqueIndex("entity_tag_published_unique")
			.on(table.entityId, table.version, table.tagEntityId)
			.where(sql`${table.proposalId} IS NULL`),
		uniqueIndex("entity_tag_proposal_unique")
			.on(table.proposalId, table.tagEntityId)
			.where(sql`${table.proposalId} IS NOT NULL`),
		versionOrProposalCheck("entity_tag"),
	],
);

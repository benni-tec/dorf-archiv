import { type SQL, sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	doublePrecision,
	index,
	integer,
	pgTable,
	text,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import {
	daterange,
	primaryKeyColumn,
	regconfig,
	searchVectorExpression,
	tsvector,
} from "./columns";
import {
	auditColumns,
	contentRowColumns,
	versionOrProposalCheck,
} from "./entity";
import { dateGranularity, mediaFileRole } from "./enums";

/**
 * Binary assets — PLAN.md §2.7.
 *
 * **Immutable, and not an entity.** A version references assets, so cropping or adding a
 * file produces a new version without mutating stored bytes, and originals are never
 * overwritten. That is what makes "show me version 3 as it was" answerable at all.
 *
 * The audit quartet is here because every mutable row carries it (§2.2a) — but nothing
 * should ever update one of these rows except a redaction.
 */
export const asset = pgTable(
	"asset",
	{
		id: primaryKeyColumn(),

		/**
		 * The object key in the bucket. Unguessable, because the bucket is private and
		 * unpublished blobs sit in storage from the moment of upload (§4.6 #3) — a guessable
		 * key would bypass moderation as effectively as a public bucket policy.
		 */
		storageKey: text().notNull().unique(),

		sha256: text().notNull(),
		mimeType: text().notNull(),
		byteSize: bigint({ mode: "number" }).notNull(),

		/** Null for formats without intrinsic dimensions. */
		width: integer(),
		height: integer(),

		...auditColumns(),
	},
	(table) => [
		// Two uploads of the same bytes are the same asset; this is what makes that visible.
		index("asset_sha256_idx").on(table.sha256),
	],
);

/**
 * `Media` — one artifact with 1..n files.
 *
 * The back of a photograph with a handwritten date is the *same* artifact, not a separate
 * record; forty photos from one album are forty records, because each is independently
 * datable, placeable and citable.
 */
export const media = pgTable(
	"media",
	{
		...contentRowColumns(),

		/** The shutter fired once, so a single rough date (PLAN.md §2.5). */
		captured: daterange(),
		capturedGranularity: dateGranularity(),

		/**
		 * Ad-hoc coordinates for when no Place exists — "the field behind the mill" (§2.7).
		 * The moderation queue offers "promote to a Place", and the viewport query unions
		 * both sources. Forcing every contributor to invent a Place first would block uploads
		 * on a taxonomy they do not have.
		 */
		latitude: doublePrecision(),
		longitude: doublePrecision(),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("media_published_unique")
			.on(table.entityId, table.version)
			.where(sql`${table.proposalId} IS NULL`),
		index("media_entity_version_idx").on(table.entityId, table.version),
		index("media_proposal_idx").on(table.proposalId),
		index("media_captured_idx").using("gist", table.captured),
		index("media_point_idx").on(table.latitude, table.longitude),
		check(
			"media_captured_granularity_paired",
			sql`(${table.captured} IS NULL) = (${table.capturedGranularity} IS NULL)`,
		),
		check(
			"media_point_paired",
			sql`(${table.latitude} IS NULL) = (${table.longitude} IS NULL)`,
		),
		versionOrProposalCheck("media"),
	],
);

export const mediaContent = pgTable(
	"media_content",
	{
		...contentRowColumns(),

		language: text().notNull(),
		name: text().notNull(),
		abstract: text(),
		description: text(),
		/** What is written on or about the image — one of the fields a shared content table
		 * would have had nowhere to put (PLAN.md §2.4). */
		caption: text(),

		searchConfig: regconfig().notNull(),
		searchVector: tsvector().generatedAlwaysAs(
			(): SQL =>
				searchVectorExpression(
					mediaContent.searchConfig,
					mediaContent.name,
					mediaContent.abstract,
					mediaContent.caption,
				),
		),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("media_content_published_unique")
			.on(table.entityId, table.version, table.language)
			.where(sql`${table.proposalId} IS NULL`),
		index("media_content_entity_version_idx").on(table.entityId, table.version),
		index("media_content_proposal_idx").on(table.proposalId),
		index("media_content_search_idx").using("gin", table.searchVector),
		versionOrProposalCheck("media_content"),
	],
);

/** Which files make up a Media version, and in what order. */
export const mediaFile = pgTable(
	"media_file",
	{
		...contentRowColumns(),

		assetId: uuid()
			.notNull()
			.references(() => asset.id),

		role: mediaFileRole().notNull(),
		/** Exactly one file per version is the one shown in a list or a map popup. */
		isPrimary: boolean().notNull().default(false),
		sortOrder: integer().notNull().default(0),

		...auditColumns(),
	},
	(table) => [
		index("media_file_entity_version_idx").on(table.entityId, table.version),
		index("media_file_proposal_idx").on(table.proposalId),
		index("media_file_asset_idx")
			.on(table.assetId)
			.where(sql`${table.proposalId} IS NULL`),
		// One primary per published version. Partial, so proposals may each have their own.
		uniqueIndex("media_file_one_primary")
			.on(table.entityId, table.version)
			.where(sql`${table.proposalId} IS NULL AND ${table.isPrimary}`),
		versionOrProposalCheck("media_file"),
	],
);

import { type SQL, sql } from "drizzle-orm";
import {
	check,
	doublePrecision,
	index,
	jsonb,
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
 * `Place` — PLAN.md §2.7.
 *
 * A place is a point **or an area**, because a pin can sit at a position *within* one, and
 * because the map is the Places index rather than a decoration on it.
 *
 * Geometry is stored as plain columns and GeoJSON rather than PostGIS: §4.1 says to assume
 * nothing about which extensions a host has installed, and a bounding box plus a point is
 * all the viewport query needs.
 */
export const place = pgTable(
	"place",
	{
		...contentRowColumns(),

		latitude: doublePrecision(),
		longitude: doublePrecision(),

		/** GeoJSON, for places that are an area rather than a point. */
		area: jsonb(),

		/**
		 * The area's bounding box, derived rather than declared — the domain layer computes
		 * it when the area is written, because deriving it in SQL would mean parsing GeoJSON
		 * without PostGIS. It exists for the indexed viewport query and nothing else, so it
		 * must never be read as if it were the geometry.
		 */
		minLatitude: doublePrecision(),
		maxLatitude: doublePrecision(),
		minLongitude: doublePrecision(),
		maxLongitude: doublePrecision(),

		/**
		 * Two independent optional dates rather than one interval (PLAN.md §2.5): "from 1850,
		 * still standing" is not a point, not a closed interval, and under `DateOrInterval` an
		 * absent end would mean *"this is a point"* — the opposite of what validity needs.
		 * Kept apart, all four states are distinguishable: unknown, open-ended, open-started
		 * and closed. House numbers get reused and renumbered, which is exactly what a map
		 * tied to a timeline exists to show.
		 */
		validFrom: daterange(),
		validFromGranularity: dateGranularity(),
		validUntil: daterange(),
		validUntilGranularity: dateGranularity(),

		/**
		 * What the timeline's `&&` overlap test runs against (PLAN.md §2.5).
		 *
		 * Unbounded where an end is missing, which is the whole point: a building that still
		 * stands has no upper bound, and one whose beginning nobody recorded has no lower one.
		 * With both absent this is `(,)` — every date — which is the honest answer for a place
		 * whose validity is entirely unknown, and keeps it in every timeline window rather than
		 * none.
		 */
		validityExtent: daterange().generatedAlwaysAs(
			(): SQL =>
				sql`daterange(lower(${place.validFrom}), upper(${place.validUntil}))`,
		),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("place_published_unique")
			.on(table.entityId, table.version)
			.where(sql`${table.proposalId} IS NULL`),
		index("place_entity_version_idx").on(table.entityId, table.version),
		index("place_proposal_idx").on(table.proposalId),
		// The viewport query: a box test against these.
		index("place_bbox_idx").on(
			table.minLatitude,
			table.maxLatitude,
			table.minLongitude,
			table.maxLongitude,
		),
		index("place_point_idx").on(table.latitude, table.longitude),
		index("place_validity_idx").using("gist", table.validityExtent),
		check(
			"place_valid_from_granularity_paired",
			sql`(${table.validFrom} IS NULL) = (${table.validFromGranularity} IS NULL)`,
		),
		check(
			"place_valid_until_granularity_paired",
			sql`(${table.validUntil} IS NULL) = (${table.validUntilGranularity} IS NULL)`,
		),
		// The non-overlap rule applies *between* the two fields here rather than inside one
		// embedded value, since they are two loose dates (PLAN.md §2.5).
		check(
			"place_valid_until_after_from",
			sql`${table.validFrom} IS NULL OR ${table.validUntil} IS NULL OR upper(${table.validFrom}) <= lower(${table.validUntil})`,
		),
		check(
			"place_point_paired",
			sql`(${table.latitude} IS NULL) = (${table.longitude} IS NULL)`,
		),
		versionOrProposalCheck("place"),
	],
);

export const placeContent = pgTable(
	"place_content",
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
					placeContent.searchConfig,
					placeContent.name,
					placeContent.abstract,
					placeContent.description,
				),
		),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("place_content_published_unique")
			.on(table.entityId, table.version, table.language)
			.where(sql`${table.proposalId} IS NULL`),
		index("place_content_entity_version_idx").on(table.entityId, table.version),
		index("place_content_proposal_idx").on(table.proposalId),
		index("place_content_search_idx").using("gin", table.searchVector),
		versionOrProposalCheck("place_content"),
	],
);

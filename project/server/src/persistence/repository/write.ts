import { and, getTableName, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { type DateOrInterval, isUuid } from "shared";
import { requireAccountId } from "../../domain/actor";
import type { Draft, DraftOf, Point, VersionedType } from "../../domain/entity";
import type { ProposeDependencies } from "../../domain/proposing";
import { encodeRoughDate } from "../db/rough-date-range";
import {
	citation,
	entity,
	entityTag,
	media,
	mediaContent,
	mediaFile,
	person,
	personContent,
	place,
	placeContent,
	proposal,
	relationship,
	relationshipContent,
	source,
	sourceContent,
	story,
	storyContent,
	tag,
	tagContent,
	terms,
	termsContent,
} from "../db/schema";
import { VERSIONED_CONTENT_TABLES } from "../db/schema/registry";
import { deriveLinks } from "./state";

/**
 * Writing proposals — the repository half of `domain/proposing.ts`.
 *
 * `WRITERS` is the mirror of `read.ts`'s `READERS`: one entry per type, turning the domain
 * shape back into the type's row and its content rows. They are kept as each other's inverse
 * by a round-trip test per type against a live database, which is what catches a field read
 * but never written, or written to the wrong column.
 */

type Database = PostgresJsDatabase<Record<string, unknown>>;

/** A rough date as the two columns it occupies, under the given column-name prefix. */
function roughColumns<Prefix extends string>(
	prefix: Prefix,
	date: Parameters<typeof encodeRoughDate>[0],
) {
	const { range, granularity } = encodeRoughDate(date);
	return {
		[prefix]: range,
		[`${prefix}Granularity`]: granularity,
	} as Record<Prefix | `${Prefix}Granularity`, string | null>;
}

function intervalColumns<Start extends string, End extends string>(
	start: Start,
	end: End,
	value: DateOrInterval | null,
) {
	return {
		...roughColumns(start, value?.start ?? null),
		...roughColumns(end, value?.end ?? null),
	};
}

const pointColumns = (point: Point | null) => ({
	latitude: point?.latitude ?? null,
	longitude: point?.longitude ?? null,
});

/**
 * The bounding box of a GeoJSON geometry — the derived columns `place` keeps for the
 * viewport query (§5.3). Computed here because there is no PostGIS to compute it (§4.1).
 */
export function boundingBox(geometry: unknown) {
	const longitudes: number[] = [];
	const latitudes: number[] = [];
	const walk = (value: unknown): void => {
		if (!Array.isArray(value)) return;
		if (
			value.length >= 2 &&
			typeof value[0] === "number" &&
			typeof value[1] === "number"
		) {
			longitudes.push(value[0]);
			latitudes.push(value[1]);
			return;
		}
		for (const inner of value) walk(inner);
	};
	const coordinates = (geometry as { coordinates?: unknown } | null)
		?.coordinates;
	walk(coordinates);

	if (longitudes.length === 0) {
		return {
			minLatitude: null,
			maxLatitude: null,
			minLongitude: null,
			maxLongitude: null,
		};
	}
	return {
		minLatitude: Math.min(...latitudes),
		maxLatitude: Math.max(...latitudes),
		minLongitude: Math.min(...longitudes),
		maxLongitude: Math.max(...longitudes),
	};
}

type Writer<Type extends VersionedType> = {
	table: PgTable;
	contentTable: PgTable;
	fields: (fields: DraftOf<Type>["fields"]) => Record<string, unknown>;
	content: (row: DraftOf<Type>["content"][number]) => Record<string, unknown>;
};

export const WRITERS: { [Type in VersionedType]: Writer<Type> } = {
	person: {
		table: person,
		contentTable: personContent,
		fields: (fields) => ({
			...roughColumns("born", fields.born),
			// Not deceased means living (§4.4); "unknown" is a death without its date.
			deceased: fields.died !== null,
			...roughColumns("died", fields.died === "unknown" ? null : fields.died),
		}),
		content: (row) => ({ description: row.description }),
	},
	place: {
		table: place,
		contentTable: placeContent,
		fields: (fields) => ({
			...pointColumns(fields.point),
			area: fields.area ?? null,
			...boundingBox(fields.area),
			...roughColumns("validFrom", fields.validFrom),
			...roughColumns("validUntil", fields.validUntil),
		}),
		content: (row) => ({ description: row.description }),
	},
	media: {
		table: media,
		contentTable: mediaContent,
		fields: (fields) => ({
			...roughColumns("captured", fields.captured),
			...pointColumns(fields.point),
		}),
		content: (row) => ({ description: row.description, caption: row.caption }),
	},
	story: {
		table: story,
		contentTable: storyContent,
		fields: (fields) =>
			intervalColumns("occurredStart", "occurredEnd", fields.occurred),
		content: (row) => ({ body: row.body }),
	},
	relationship: {
		table: relationship,
		contentTable: relationshipContent,
		fields: (fields) => ({
			kind: fields.kind,
			directed: fields.directed,
			personAId: fields.personA,
			personBId: fields.personB,
			...roughColumns("startedAt", fields.start),
			...roughColumns("endedAt", fields.end),
		}),
		content: (row) => ({ description: row.description }),
	},
	source: {
		table: source,
		contentTable: sourceContent,
		fields: (fields) => ({
			identifier: fields.identifier,
			...intervalColumns("publishedStart", "publishedEnd", fields.published),
		}),
		content: (row) => ({ citationText: row.citationText }),
	},
	tag: {
		table: tag,
		contentTable: tagContent,
		fields: () => ({}),
		content: () => ({}),
	},
	terms: {
		table: terms,
		contentTable: termsContent,
		fields: (fields) => ({ effectiveFrom: fields.effectiveFrom }),
		content: (row) => ({ body: row.body }),
	},
};

/**
 * Replaces every row a proposal holds with the draft's — its own row, its languages, its
 * tags, citations and files — and derives its link set from the bodies (§2.6).
 *
 * Replacing rather than updating in place is what "a proposal is a complete state" means for
 * storage: there is no way for a row the draft no longer has to survive.
 */
async function writeDraft(
	db: Database,
	entityId: string,
	proposalId: string,
	draft: Draft,
	authorId: string,
	actorId: string,
	searchConfig: string,
): Promise<void> {
	for (const table of VERSIONED_CONTENT_TABLES) {
		await db.execute(
			sql`DELETE FROM ${sql.identifier(getTableName(table))} WHERE proposal_id = ${proposalId}`,
		);
	}

	const writer = WRITERS[draft.type] as Writer<VersionedType>;

	// Spread **last**, on every row, so nothing that came from the client can override it: a
	// draft object carrying `proposalId: null, version: 1` would otherwise write straight into
	// a published version, unmoderated. Every other value is picked by name for the same
	// reason — no row here is built by spreading a client object.
	//
	// `createdBy` is the author of the words, which a moderator adjusting the proposal does
	// not become (§2.2a); `updatedBy` is whoever wrote this state of it.
	const owned = {
		entityId,
		proposalId,
		version: null,
		createdBy: authorId,
		updatedBy: actorId,
	};

	await db
		.insert(writer.table)
		.values({ ...writer.fields(draft.fields as never), ...owned } as never);

	for (const row of draft.content) {
		await db.insert(writer.contentTable).values({
			...writer.content(row as never),
			language: row.language,
			name: row.name,
			abstract: row.abstract,
			searchConfig,
			...owned,
		} as never);
	}

	for (const tagEntityId of draft.tags) {
		await db.insert(entityTag).values({ tagEntityId, ...owned });
	}
	for (const cited of draft.citations) {
		await db.insert(citation).values({
			sourceEntityId: cited.sourceEntityId,
			locator: cited.locator,
			...owned,
		});
	}
	if ("files" in draft) {
		for (const file of draft.files) {
			await db.insert(mediaFile).values({
				assetId: file.assetId,
				role: file.role,
				isPrimary: file.isPrimary,
				sortOrder: file.sortOrder,
				...owned,
			});
		}
	}

	await deriveLinks(db, entityId, { kind: "proposal", proposalId }, actorId);
}

/**
 * Builds the dependency set the proposing service needs.
 *
 * `searchConfig` is the `TEXT_SEARCH_CONFIG` setting (§4.3), recorded on every content row so
 * its search vector is built with the configuration the server is running with.
 *
 * Pass a transaction-scoped `db`: a proposal is several rows.
 */
export function proposeDependencies(
	db: Database,
	options: { searchConfig: string },
): ProposeDependencies {
	return {
		findEntity: async (entityId) => {
			// Not an id at all reads as no such entity, rather than as a failed cast.
			if (!isUuid(entityId)) return null;
			const [row] = await db
				.select({ type: entity.type, head: entity.version })
				.from(entity)
				.where(sql`${entity.id} = ${entityId}`);
			if (!row || !Object.hasOwn(WRITERS, row.type)) return null;
			return { type: row.type as VersionedType, head: row.head };
		},

		languagesOf: async (entityId, type, version) => {
			const table = WRITERS[type].contentTable;
			const rows = await db.execute<{ language: string }>(sql`
				SELECT language FROM ${sql.identifier(getTableName(table))}
				WHERE entity_id = ${entityId} AND version = ${version} AND proposal_id IS NULL
			`);
			return rows.map((row) => row.language);
		},

		referenceable: async (ids, accounts) => {
			// Published, or an unpublished entry of the author's or editor's own — never
			// somebody else's unpublished one, whose existence is not theirs to learn.
			const rows = await db
				.select({ id: entity.id, type: entity.type })
				.from(entity)
				.where(
					and(
						inArray(entity.id, [...ids]),
						or(
							isNotNull(entity.version),
							inArray(entity.createdBy, [...accounts]),
						),
					),
				);
			return new Map(rows.map((row) => [row.id, row.type]));
		},

		usableAssets: async (assetIds, entityId, accounts) => {
			const rows = await db.execute<{ id: string }>(sql`
				SELECT a.id FROM asset a
				WHERE a.id IN ${sql`(${sql.join(
					assetIds.map((id) => sql`${id}::uuid`),
					sql`, `,
				)})`}
				  AND (
				    a.created_by IN ${sql`(${sql.join(
							accounts.map((id) => sql`${id}::uuid`),
							sql`, `,
						)})`}
				    OR EXISTS (
				      SELECT 1 FROM media_file f
				      WHERE f.asset_id = a.id
				        AND f.entity_id = ${entityId}
				        AND f.proposal_id IS NULL
				    )
				  )
			`);
			return new Set(rows.map((row) => row.id));
		},

		createEntity: async (type, originalLanguage, actor) => {
			const actorId = requireAccountId(actor, "propose");
			// `version` stays null: an entity is created unpublished (§4.6 #6).
			const [row] = await db
				.insert(entity)
				.values({
					type,
					originalLanguage,
					createdBy: actorId,
					updatedBy: actorId,
				})
				.returning({ id: entity.id });
			if (!row) throw new Error("Creating the entity returned no row.");
			return row.id;
		},

		createProposal: async (entityId, basedOnVersion, actor) => {
			const actorId = requireAccountId(actor, "propose");
			const [row] = await db
				.insert(proposal)
				.values({
					entityId,
					basedOnVersion,
					createdBy: actorId,
					updatedBy: actorId,
				})
				.returning({ id: proposal.id });
			if (!row) throw new Error("Creating the proposal returned no row.");
			return row.id;
		},

		loadProposal: async (proposalId) => {
			if (!isUuid(proposalId)) return null;
			const [row] = await db
				.select({
					entityId: proposal.entityId,
					type: entity.type,
					originalLanguage: entity.originalLanguage,
					status: proposal.status,
					basedOnVersion: proposal.basedOnVersion,
					proposedBy: proposal.createdBy,
				})
				.from(proposal)
				.innerJoin(entity, sql`${entity.id} = ${proposal.entityId}`)
				.where(sql`${proposal.id} = ${proposalId}`)
				.for("update", { of: proposal });
			if (!row || !Object.hasOwn(WRITERS, row.type)) return null;
			return {
				...row,
				type: row.type as VersionedType,
				originalLanguage: row.originalLanguage ?? "",
			};
		},

		writeDraft: (entityId, proposalId, draft, authorId, actor) =>
			writeDraft(
				db,
				entityId,
				proposalId,
				draft,
				authorId,
				requireAccountId(actor, "propose"),
				options.searchConfig,
			),

		rebase: async (proposalId, version, actor) => {
			const actorId = requireAccountId(actor, "rebase a proposal");
			await db
				.update(proposal)
				.set({
					basedOnVersion: version,
					updatedAt: sql`now()`,
					updatedBy: actorId,
				})
				.where(sql`${proposal.id} = ${proposalId}`);
		},
	};
}

import { and, asc, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { isUuid } from "shared";
import { type Actor, can } from "../../domain/actor";
import type {
	Backlink,
	ContentBase,
	ProposedEntity,
	PublishedEntity,
	QueuedProposal,
	References,
	VersionedType,
	VersionSummary,
} from "../../domain/entity";
import { decodeDateOrInterval, decodeRoughDate } from "../db/rough-date-range";
import {
	citation,
	entity,
	entityTag,
	entityVersion,
	link,
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
import { assertPublishedRows } from "./mapper";
import { publishedOnly } from "./scope";

/**
 * Reading published entities — PLAN.md §5.1's `findPublished`, `findVersion`, `history`, and
 * the backlinks of §2.6.
 *
 * **Every read takes an actor**, and there is no unscoped variant to reach for: anonymous is
 * an actor holding the public role set, never the absence of one. Every row these functions
 * return has been constrained with `publishedOnly` *and* passed through `assertPublished`, so
 * a mistake in one is caught by the other rather than reaching a caller (§4.6 #1).
 *
 * Whether the actor may see a type at all — `<type>:view` against `<type>:preview` — is the
 * controller's question (§4.4); these answer which *rows* are readable, and for published
 * content that is the same set for every actor. The actor is required anyway, so that the
 * day a read does depend on who is asking, no caller has to be found and changed.
 */

type Database = PostgresJsDatabase<Record<string, unknown>>;

/** The columns every content table shares, enough to scope and order a read. */
type ContentColumns = {
	entityId: PgColumn;
	version: PgColumn;
	proposalId: PgColumn;
	createdBy: PgColumn;
};

/**
 * How one type is read: its two tables, and how a row of each becomes the domain shape.
 *
 * One entry per registered versioned type. `read.test.ts` checks this against
 * `ENTITY_REGISTRY`, so a new type with no reader fails a test rather than a request.
 */
type Reader = {
	table: PgTable & ContentColumns;
	contentTable: PgTable & ContentColumns & { language: PgColumn };
	// biome-ignore lint/suspicious/noExplicitAny: each reader narrows its own row type.
	fields: (row: any) => unknown;
	// biome-ignore lint/suspicious/noExplicitAny: as above.
	content: (row: any) => Record<string, unknown>;
};

type MediaFileRow = typeof mediaFile.$inferSelect;

const point = (latitude: number | null, longitude: number | null) =>
	latitude === null || longitude === null ? null : { latitude, longitude };

export const READERS: Record<VersionedType, Reader> = {
	person: {
		table: person,
		contentTable: personContent,
		fields: (row: typeof person.$inferSelect) => ({
			born: decodeRoughDate(row.born, row.bornGranularity),
			died: row.deceased
				? (decodeRoughDate(row.died, row.diedGranularity) ?? "unknown")
				: null,
		}),
		content: (row: typeof personContent.$inferSelect) => ({
			description: row.description,
		}),
	},
	place: {
		table: place,
		contentTable: placeContent,
		fields: (row: typeof place.$inferSelect) => ({
			point: point(row.latitude, row.longitude),
			area: row.area ?? null,
			validFrom: decodeRoughDate(row.validFrom, row.validFromGranularity),
			validUntil: decodeRoughDate(row.validUntil, row.validUntilGranularity),
		}),
		content: (row: typeof placeContent.$inferSelect) => ({
			description: row.description,
		}),
	},
	media: {
		table: media,
		contentTable: mediaContent,
		fields: (row: typeof media.$inferSelect) => ({
			captured: decodeRoughDate(row.captured, row.capturedGranularity),
			point: point(row.latitude, row.longitude),
		}),
		content: (row: typeof mediaContent.$inferSelect) => ({
			description: row.description,
			caption: row.caption,
		}),
	},
	story: {
		table: story,
		contentTable: storyContent,
		fields: (row: typeof story.$inferSelect) => ({
			occurred: decodeDateOrInterval(
				row.occurredStart,
				row.occurredStartGranularity,
				row.occurredEnd,
				row.occurredEndGranularity,
			),
		}),
		content: (row: typeof storyContent.$inferSelect) => ({ body: row.body }),
	},
	relationship: {
		table: relationship,
		contentTable: relationshipContent,
		fields: (row: typeof relationship.$inferSelect) => ({
			kind: row.kind,
			directed: row.directed,
			personA: row.personAId,
			personB: row.personBId,
			start: decodeRoughDate(row.startedAt, row.startedAtGranularity),
			end: decodeRoughDate(row.endedAt, row.endedAtGranularity),
		}),
		content: (row: typeof relationshipContent.$inferSelect) => ({
			description: row.description,
		}),
	},
	source: {
		table: source,
		contentTable: sourceContent,
		fields: (row: typeof source.$inferSelect) => ({
			identifier: row.identifier,
			published: decodeDateOrInterval(
				row.publishedStart,
				row.publishedStartGranularity,
				row.publishedEnd,
				row.publishedEndGranularity,
			),
		}),
		content: (row: typeof sourceContent.$inferSelect) => ({
			citationText: row.citationText,
		}),
	},
	tag: {
		table: tag,
		contentTable: tagContent,
		fields: () => ({}),
		// A tag is a label: name only (§2.1).
		content: () => ({}),
	},
	terms: {
		table: terms,
		contentTable: termsContent,
		fields: (row: typeof terms.$inferSelect) => ({
			effectiveFrom: row.effectiveFrom,
		}),
		content: (row: typeof termsContent.$inferSelect) => ({ body: row.body }),
	},
};

const isVersionedType = (type: string): type is VersionedType =>
	Object.hasOwn(READERS, type);

/**
 * Which rows a read covers: one published version, or one proposal's own rows.
 *
 * The two are kept as distinct cases rather than a flag, because they are checked
 * differently on the way out: published rows go through `assertPublished`, and proposal rows
 * must *not* (§4.4) — they are checked instead to belong to the proposal that was asked for.
 */
type RowScope =
	| { kind: "published"; entityId: string; version: number }
	| { kind: "proposal"; entityId: string; proposalId: string };

function scoped(table: ContentColumns, scope: RowScope): SQL {
	if (scope.kind === "published") {
		return and(
			eq(table.entityId, scope.entityId),
			eq(table.version, scope.version),
			publishedOnly(table),
		) as SQL;
	}

	return and(
		eq(table.entityId, scope.entityId),
		eq(table.proposalId, scope.proposalId),
	) as SQL;
}

class ScopeMismatchError extends Error {
	constructor() {
		super("A proposal read returned a row belonging to something else.");
		this.name = "ScopeMismatchError";
	}
}

/** The belt to `scoped`'s braces, for whichever kind of read this is. */
function checked<Row extends { proposalId?: string | null }>(
	rows: Row[],
	scope: RowScope,
): Row[] {
	if (scope.kind === "published") return assertPublishedRows(rows);

	for (const row of rows) {
		if (row.proposalId !== scope.proposalId) throw new ScopeMismatchError();
	}
	return rows;
}

async function readReferences(
	db: Database,
	scope: RowScope,
): Promise<References> {
	const [links, tags, citations] = await Promise.all([
		db
			.select()
			.from(link)
			.where(scoped(link, scope))
			.orderBy(asc(link.targetEntityId)),
		db
			.select()
			.from(entityTag)
			.where(scoped(entityTag, scope))
			.orderBy(asc(entityTag.tagEntityId)),
		db
			.select()
			.from(citation)
			.where(scoped(citation, scope))
			.orderBy(asc(citation.sourceEntityId), asc(citation.locator)),
	]);

	return {
		links: checked(links, scope).map((row) => row.targetEntityId),
		tags: checked(tags, scope).map((row) => row.tagEntityId),
		citations: checked(citations, scope).map((row) => ({
			sourceEntityId: row.sourceEntityId,
			locator: row.locator,
		})),
	};
}

/**
 * Everything one scope holds for an entity, mapped to the domain shape.
 *
 * Every table is read at exactly that scope. For a published version that means a proposal
 * incorporated into the same version — whose own rows carry the same version number (§2.2) —
 * can neither appear nor duplicate anything.
 */
async function readScope(db: Database, type: VersionedType, scope: RowScope) {
	const reader = READERS[type];

	const [base, content, files, references] = await Promise.all([
		db.select().from(reader.table).where(scoped(reader.table, scope)),
		db
			.select()
			.from(reader.contentTable)
			.where(scoped(reader.contentTable, scope))
			.orderBy(asc(reader.contentTable.language)),
		type === "media"
			? db
					.select()
					.from(mediaFile)
					.where(scoped(mediaFile, scope))
					.orderBy(asc(mediaFile.sortOrder), asc(mediaFile.assetId))
			: Promise.resolve([] as MediaFileRow[]),
		readReferences(db, scope),
	]);

	const [row] = checked(base, scope);

	return {
		fields: row ? (reader.fields(row) as PublishedEntity["fields"]) : null,
		// Only media has files, and only media gets the key — an empty array on a person
		// would claim a person *could* have files.
		...(type === "media"
			? {
					files: checked(files, scope).map((file) => ({
						assetId: file.assetId,
						role: file.role,
						isPrimary: file.isPrimary,
						sortOrder: file.sortOrder,
					})),
				}
			: {}),
		content: checked(content, scope).map((contentRow) => {
			const typed = contentRow as unknown as ContentBase;
			return {
				language: typed.language,
				name: typed.name,
				abstract: typed.abstract,
				...reader.content(contentRow),
			};
		}),
		references,
	};
}

/** One published version of one entity — or null if that version was never published. */
async function readVersion(
	db: Database,
	entityId: string,
	type: VersionedType,
	originalLanguage: string,
	version: number,
): Promise<PublishedEntity | null> {
	const read = await readScope(db, type, {
		kind: "published",
		entityId,
		version,
	});

	// A published version always has its own row: publishing refuses a proposal without one.
	if (read.fields === null) return null;

	return {
		id: entityId,
		type,
		version,
		originalLanguage,
		...read,
	} as PublishedEntity;
}

/** The spine row of a published, versioned entity — null for anything else. */
async function readHead(db: Database, entityId: string) {
	// Not an id at all is no entity, rather than a failed cast.
	if (!isUuid(entityId)) return null;
	const [row] = await db
		.select({
			type: entity.type,
			version: entity.version,
			originalLanguage: entity.originalLanguage,
		})
		.from(entity)
		// A null head means never published (§4.6 #6) — invisible, not empty.
		.where(and(eq(entity.id, entityId), isNotNull(entity.version)));

	if (!row || row.version === null || !isVersionedType(row.type)) return null;

	return {
		type: row.type,
		head: row.version,
		// Every versioned entity is localized, so this is set; the fallback is never read.
		originalLanguage: row.originalLanguage ?? "",
	};
}

/**
 * The current published version of an entity, or null.
 *
 * Null covers "no such entity", "never published" and "not a versioned type" alike — a
 * caller that could tell those apart could probe for the existence of unpublished content.
 */
export async function findPublished(
	db: Database,
	entityId: string,
	_actor: Actor,
): Promise<PublishedEntity | null> {
	const head = await readHead(db, entityId);
	if (!head) return null;

	return readVersion(db, entityId, head.type, head.originalLanguage, head.head);
}

/**
 * A specific published version — what a citation of "Version 3" resolves to (§2.2).
 *
 * Null for a version that does not exist yet as for one that never will, and for an entity
 * that has never been published at all.
 */
export async function findVersion(
	db: Database,
	entityId: string,
	version: number,
	_actor: Actor,
): Promise<PublishedEntity | null> {
	if (!Number.isInteger(version) || version < 1) return null;

	const head = await readHead(db, entityId);
	if (!head || version > head.head) return null;

	return readVersion(db, entityId, head.type, head.originalLanguage, version);
}

/** Every published version of an entity, oldest first. Empty if it was never published. */
export async function history(
	db: Database,
	entityId: string,
	_actor: Actor,
): Promise<VersionSummary[]> {
	const head = await readHead(db, entityId);
	if (!head) return [];

	const rows = await db
		.select({
			version: entityVersion.version,
			publishedAt: entityVersion.publishedAt,
			publishedBy: entityVersion.publishedBy,
			redactionReason: entityVersion.redactionReason,
		})
		.from(entityVersion)
		.where(eq(entityVersion.entityId, entityId))
		.orderBy(asc(entityVersion.version));

	return rows;
}

/**
 * Every entity whose **current** published version links to `targetId` — "every photo and
 * story mentioning this person" (§2.6), with nobody tagging anything by hand.
 *
 * Current versions only. A superseded version that once mentioned someone is history, not a
 * reference; surfacing it would show what the archive has since corrected. Built through the
 * same scoping as every other read (§4.6 #7), so a pending proposal's links never count.
 */
export async function backlinks(
	db: Database,
	targetId: string,
	actor: Actor,
): Promise<Backlink[]> {
	if (!isUuid(targetId)) return [];
	// Only entries the actor may **view**: a link comes from any prose field, a gated one
	// included, so "this person's record links to that place" is itself gated content.
	const linking = (Object.keys(READERS) as VersionedType[]).filter((type) =>
		can(actor, `${type}:view`),
	);
	if (linking.length === 0) return [];
	const rows = await db
		.selectDistinct({
			id: entity.id,
			type: entity.type,
			proposalId: link.proposalId,
		})
		.from(link)
		.innerJoin(
			entity,
			and(eq(entity.id, link.entityId), eq(entity.version, link.version)),
		)
		.where(
			and(
				eq(link.targetEntityId, targetId),
				publishedOnly(link),
				inArray(entity.type, linking),
			),
		)
		.orderBy(asc(entity.id));

	return assertPublishedRows(rows).map((row) => ({
		id: row.id,
		type: row.type as VersionedType,
	}));
}

/**
 * Whether the actor may read a proposal of this type: its author always (§2.2 — "a proposer
 * sees their own pending proposal"), and otherwise whoever may publish that type, which is
 * what moderating it means.
 *
 * Here rather than in a controller because it is a condition on *rows* — ownership — and
 * §4.4 puts ownership filtering in the query layer, not in a permission check.
 */
function mayReadProposal(
	actor: Actor,
	type: VersionedType,
	proposedBy: string,
): boolean {
	return actor.id === proposedBy || can(actor, `${type}:moderate`);
}

/**
 * One proposal, in the shape of an entity — what the moderation diff and the proposer's own
 * "my contribution" view are built from.
 *
 * Null when it does not exist *or* the actor may not see it; the two are indistinguishable on
 * purpose, so nobody can probe for unpublished contributions by id.
 */
export async function findProposal(
	db: Database,
	proposalId: string,
	actor: Actor,
): Promise<ProposedEntity | null> {
	if (!isUuid(proposalId)) return null;
	const [row] = await db
		.select({
			entityId: proposal.entityId,
			status: proposal.status,
			basedOnVersion: proposal.basedOnVersion,
			proposedBy: proposal.createdBy,
			type: entity.type,
			originalLanguage: entity.originalLanguage,
		})
		.from(proposal)
		.innerJoin(entity, eq(entity.id, proposal.entityId))
		.where(eq(proposal.id, proposalId));

	if (!row || !isVersionedType(row.type)) return null;
	if (!mayReadProposal(actor, row.type, row.proposedBy)) return null;

	const read = await readScope(db, row.type, {
		kind: "proposal",
		entityId: row.entityId,
		proposalId,
	});

	return {
		id: row.entityId,
		type: row.type,
		originalLanguage: row.originalLanguage ?? "",
		proposalId,
		status: row.status,
		basedOnVersion: row.basedOnVersion,
		proposedBy: row.proposedBy,
		...read,
	} as ProposedEntity;
}

/**
 * The moderation queue: every pending proposal of a type the actor may publish, grouped by
 * type and then oldest first (§6 — "grouped by type, batch actions").
 *
 * A moderator for places does not see the people queue: the set of types is derived from
 * the actor's permissions, so the constraint is in the query rather than in a filter applied
 * afterwards to rows already read.
 */
export async function pendingProposals(
	db: Database,
	actor: Actor,
): Promise<QueuedProposal[]> {
	const moderated = (Object.keys(READERS) as VersionedType[]).filter((type) =>
		can(actor, `${type}:moderate`),
	);
	if (moderated.length === 0) return [];

	const rows = await db
		.select({
			proposalId: proposal.id,
			entityId: proposal.entityId,
			type: entity.type,
			basedOnVersion: proposal.basedOnVersion,
			head: entity.version,
			proposedBy: proposal.createdBy,
			proposedAt: proposal.createdAt,
		})
		.from(proposal)
		.innerJoin(entity, eq(entity.id, proposal.entityId))
		.where(and(eq(proposal.status, "pending"), inArray(entity.type, moderated)))
		// UUIDv7: id order is creation order (§5.2).
		.orderBy(asc(entity.type), asc(proposal.id));

	return rows.map((row) => ({
		...row,
		type: row.type as VersionedType,
		// Stale when anything was published after what the proposer saw — including a create
		// proposal for an entity someone else has meanwhile published.
		stale: (row.head ?? 0) > (row.basedOnVersion ?? 0),
	}));
}

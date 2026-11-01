import { getTableColumns } from "drizzle-orm";
import { toSnakeCase } from "drizzle-orm/casing";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { PLAIN_TEXT_CONTENT_FIELDS } from "../../../domain/entity";
import { link } from "./link";
import { media, mediaContent, mediaFile } from "./media";
import { person, personContent } from "./person";
import { place, placeContent } from "./place";
import { relationship, relationshipContent } from "./relationship";
import { citation, source, sourceContent } from "./source";
import { story, storyContent } from "./story";
import { entityTag, tag, tagContent } from "./tag";
import { terms, termsContent } from "./terms";

/**
 * The entity registry — PLAN.md §4.6 #5.
 *
 * One structure, two guards. Both of the fail-open hazards it addresses are the same shape:
 * something written per entity type, which a *new* entity type then silently misses.
 *
 * - **The publish closure invariant (§2.3).** "Published content may only reference
 *   published content" is one rule over tags, links, places and sources alike. Written as a
 *   hand-rolled loop it quietly permits publishing the moment a fourth reference type
 *   exists; iterated over this registry, new types are covered by default.
 * - **The proposal conformance test (§4.6 #1).** For every registered type, seed a proposal
 *   and assert every read path excludes it. A type that forgets `proposal_id IS NULL`
 *   publishes unmoderated content, and that is the one thing the design forbids.
 *
 * It also carries the `name`/`abstract` convention (§2.4). There is deliberately no shared
 * `LocalizedContent` table — types need genuinely different translatable fields — so the
 * uniform parts of the system depend on a convention rather than on inheritance, and a
 * convention with nothing checking it is a comment.
 *
 * **Adding an entity type means adding it here.** That is the point: the tests below and the
 * closure check read this list, so a type left out is a type nobody is guarding.
 */

/** Which of the four layers (§2.1) a type reaches. */
export type EntityCapabilities = {
	/** Has versions and the propose/publish workflow. */
	versioned: boolean;
	/** Has an original language and per-language content rows. */
	localized: boolean;
	/** Has the archival apparatus: links, sources, comments. */
	historic: boolean;
};

export type RegisteredEntity = {
	/** The discriminator value on `entity.type`. */
	type: string;
	/** What does not vary by language. */
	table: PgTable;
	/** What does, one row per language — absent for types that are not localized. */
	contentTable?: PgTable;
	capabilities: EntityCapabilities;
};

const historic: EntityCapabilities = {
	versioned: true,
	localized: true,
	historic: true,
};

/** Localized and versioned, but not archival: vocabulary and legal text, not records. */
const localizedOnly: EntityCapabilities = {
	versioned: true,
	localized: true,
	historic: false,
};

export const ENTITY_REGISTRY: readonly RegisteredEntity[] = [
	{
		type: "person",
		table: person,
		contentTable: personContent,
		capabilities: historic,
	},
	{
		type: "place",
		table: place,
		contentTable: placeContent,
		capabilities: historic,
	},
	{
		type: "media",
		table: media,
		contentTable: mediaContent,
		capabilities: historic,
	},
	{
		type: "story",
		table: story,
		contentTable: storyContent,
		capabilities: historic,
	},
	{
		type: "relationship",
		table: relationship,
		contentTable: relationshipContent,
		capabilities: historic,
	},
	{
		type: "source",
		table: source,
		contentTable: sourceContent,
		capabilities: historic,
	},
	{
		type: "tag",
		table: tag,
		contentTable: tagContent,
		capabilities: localizedOnly,
	},
	{
		type: "terms",
		table: terms,
		contentTable: termsContent,
		capabilities: localizedOnly,
	},
];

/**
 * Tables that hold a *reference* from one entity version to another, and which the publish
 * closure invariant must therefore walk (§2.3).
 *
 * Each names the column holding the target, so the check is one loop rather than one
 * hand-written join per reference kind — which is exactly the shape that rots when a fifth
 * kind arrives.
 */
export const REFERENCE_TABLES: readonly {
	name: string;
	table: PgTable;
	/** Columns holding the referenced entity. More than one where a row asserts a pair. */
	targetColumns: readonly string[];
}[] = [
	{ name: "link", table: link, targetColumns: ["target_entity_id"] },
	{ name: "entity_tag", table: entityTag, targetColumns: ["tag_entity_id"] },
	{ name: "citation", table: citation, targetColumns: ["source_entity_id"] },
	// A relationship is an assertion about two people, and publishing it while either is
	// still a proposal would publish a claim about someone who is not in the archive yet.
	{
		name: "relationship",
		table: relationship,
		targetColumns: ["person_a_id", "person_b_id"],
	},
];

// `media_file` is deliberately absent. It points at an `asset`, and an asset is immutable
// binary rather than published content — there is no version of it to be unpublished, so the
// closure invariant has nothing to say about it.

/**
 * Every table holding rows that belong to a version or a proposal — that is, everything
 * carrying `(entity_id, version, proposal_id)`.
 *
 * Publishing copies a proposal's rows across all of them, so a table missing from this list
 * is content that silently fails to publish: the version appears, and part of what the
 * contributor wrote is not in it. `registry.test.ts` checks the list against the schema, so
 * the omission fails a test rather than a reader.
 */
export const VERSIONED_CONTENT_TABLES: readonly PgTable[] = [
	person,
	personContent,
	place,
	placeContent,
	media,
	mediaContent,
	mediaFile,
	story,
	storyContent,
	relationship,
	relationshipContent,
	source,
	sourceContent,
	citation,
	tag,
	tagContent,
	entityTag,
	terms,
	termsContent,
	link,
];

/**
 * Content columns that are **not** directive-Markdown. Every other text column of a
 * `<type>_content` table is, and is scanned for chips when the link set is derived (§2.6).
 *
 * The rule runs this way round so that a new prose column is scanned without anyone
 * remembering to list it — forgetting would leave chips in it that the link set, and so
 * the closure invariant, never sees. `name` is plain text: it is what a chip *displays*.
 */
export const PLAIN_TEXT_CONTENT_COLUMNS: readonly string[] = [
	// The domain's rule, so the write path and the link derivation cannot disagree on
	// which fields are prose.
	...PLAIN_TEXT_CONTENT_FIELDS.map(toSnakeCase),
	// Not content at all: the text-search configuration the row is indexed with (§4.3).
	"search_config",
];

/** The directive-Markdown columns of a content table — see `PLAIN_TEXT_CONTENT_COLUMNS`. */
export function markdownColumns(contentTable: PgTable): PgColumn[] {
	return Object.values(getTableColumns(contentTable)).filter(
		(column) =>
			column.columnType === "PgText" &&
			!PLAIN_TEXT_CONTENT_COLUMNS.includes(toSnakeCase(column.name)),
	);
}

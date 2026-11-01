import type { DateOrInterval, RoughDate } from "shared";

/**
 * Published entities as the domain sees them — PLAN.md §2.1, §5.1.
 *
 * **The interface is domain operations, not tables.** Nothing here mentions `proposal_id`,
 * table-per-type joins or the `<type>_content` split: a caller asks for a published entity
 * and gets one, with its rough dates decoded and its languages gathered. If a controller ever
 * has to know how this is stored, the seam is in the wrong place.
 *
 * Framework-free like the rest of `domain/` — no Drizzle row types leak past the repository.
 */

/** The types that have versions, and so can be published and read as published. */
export type VersionedType =
	| "person"
	| "place"
	| "media"
	| "story"
	| "relationship"
	| "source"
	| "tag"
	| "terms";

/**
 * The types a chip may point at: those with the archival apparatus — links, sources,
 * discussion (§2.1). The registry test checks this against `capabilities.historic`, so the
 * two cannot drift.
 */
export const LINKABLE_TYPES: ReadonlySet<string> = new Set([
	"person",
	"place",
	"media",
	"story",
	"relationship",
	"source",
]);

/**
 * Content fields that are plain text. **Every other text field of a content row is
 * directive-Markdown** and is scanned for chips (§2.6). The rule runs this way round so a new
 * prose field is scanned without anyone remembering to list it. `name` is plain: it is what a
 * chip *displays*.
 */
export const PLAIN_TEXT_CONTENT_FIELDS: readonly string[] = [
	"language",
	"name",
];

/**
 * The content fields a **preview** shows, per type — all that `<type>:preview` reveals
 * (§4.4), and so all that a reader without `<type>:view` may be matched against in search.
 *
 * Built by listing what is shown, never by omitting what is not: a field added later is
 * invisible until someone puts it here (§4.6 #2). A person's preview is the **name only**,
 * because a living person's is (§4.4) and nothing yet tells a search which people are alive.
 */
export const PREVIEW_FIELDS: {
	readonly [Type in VersionedType]: readonly ("name" | "abstract")[];
} = {
	person: ["name"],
	place: ["name", "abstract"],
	media: ["name", "abstract"],
	story: ["name", "abstract"],
	relationship: ["name", "abstract"],
	source: ["name", "abstract"],
	tag: ["name", "abstract"],
	terms: ["name", "abstract"],
};

/** What every `<type>_content` carries by convention (§2.4) — one per language. */
export type ContentBase = {
	/** BCP-47. Languages are peers; `originalLanguage` says which one was authored. */
	language: string;
	name: string;
	abstract: string | null;
};

/** A citation of a Source, with where in it to look (§2.6). */
export type Citation = {
	sourceEntityId: string;
	/** Page, date, timestamp — whatever locates the claim in the source. */
	locator: string | null;
};

/** The references a version holds. Each is part of what that version said (§2.6). */
export type References = {
	/** Targets of the bare link set — for discovery, not display. */
	links: string[];
	/** Tag entities applied to this version. */
	tags: string[];
	citations: Citation[];
};

type Published<Type extends VersionedType, Fields, Content> = {
	id: string;
	type: Type;
	/** The version this is — the head for `findPublished`, the one asked for otherwise. */
	version: number;
	originalLanguage: string;
	fields: Fields;
	/** Every language of this version. A version snapshots all languages together (§2.4). */
	content: (ContentBase & Content)[];
	references: References;
};

export type Point = { latitude: number; longitude: number };

export type MediaFile = {
	assetId: string;
	role: "original" | "web" | "thumb";
	isPrimary: boolean;
	sortOrder: number;
};

export type PublishedPerson = Published<
	"person",
	{
		born: RoughDate | null;
		/**
		 * `null` means **living** — not unknown (§4.4). `"unknown"` is a death recorded
		 * without its date.
		 */
		died: RoughDate | "unknown" | null;
	},
	{ description: string | null }
>;

export type PublishedPlace = Published<
	"place",
	{
		point: Point | null;
		/** GeoJSON, for a place that is an area rather than a point. */
		area: unknown | null;
		validFrom: RoughDate | null;
		validUntil: RoughDate | null;
	},
	{ description: string | null }
>;

export type PublishedMedia = Published<
	"media",
	{
		captured: RoughDate | null;
		/** Ad-hoc coordinates for when no Place exists (§2.7). */
		point: Point | null;
	},
	{ description: string | null; caption: string | null }
> & {
	/**
	 * The files of this version, primary first-class among them.
	 *
	 * Apart from `fields` because they merge as one unit: the files constrain each other — one
	 * primary, one sort order — so two proposals editing them are combined whole or not at
	 * all (`registry.ts`, `MERGE_PARTS`).
	 */
	files: MediaFile[];
};

export type PublishedStory = Published<
	"story",
	{ occurred: DateOrInterval | null },
	{ body: string | null }
>;

export type PublishedRelationship = Published<
	"relationship",
	{
		kind: string;
		/** `married` reads the same from either end; `child` does not. */
		directed: boolean;
		personA: string;
		personB: string;
		start: RoughDate | null;
		end: RoughDate | null;
	},
	{ description: string | null }
>;

export type PublishedSource = Published<
	"source",
	{ identifier: string | null; published: DateOrInterval | null },
	{ citationText: string | null }
>;

/** No fields of its own: a tag is its id and its labels (§5.2). */
export type PublishedTag = Published<"tag", object, object>;

export type PublishedTerms = Published<
	"terms",
	/** An exact `yyyy-mm-dd` — legal, not rough, which is why it is not a `RoughDate`. */
	{ effectiveFrom: string },
	{ body: string | null }
>;

export type PublishedEntity =
	| PublishedPerson
	| PublishedPlace
	| PublishedMedia
	| PublishedStory
	| PublishedRelationship
	| PublishedSource
	| PublishedTag
	| PublishedTerms;

/**
 * What a proposal says an entity should be — the **complete state** a client sends, minus
 * what is derived from it (PLAN.md §11).
 *
 * The client loads the head, edits it, and sends all of it back: every field, every
 * language, every tag, citation and file. The link set is absent on purpose — it is exactly
 * the chips in the bodies (§2.6), so the server derives it and the client never sends one.
 */
export type Draft = PublishedEntity extends infer Entity
	? Entity extends PublishedEntity
		? {
				type: Entity["type"];
				fields: Entity["fields"];
				content: Entity["content"];
				tags: string[];
				citations: Citation[];
			} & (Entity extends { files: MediaFile[] }
				? { files: MediaFile[] }
				: object)
		: never
	: never;

/** The draft of one type. */
export type DraftOf<Type extends VersionedType> = Extract<
	Draft,
	{ type: Type }
>;

/** One published version, as the history lists it. */
export type VersionSummary = {
	version: number;
	publishedAt: Date;
	publishedBy: string;
	/**
	 * Set when this version was edited after publication — legal redaction only (§2.2a).
	 * Whether a redaction is *shown* in the public history is an open item, so this carries
	 * the fact and leaves the showing to whoever renders it.
	 */
	redactionReason: string | null;
};

/** An entity whose current published version links to the one asked about (§2.6). */
export type Backlink = { id: string; type: VersionedType };

/** `Omit` over each member of a union, rather than over the union as a whole. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

/**
 * A proposal, read in the same shape as a published entity — PLAN.md §2.2.
 *
 * **A complete state, never a delta** (§11): every field, every language, every set, as the
 * proposer would have the entity be. What they *changed* is the difference from the version
 * it is based on, and publishing merges three ways — base, proposal, head — so untouched
 * parts never revert what landed meanwhile. `fields` is null only for a malformed proposal
 * with no row of its own, which publishing refuses.
 *
 * Never returned by a published read, and never passed through `assertPublished`.
 */
export type ProposedEntity = DistributiveOmit<
	PublishedEntity,
	"version" | "fields"
> & {
	proposalId: string;
	status: "pending" | "accepted" | "rejected";
	/** Null when the proposal introduces the entity. */
	basedOnVersion: number | null;
	/** Who proposed it — the author of the words. */
	proposedBy: string;
	fields: PublishedEntity["fields"] | null;
};

/** A pending proposal as the moderation queue lists it. */
export type QueuedProposal = {
	proposalId: string;
	entityId: string;
	type: VersionedType;
	basedOnVersion: number | null;
	/** The entity's published head now — null if it has never been published. */
	head: number | null;
	/**
	 * The head has moved past what the proposer was working from. Publishing it unreviewed
	 * would silently revert whatever landed in between, so the UI must show both diffs
	 * (§2.2a).
	 */
	stale: boolean;
	proposedBy: string;
	proposedAt: Date;
};

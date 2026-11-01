import { and, eq, getTableName, type SQL, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { type Actor, can } from "../../domain/actor";
import { PREVIEW_FIELDS, type VersionedType } from "../../domain/entity";
import { entity } from "../db/schema";
import { assertPublishedRows } from "./mapper";
import { READERS } from "./read";
import { publishedOnly } from "./scope";

/**
 * Full-text search over published content — PLAN.md §4.3, §6.
 *
 * Three rules shape it:
 *
 * - **Published content only, current versions only.** Surfacing superseded text means
 *   showing what the archive has explicitly corrected, so a row matches only if it belongs
 *   to its entity's published head — and never to a proposal (§4.6 #1).
 * - **The configuration is passed explicitly.** Each content row is indexed with its own
 *   `regconfig`; a query must name the same configuration, or the GIN index is not used. And
 *   the name is a **setting** (`TEXT_SEARCH_CONFIG`) — `german_hunspell` where the dictionary
 *   exists, stock `german` where it does not — so it arrives as an argument, never as a
 *   constant written here.
 * - **Built through the permission layer** (§4.6 #7). A result shows a name and an abstract,
 *   which is the preview projection, so only types the actor may `<type>:preview` are
 *   searched at all. That is a constraint in the query, not a filter on rows already read.
 * - **Matched against what the actor may read, not against everything indexed.** The stored
 *   vector covers a row's full text — a person's description included. Matching a reader
 *   who may only *preview* a type against it would answer "which living person's record
 *   mentions Demenz?" without showing the record. So without `<type>:view`, a row is matched
 *   against its preview fields alone (`PREVIEW_FIELDS`), and a field the preview does not
 *   show is not returned either. That half is computed per query rather than indexed —
 *   fine at a village's scale; an index per preview is the remedy if it stops being.
 *
 * And it **searches through the links** (§11). A chip stores an id, not a name, so a story
 * mentioning Josef Huber does not contain "Huber". Since the link set *is* the chips (§2.6),
 * an entry also matches when its current version links to an entry the actor may preview
 * whose own text matches. That half goes through the same scoping as the first — published,
 * current, previewable — and reads names live, so nothing needs invalidating when one
 * changes. A match through a link ranks below a direct one, and is reported once, in the
 * linking entry's original language.
 */

type Database = PostgresJsDatabase<Record<string, unknown>>;

export type SearchHit = {
	id: string;
	type: VersionedType;
	language: string;
	name: string;
	abstract: string | null;
	rank: number;
};

export type SearchQuery = {
	/** What the person typed. Parsed with `websearch_to_tsquery`, so quotes and `-` work. */
	text: string;
	/** The text-search configuration — the `TEXT_SEARCH_CONFIG` setting. */
	config: string;
	limit?: number;
};

type SearchableContent = PgTable & {
	entityId: PgColumn;
	version: PgColumn;
	proposalId: PgColumn;
	createdBy: PgColumn;
	language: PgColumn;
	name: PgColumn;
	abstract: PgColumn;
	searchConfig: PgColumn;
	searchVector: PgColumn;
};

const MAX_LIMIT = 100;

/**
 * Published entities matching a query, best first.
 *
 * Empty for blank input rather than "everything": an empty query is a search that has not
 * been asked yet.
 */
export async function search(
	db: Database,
	query: SearchQuery,
	actor: Actor,
): Promise<SearchHit[]> {
	const text = query.text.trim();
	if (text.length === 0) return [];

	const types = (Object.keys(READERS) as VersionedType[]).filter((type) =>
		can(actor, `${type}:preview`),
	);
	if (types.length === 0) return [];

	const limit = Math.min(Math.max(query.limit ?? 20, 1), MAX_LIMIT);
	const tsquery = sql`websearch_to_tsquery(${query.config}::regconfig, ${text})`;

	const contentOf = (type: VersionedType) =>
		READERS[type].contentTable as SearchableContent;

	/** The text this actor may be matched against, for one type's content rows. */
	const vectorOf = (type: VersionedType): SQL => {
		const content = contentOf(type);
		if (can(actor, `${type}:view`)) return sql`${content.searchVector}`;

		const shown = PREVIEW_FIELDS[type].map((field) => content[field]);
		return sql`to_tsvector(${content.searchConfig}, concat_ws(' ', ${sql.join(shown, sql`, `)}))`;
	};

	/** The abstract, if this actor's view of the type shows it — null otherwise. */
	const abstractOf = (type: VersionedType): SQL =>
		can(actor, `${type}:view`) || PREVIEW_FIELDS[type].includes("abstract")
			? sql`${contentOf(type).abstract}`
			: sql`NULL::text`;

	/** What a row of this content table must be to count: published, configured alike. */
	const matching = (type: VersionedType): SQL => {
		const content = contentOf(type);
		return and(
			publishedOnly(content),
			// The row's own configuration must be the one queried with — both so the index
			// is used, and because a vector built with one dictionary does not answer a query
			// parsed with another.
			sql`${content.searchConfig} = ${query.config}::regconfig`,
			sql`${vectorOf(type)} @@ ${tsquery}`,
		) as SQL;
	};

	const direct = types.map((type) => {
		const content = contentOf(type);

		return sql`
			SELECT
				${content.entityId} AS id,
				${entity.type} AS type,
				${content.language} AS language,
				${content.name} AS name,
				${abstractOf(type)} AS abstract,
				${content.proposalId} AS proposal_id,
				ts_rank(${vectorOf(type)}, ${tsquery}) AS rank
			FROM ${content}
			JOIN ${entity}
			  ON ${eq(entity.id, content.entityId)}
			 -- The current head only: a match in a superseded version is not a match.
			 AND ${eq(entity.version, content.version)}
			WHERE ${matching(type)}
		`;
	});

	// The previewable entries whose current text matches — what a link may lead to.
	const targets = sql.join(
		types.map((type) => {
			const content = contentOf(type);
			return sql`
				SELECT ${content.entityId} AS entity_id,
				       ts_rank(${vectorOf(type)}, ${tsquery}) AS rank
				FROM ${content}
				JOIN ${entity}
				  ON ${eq(entity.id, content.entityId)}
				 AND ${eq(entity.version, content.version)}
				WHERE ${matching(type)}
			`;
		}),
		sql` UNION ALL `,
	);

	// Links are followed only **from** entries the actor may view. A link comes from any
	// prose field — a person's gated description included — so following one from an entry
	// the actor may only preview would answer what that description says ("which living
	// person's record mentions the Pflegeheim?") without showing it.
	const throughLinks = types
		.filter((type) => can(actor, `${type}:view`))
		.map((type) => {
			const content = contentOf(type);

			return sql`
			SELECT
				${content.entityId} AS id,
				${entity.type} AS type,
				${content.language} AS language,
				${content.name} AS name,
				${abstractOf(type)} AS abstract,
				${content.proposalId} AS proposal_id,
				-- Below a direct match: the entry mentions what was asked for; it is not it.
				0.5 * max(target.rank) AS rank
			FROM ${content}
			JOIN ${entity}
			  ON ${eq(entity.id, content.entityId)}
			 AND ${eq(entity.version, content.version)}
			 -- Once per entry, in the language it was written in.
			 AND ${content.language} = ${entity.originalLanguage}
			JOIN link
			  ON link.entity_id = ${entity.id}
			 AND link.version = ${entity.version}
			 AND link.proposal_id IS NULL
			JOIN (${targets}) AS target ON target.entity_id = link.target_entity_id
			WHERE ${publishedOnly(content)}
			GROUP BY 1, 2, 3, 4, 5, 6
		`;
		});

	const branches = [...direct, ...throughLinks];
	const rows = await db.execute<{
		id: string;
		type: VersionedType;
		language: string;
		name: string;
		abstract: string | null;
		proposal_id: string | null;
		rank: number;
	}>(sql`
		SELECT * FROM (
			-- An entry found both ways, in one language, is one hit: the better of the two.
			SELECT DISTINCT ON (id, language) *
			FROM (${sql.join(branches, sql` UNION ALL `)}) AS candidate
			ORDER BY id, language, rank DESC
		) AS hit
		ORDER BY rank DESC, id
		LIMIT ${limit}
	`);

	return assertPublishedRows(
		[...rows].map((row) => ({ ...row, proposalId: row.proposal_id })),
	).map((row) => ({
		id: row.id,
		type: row.type,
		language: row.language,
		name: row.name,
		abstract: row.abstract,
		rank: Number(row.rank),
	}));
}

/** For tests and diagnostics: the content tables a search walks, by name. */
export const SEARCHED_TABLES = Object.values(READERS).map((reader) =>
	getTableName(reader.contentTable),
);

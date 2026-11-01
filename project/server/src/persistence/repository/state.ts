import { getTableColumns, getTableName, type SQL, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { extractLinks, parse } from "shared";
import type { Merged, Origin, Part, State } from "../../domain/merge";
import {
	ENTITY_REGISTRY,
	MERGE_PARTS,
	markdownColumns,
	NON_CONTENT_COLUMNS,
} from "../db/schema/registry";

/**
 * An entity's state as parts — the repository half of the three-way merge (PLAN.md §11,
 * `domain/merge.ts`).
 *
 * **Generic over the registry, with no per-type code.** A part's value is its rows as JSON,
 * minus bookkeeping, so a column added to a table is compared and copied the day it exists.
 * The alternative — mapping each type's fields by hand — fails open the way §4.6 #5 warns:
 * a column nobody added to the mapping would be silently dropped from every new version.
 *
 * Every function here reads or writes base tables, so they live in the repository and are
 * handed to the publishing service inside its transaction.
 */

type Database = PostgresJsDatabase<Record<string, unknown>>;

/**
 * The database's own name for a column.
 *
 * `column.name` is the *TypeScript* property name; `casing: "snake_case"` is applied when
 * Drizzle emits SQL, and the SQL here is hand-built rather than emitted by the query builder.
 * So this asks Drizzle for the conversion rather than reimplementing it — a private field,
 * but a copied converter that drifted from the real one would produce SQL naming columns that
 * do not exist, which is exactly how publishing was first written and exactly how it failed.
 */
export function columnName(db: Database, column: PgColumn): string {
	const casing = (
		db as unknown as {
			dialect: { casing: { getColumnCasing: (column: PgColumn) => string } };
		}
	).dialect.casing;

	return casing.getColumnCasing(column);
}

/** Columns that can be written — a generated column is computed, not copied. */
export function writableColumns(db: Database, table: PgTable): string[] {
	return (
		Object.values(getTableColumns(table))
			// `generated` is the populated one; `isGenerated` reads as undefined on every column.
			.filter((column) => column.generated === undefined)
			.map((column) => columnName(db, column))
	);
}

/** JSON with keys sorted, so equal rows produce equal strings. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_, inner) =>
		inner && typeof inner === "object" && !Array.isArray(inner)
			? Object.fromEntries(
					Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)),
				)
			: inner,
	);
}

/** Which rows of a table belong to the state being read or copied from. */
function scopeOf(entityId: string, origin: Origin, alias: string): SQL {
	const at = sql.raw(alias);
	return origin.kind === "version"
		? sql`${at}.entity_id = ${entityId} AND ${at}.version = ${origin.version} AND ${at}.proposal_id IS NULL`
		: sql`${at}.entity_id = ${entityId} AND ${at}.proposal_id = ${origin.proposalId}`;
}

/** A part's key: its table and the values of its key columns. Opaque to the domain. */
const partKey = (table: PgTable, keyValues: unknown[]) =>
	JSON.stringify([getTableName(table), ...keyValues]);

/**
 * One version or one proposal of an entity, as parts.
 *
 * A `set` part is present only when it has rows, so an empty set and an absent one are the
 * same state — as they are for members, where a proposal removing the last tag simply has
 * none.
 */
export async function loadState(
	db: Database,
	entityId: string,
	origin: Origin,
): Promise<State> {
	const parts = new Map<string, Part>();

	for (const { table, kind, keyColumns } of MERGE_PARTS) {
		const generated = Object.values(getTableColumns(table))
			.filter((column) => column.generated !== undefined)
			.map((column) => columnName(db, column));
		const ignored = new Set([...NON_CONTENT_COLUMNS, ...generated]);

		const rows = await db.execute<{ row: Record<string, unknown> }>(sql`
			SELECT to_jsonb(t) AS row
			FROM ${sql.identifier(getTableName(table))} AS t
			WHERE ${scopeOf(entityId, origin, "t")}
		`);

		const contents = rows.map(({ row }) =>
			Object.fromEntries(
				Object.entries(row).filter(([column]) => !ignored.has(column)),
			),
		);

		if (kind === "set") {
			if (contents.length === 0) continue;
			const value = contents.map(canonical).sort();
			parts.set(partKey(table, []), { kind, value: JSON.stringify(value) });
			continue;
		}

		for (const content of contents) {
			const key = partKey(
				table,
				keyColumns.map((column) => content[column] ?? null),
			);
			parts.set(key, { kind, value: canonical(content) });
		}
	}

	return parts;
}

/**
 * Writes a merged state as a new published version: each part's rows copied from the side
 * that won it, with `version` set and `proposal_id` null.
 *
 * `created_by` is carried over — it is the author of the words, which publishing does not
 * change. `updated_by` is the publisher, because these rows are the ones they created
 * (§2.2a). The derived link set is not a part and is written separately, from the bodies.
 */
export async function writeVersion(
	db: Database,
	entityId: string,
	version: number,
	merged: Merged,
	actorId: string,
): Promise<void> {
	for (const [key, { origin }] of merged) {
		const [tableName, ...keyValues] = JSON.parse(key) as [string, ...unknown[]];
		const part = MERGE_PARTS.find(
			(candidate) => getTableName(candidate.table) === tableName,
		);
		if (!part) throw new Error(`No merge part is registered for ${tableName}.`);

		const columns = writableColumns(db, part.table);
		const targets = sql.join(
			columns.map((column) => sql.identifier(column)),
			sql`, `,
		);
		const values = sql.join(
			columns.map((column) => {
				if (column === "version") return sql`${version}::int`;
				if (column === "proposal_id") return sql`NULL::uuid`;
				if (column === "updated_by") return sql`${actorId}::uuid`;
				if (column === "updated_at") return sql`now()`;
				return sql`origin.${sql.identifier(column)}`;
			}),
			sql`, `,
		);

		// `IS NOT DISTINCT FROM`, because a key column may be null — a citation without a
		// locator is still one particular citation.
		const sameKey = part.keyColumns.map(
			(column, index) =>
				sql` AND origin.${sql.identifier(column)}::text IS NOT DISTINCT FROM ${
					keyValues[index] === null ? null : String(keyValues[index])
				}`,
		);

		await db.execute(sql`
			INSERT INTO ${sql.identifier(tableName)} (${targets})
			SELECT ${values}
			FROM ${sql.identifier(tableName)} AS origin
			WHERE ${scopeOf(entityId, origin, "origin")}${sql.join(sameKey, sql``)}
		`);
	}
}

/**
 * Derives and writes the link set of one version or proposal from its bodies (§2.6).
 *
 * A proposal carries its derived links too, so the moderation queue can list what it would
 * depend on before anyone publishes it (§2.3).
 *
 * **The link set is exactly the chips in the bodies** — every Markdown column of every
 * language, deduplicated. There are no links outside the prose, so whatever the scope held
 * before is replaced rather than added to. Only `HistoricEntity` types carry links (§2.1);
 * for the rest this writes nothing.
 *
 * @returns the targets written, sorted.
 */
export async function deriveLinks(
	db: Database,
	entityId: string,
	origin: Origin,
	actorId: string,
): Promise<string[]> {
	const [spine] = await db.execute<{ type: string }>(
		sql`SELECT type FROM entity WHERE id = ${entityId}`,
	);
	const item = ENTITY_REGISTRY.find((entry) => entry.type === spine?.type);
	if (!item?.contentTable || !item.capabilities.historic) return [];

	const columns = markdownColumns(item.contentTable).map((column) =>
		sql.identifier(columnName(db, column)),
	);
	const rows = await db.execute<Record<string, string | null>>(sql`
		SELECT ${sql.join(columns, sql`, `)}
		FROM ${sql.identifier(getTableName(item.contentTable))} AS t
		WHERE ${scopeOf(entityId, origin, "t")}
	`);

	const targets = new Set<string>();
	for (const row of rows) {
		for (const markdown of Object.values(row)) {
			if (markdown)
				for (const target of extractLinks(parse(markdown))) targets.add(target);
		}
	}
	const sorted = [...targets].sort();

	await db.execute(
		sql`DELETE FROM link AS t WHERE ${scopeOf(entityId, origin, "t")}`,
	);

	for (const target of sorted) {
		await db.execute(sql`
			INSERT INTO link (entity_id, version, proposal_id, target_entity_id, created_by, updated_by)
			VALUES (
				${entityId},
				${origin.kind === "version" ? origin.version : null},
				${origin.kind === "proposal" ? origin.proposalId : null},
				${target}, ${actorId}, ${actorId}
			)
		`);
	}

	return sorted;
}

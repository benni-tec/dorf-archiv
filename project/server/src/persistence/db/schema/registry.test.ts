import { describe, expect, test } from "bun:test";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { toSnakeCase } from "drizzle-orm/casing";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { LINKABLE_TYPES } from "../../../domain/entity";
import * as schema from ".";
import { entityType } from "./enums";
import {
	ENTITY_REGISTRY,
	markdownColumns,
	REFERENCE_TABLES,
	VERSIONED_CONTENT_TABLES,
} from "./registry";

/**
 * The registry's guards, as tests — PLAN.md §4.6 #1 and #5.
 *
 * These are the cheap half: everything checkable from the schema definitions alone, with no
 * database. The other half — seed a proposal per registered type and assert every read path
 * excludes it — needs a live Postgres and arrives with the repository layer.
 *
 * The point of all of them is the same: a *new* entity type must not be able to quietly skip
 * a rule, so each rule is checked against the registry rather than against a list written
 * out here by hand.
 */

/**
 * Column names as the database sees them.
 *
 * The schema declares camelCase properties and `casing: "snake_case"` converts them when the
 * SQL is emitted, so the names Drizzle reports are the TypeScript ones. The conversion is
 * **Drizzle's own**, imported rather than reimplemented: a copy of the rule that drifted
 * would let these assertions pass against column names the database does not have, which is
 * exactly the failure `repository/publishing.ts` documents.
 */

const columnNames = (table: PgTable): string[] =>
	Object.values(getTableColumns(table)).map((column) =>
		toSnakeCase(column.name),
	);

describe("the registry covers the schema", () => {
	// A type that exists in the discriminator but not in the registry is a type nothing
	// guards: the closure check will not walk it and the conformance test will not seed it.
	test("every versioned entity type in the discriminator is registered", () => {
		// `user`, `thread` and `comment` descend from Entity directly — no versions, no
		// content rows, nothing for the registry to say about them (PLAN.md §2.1).
		const unversioned = new Set(["user", "thread", "comment"]);

		const declared = entityType.enumValues.filter(
			(value) => !unversioned.has(value),
		);
		const registered = ENTITY_REGISTRY.map((item) => item.type);

		expect([...registered].sort()).toEqual([...declared].sort());
	});

	test("no type is registered twice", () => {
		const types = ENTITY_REGISTRY.map((item) => item.type);

		expect(new Set(types).size).toBe(types.length);
	});
});

describe("content tables follow the name/abstract convention", () => {
	// PLAN.md §2.4: there is deliberately no shared LocalizedContent table, because types
	// need genuinely different translatable fields. The cost is that the uniform parts of
	// the system — the preview projection, the detail page, search — depend on *some* fields
	// being present everywhere. A shared base table would give that structurally; this test
	// is what buys it instead.
	test.each(ENTITY_REGISTRY.filter((item) => item.capabilities.localized))(
		"$type content carries name and abstract",
		({ contentTable }) => {
			expect(contentTable).toBeDefined();
			const columns = columnNames(contentTable as PgTable);

			expect(columns).toContain("name");
			expect(columns).toContain("abstract");
		},
	);

	test.each(ENTITY_REGISTRY.filter((item) => item.capabilities.localized))(
		"$type content is keyed by language",
		({ contentTable }) => {
			expect(columnNames(contentTable as PgTable)).toContain("language");
		},
	);

	// Without these two the row cannot be told apart from a proposal, which is §4.6 #1.
	test.each(ENTITY_REGISTRY)(
		"$type content rows carry version and proposal_id",
		({ table, contentTable }) => {
			for (const target of [table, contentTable].filter(Boolean) as PgTable[]) {
				const columns = columnNames(target);
				expect(columns).toContain("version");
				expect(columns).toContain("proposal_id");
				expect(columns).toContain("entity_id");
			}
		},
	);

	// PLAN.md §4.3: the search vector is generated from the row's own configuration, so a
	// German and an English row can sit in one table and each be indexed correctly.
	test.each(ENTITY_REGISTRY.filter((item) => item.capabilities.localized))(
		"$type content is searchable",
		({ contentTable }) => {
			const columns = columnNames(contentTable as PgTable);

			expect(columns).toContain("search_config");
			expect(columns).toContain("search_vector");
		},
	);
});

describe("every table carries the audit quartet", () => {
	// PLAN.md §2.2a: every mutable row, not just entities — join tables and reference tables
	// included, so "who added this link" is answerable rather than folklore.
	const everyTable = [
		...ENTITY_REGISTRY.flatMap(({ table, contentTable }) =>
			[table, contentTable].filter(Boolean),
		),
		...REFERENCE_TABLES.map((item) => item.table),
	] as PgTable[];

	test.each(everyTable.map((table) => [getTableName(table), table] as const))(
		"%s",
		(_name, table) => {
			const columns = columnNames(table);

			expect(columns).toContain("created_at");
			expect(columns).toContain("created_by");
			expect(columns).toContain("updated_at");
			expect(columns).toContain("updated_by");
		},
	);
});

describe("reference tables are what the closure invariant walks", () => {
	// PLAN.md §2.3 is one rule over tags, links, places and sources alike. Written as a
	// hand-rolled loop it silently permits publishing once a fifth reference type exists —
	// so the check reads this list, and this test makes sure the list is well-formed.
	test.each(REFERENCE_TABLES)(
		"$name names columns that exist",
		({ table, targetColumns }) => {
			const columns = columnNames(table);

			expect(targetColumns.length).toBeGreaterThan(0);
			for (const target of targetColumns) expect(columns).toContain(target);
		},
	);

	test.each(REFERENCE_TABLES)(
		"$name is versioned with its parent, so a reference travels with the version that made it",
		({ table }) => {
			const columns = columnNames(table);

			expect(columns).toContain("version");
			expect(columns).toContain("proposal_id");
		},
	);
});

describe("no reference kind can be added without joining the registry", () => {
	// The test above proves the closure check searches every *registered* table, which is
	// worth little on its own: the hole §4.6 #5 describes is a reference table that exists in
	// the schema and was never registered. So this one goes the other way round — it reads the
	// schema, works out which tables hold a reference from one entity version to another, and
	// insists the registry knows about each of them.
	//
	// A reference table is one that is versioned content (it carries `proposal_id`) and has a
	// foreign key to `entity.id` that is not its own identity or its audit trail.
	const structural = new Set([
		"entity_id",
		"created_by",
		"updated_by",
		"published_by",
		"moderator_id",
	]);

	const referenceColumnsOf = (table: PgTable): string[] => {
		const config = getTableConfig(table);
		if (!columnNames(table).includes("proposal_id")) return [];

		return config.foreignKeys
			.flatMap((key) => {
				const reference = key.reference();
				if (getTableName(reference.foreignTable) !== "entity") return [];
				return reference.columns.map((column) => toSnakeCase(column.name));
			})
			.filter((column) => !structural.has(column));
	};

	const allTables = Object.values(schema).filter((value) =>
		is(value, PgTable),
	) as PgTable[];

	const found = allTables.flatMap((table) =>
		referenceColumnsOf(table).map(
			(column) => `${getTableName(table)}.${column}`,
		),
	);

	const registered = REFERENCE_TABLES.flatMap((item) =>
		item.targetColumns.map((column) => `${item.name}.${column}`),
	);

	test("every entity reference on versioned content is registered", () => {
		expect([...new Set(found)].sort()).toEqual([...registered].sort());
	});

	test("the schema really does contain some, so this is not vacuous", () => {
		expect(found.length).toBeGreaterThan(0);
	});
});

describe("the list of versioned tables matches the schema", () => {
	// A table carrying proposal_id holds rows that belong to a proposal or a version, so
	// publishing has to copy it. One missing from VERSIONED_CONTENT_TABLES does not fail
	// loudly: the version appears and part of what the contributor wrote is simply not in it.
	const allTables = Object.values(schema).filter((value) =>
		is(value, PgTable),
	) as PgTable[];

	const carriesProposalId = allTables.filter((table) =>
		columnNames(table).includes("proposal_id"),
	);

	test("the list matches the schema exactly", () => {
		const listed = VERSIONED_CONTENT_TABLES.map(getTableName).sort();
		const actual = carriesProposalId.map(getTableName).sort();

		expect(listed).toEqual(actual);
	});

	test("and is not vacuous", () => {
		expect(VERSIONED_CONTENT_TABLES.length).toBeGreaterThan(10);
	});
});

describe("chips are looked for in every prose column", () => {
	const prose = (type: string) => {
		const item = ENTITY_REGISTRY.find((entry) => entry.type === type);
		if (!item?.contentTable) throw new Error(`no content table for ${type}`);
		return markdownColumns(item.contentTable)
			.map((column) => toSnakeCase(column.name))
			.sort();
	};

	test("the prose columns are the ones the plan names, and never `name`", () => {
		expect(prose("person")).toEqual(["abstract", "description"]);
		expect(prose("media")).toEqual(["abstract", "caption", "description"]);
		expect(prose("story")).toEqual(["abstract", "body"]);
		expect(prose("source")).toEqual(["abstract", "citation_text"]);
		expect(prose("tag")).toEqual(["abstract"]);
	});
});

describe("the domain's list of linkable types is the registry's historic types", () => {
	// Chips may point only at entries with the archival apparatus (§2.1). The write path
	// checks the domain's list; the link derivation uses the registry's capability. Two
	// lists of one fact, so this keeps them one.
	test("they agree", () => {
		expect([...LINKABLE_TYPES].sort()).toEqual(
			ENTITY_REGISTRY.filter((item) => item.capabilities.historic)
				.map((item) => item.type)
				.sort(),
		);
	});
});

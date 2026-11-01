import type { Nodes, Paragraph, Root, Text } from "mdast";
import remarkDirective from "remark-directive";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/**
 * The content module — PLAN.md §3.
 *
 * **One module, not a parser and a serializer.** The mdast tree is the canonical form;
 * directive-Markdown is a projection of it produced and consumed at the edges, and the
 * editor's document will be another. With one canonical form there is nothing to diverge
 * *from*.
 *
 * The only directive this archive gives meaning to is the **entity chip**,
 * `:entity{#<uuid>}` — the id and nothing else (§11). No stored label, so a name can
 * neither go stale nor leak past a redaction (§4.6 #4); no type, since the id resolves it.
 *
 * Every *other* directive is turned back into the text it was written as. `remark-directive`
 * reads ordinary prose colons as directives — "10:30 Uhr" parses as a directive named `30`,
 * "Hinweis:Text" as one named `Text` — and a tree that claims a time of day is markup would
 * leave every consumer to rediscover that. So the tree this returns holds chips and prose,
 * nothing in between.
 */

export type Doc = Root;

const parser = unified().use(remarkParse).use(remarkDirective);

/**
 * Writes chips and nothing else directive-shaped.
 *
 * Deliberately **not** `remark-directive`'s serializer. That one escapes every colon that
 * could open a directive, so "10:30 Uhr" would be stored as `10\:30 Uhr` — noise in the
 * stored text, in every diff and in what is sent for translation, protecting against a
 * reading {@link parse} undoes anyway. A parsed tree holds no directive but a chip, so a
 * chip is all this needs to know how to write.
 *
 * The one colon it **must** escape is the one that would *start* a chip: text that reads
 * `:entity` — typed escaped, or left over from unsupported syntax — written back unescaped
 * would turn into a real chip the next time it is parsed, a reference nobody checked.
 */
const serializer = unified().use(remarkStringify, {
	bullet: "-",
	emphasis: "*",
	strong: "*",
	unsafe: [{ character: ":", after: "entity", inConstruct: "phrasing" }],
	handlers: {
		textDirective: (node: { attributes?: Record<string, unknown> | null }) =>
			chip(String(node.attributes?.id ?? "")),
	} as never,
});

/** Whether a string is a UUID — the only shape of id this archive hands out. */
export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A chip as written, whether or not it is a valid one. */
type ChipNode = {
	type: "textDirective";
	name: "entity";
	attributes?: Record<string, string | null | undefined> | null;
	children: Nodes[];
};

const isDirective = (
	node: Nodes,
): node is Nodes & {
	type: "textDirective" | "leafDirective" | "containerDirective";
	name: string;
} =>
	node.type === "textDirective" ||
	node.type === "leafDirective" ||
	node.type === "containerDirective";

const isChip = (node: Nodes): node is Nodes & ChipNode =>
	node.type === "textDirective" &&
	(node as { name?: string }).name === "entity";

/**
 * Parses directive-Markdown into the canonical tree.
 *
 * Never throws: Markdown has no syntax errors, only text. Whether the chips in it are
 * acceptable is {@link validate}'s question.
 */
export function parse(markdown: string): Doc {
	const tree = parser.parse(markdown);

	visit(tree, (node, index, parent) => {
		if (!isDirective(node) || isChip(node)) return;
		if (parent === undefined || index === undefined) return;

		parent.children.splice(index, 1, ...(asProse(node) as never[]));
		// Revisit from the same place: the replacement holds the directive's own children,
		// which may contain chips and further directives of their own.
		return index;
	});

	return tree;
}

type DirectiveNode = Nodes & {
	type: "textDirective" | "leafDirective" | "containerDirective";
	name: string;
	attributes?: Record<string, string | null | undefined> | null;
	children: Nodes[];
};

/** Attributes as they would be written — `{#id .class key="value"}`, or nothing. */
function attributeText(attributes: DirectiveNode["attributes"]): string {
	const parts = Object.entries(attributes ?? {}).flatMap(([key, value]) => {
		if (value === null || value === undefined) return [];
		if (key === "id") return [`#${value}`];
		if (key === "class")
			return value
				.split(/\s+/)
				.filter(Boolean)
				.map((name) => `.${name}`);
		return [`${key}="${value.replaceAll('"', '\\"')}"`];
	});
	return parts.length > 0 ? `{${parts.join(" ")}}` : "";
}

/**
 * A directive this archive gives no meaning to, as the prose it was written as.
 *
 * Rebuilt from the **parsed** parts — the name, the label's nodes, the attributes — never
 * from the raw source. Copying source text into a text node would put Markdown where text
 * belongs, and every round through the serializer would escape it once more. Keeping the
 * label's and the container's own nodes also keeps a chip inside one a chip.
 */
function asProse(node: DirectiveNode): Nodes[] {
	const text = (value: string): Text => ({ type: "text", value });
	const attributes = attributeText(node.attributes);

	if (node.type === "textDirective") {
		const label =
			node.children.length > 0 ? [text("["), ...node.children, text("]")] : [];
		return [
			text(`:${node.name}`),
			...label,
			...(attributes ? [text(attributes)] : []),
		];
	}

	if (node.type === "leafDirective") {
		const label =
			node.children.length > 0 ? [text("["), ...node.children, text("]")] : [];
		return [
			{
				type: "paragraph",
				children: [text(`::${node.name}`), ...label, text(attributes)],
			} as Paragraph,
		];
	}

	// A container: its label, if any, is a first paragraph marked as such.
	const [first, ...rest] = node.children;
	const labelled =
		first?.type === "paragraph" &&
		(first.data as { directiveLabel?: boolean } | undefined)?.directiveLabel;
	const label = labelled ? [text("["), ...first.children, text("]")] : [];
	const body = labelled ? rest : node.children;

	return [
		{
			type: "paragraph",
			children: [text(`:::${node.name}`), ...label, text(attributes)],
		} as Paragraph,
		...body,
		{ type: "paragraph", children: [text(":::")] } as Paragraph,
	];
}

/**
 * The canonical Markdown for a tree.
 *
 * **Canonical, not original.** Markdown has many spellings of one document — `__bold__` and
 * `**bold**`, `-` and `*` bullets — and this writes one of them. So `serialize(parse(x))` is
 * not `x`; what holds is that it is a fixed point, `serialize(parse(serialize(parse(x))))`
 * equals `serialize(parse(x))`. The server stores the canonical form, which is what makes a
 * diff between two versions show what changed rather than how it was typed.
 */
export function serialize(doc: Doc): string {
	return serializer.stringify(doc);
}

/** Markdown in, canonical Markdown out — what the server stores. */
export function normalize(markdown: string): string {
	return serialize(parse(markdown));
}

export type ChipProblem = {
	/** What is wrong with it, in words a contributor's editor could show. */
	reason:
		| "label" // `:entity[Josef]{#…}` — a stored label goes stale and leaks (§4.6 #4)
		| "missing-id" // `:entity` or `:entity{}`
		| "malformed-id" // `{#josef}`
		| "extra-attributes"; // `{#… type=person}` — the id resolves the rest
	/** The chip as written, for the message. */
	source: string;
};

function chipProblem(node: ChipNode, markdown?: string): ChipProblem | null {
	const start = (node as { position?: { start: { offset?: number } } }).position
		?.start.offset;
	const end = (node as { position?: { end: { offset?: number } } }).position
		?.end.offset;
	const source =
		markdown !== undefined && start !== undefined && end !== undefined
			? markdown.slice(start, end)
			: ":entity";

	if (node.children.length > 0) return { reason: "label", source };

	const attributes = Object.entries(node.attributes ?? {});
	const id = node.attributes?.id;

	if (id === undefined || id === null || id === "")
		return { reason: "missing-id", source };
	if (!UUID.test(id)) return { reason: "malformed-id", source };
	if (attributes.length > 1) return { reason: "extra-attributes", source };

	return null;
}

/**
 * Every chip that is not exactly `:entity{#<uuid>}`.
 *
 * Empty means the document may be stored. Checked on save rather than tolerated on read:
 * a chip that names its target wrongly would otherwise be a reference the link set cannot
 * hold and the closure invariant cannot see (§2.3, §2.6).
 */
export function validate(doc: Doc, markdown?: string): ChipProblem[] {
	const problems: ChipProblem[] = [];

	visit(doc, (node) => {
		if (!isChip(node)) return;
		const problem = chipProblem(node as ChipNode, markdown);
		if (problem) problems.push(problem);
	});

	return problems;
}

/**
 * The entities a document references, deduplicated and sorted — its contribution to the
 * link set (§2.6).
 *
 * **The link set is exactly this, unioned over a version's documents.** There are no links
 * outside the prose, so nothing has to tell a derived link from a deliberate one. Invalid
 * chips are skipped here and refused by {@link validate}; extraction never guesses at what a
 * malformed chip meant.
 */
export function extractLinks(doc: Doc): string[] {
	const targets = new Set<string>();

	visit(doc, (node) => {
		if (!isChip(node)) return;
		if (chipProblem(node as ChipNode) !== null) return;
		const id = (node as ChipNode).attributes?.id;
		if (id) targets.add(id.toLowerCase());
	});

	return [...targets].sort();
}

/** The chip for an entity — the one spelling `validate` accepts. */
export function chip(entityId: string): string {
	return `:entity{#${entityId}}`;
}

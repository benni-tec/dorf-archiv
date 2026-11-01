import { describe, expect, test } from "bun:test";
import {
	chip,
	extractLinks,
	normalize,
	parse,
	serialize,
	validate,
} from "./content";

const josef = "0190a8e2-7a3b-7c4d-8e5f-0123456789ab";
const kirche = "0190a8e2-7a3b-7c4d-8e5f-ba9876543210";

describe("chips", () => {
	test("a chip is read as a reference to its entity", () => {
		const doc = parse(`${chip(josef)} vor der ${chip(kirche)}.`);

		expect(extractLinks(doc)).toEqual([josef, kirche].sort());
		expect(validate(doc)).toEqual([]);
	});

	test("an entity mentioned three times, or in three paragraphs, is one link", () => {
		const doc = parse(`${chip(josef)} und ${chip(josef)}\n\n- ${chip(josef)}`);

		expect(extractLinks(doc)).toEqual([josef]);
	});

	test("chips inside emphasis, lists and quotes still count", () => {
		const doc = parse(`*${chip(josef)}*\n\n> - ${chip(kirche)}`);

		expect(extractLinks(doc)).toEqual([josef, kirche].sort());
	});

	test("prose without chips links to nothing", () => {
		expect(extractLinks(parse("Das Feuerwehrfest 1952."))).toEqual([]);
	});
});

describe("prose colons are prose", () => {
	// remark-directive reads these as directives named `30`, `Text` and `b`.
	const prose = "Hinweis:Text um 10:30 Uhr, a:b";

	test("they link to nothing and are not reported as broken chips", () => {
		const doc = parse(prose);

		expect(extractLinks(doc)).toEqual([]);
		expect(validate(doc)).toEqual([]);
	});

	test("they are stored as written — no escaping a time of day", () => {
		expect(normalize(prose)).toBe(`${prose}\n`);
	});
});

describe("validation refuses every chip that is not exactly :entity{#<uuid>}", () => {
	const reasons = (markdown: string) =>
		validate(parse(markdown), markdown).map((problem) => problem.reason);

	test("a stored label — it would go stale and survive a redaction (§4.6 #4)", () => {
		expect(reasons(`:entity[Josef Huber]{#${josef}}`)).toEqual(["label"]);
	});

	test("no id", () => {
		expect(reasons(":entity")).toEqual(["missing-id"]);
		expect(reasons(":entity{}")).toEqual(["missing-id"]);
	});

	test("an id that is not a uuid", () => {
		expect(reasons(":entity{#josef}")).toEqual(["malformed-id"]);
	});

	test("anything beside the id — the id resolves the rest", () => {
		expect(reasons(`:entity{#${josef} type=person}`)).toEqual([
			"extra-attributes",
		]);
	});

	test("the problem quotes the chip as written", () => {
		const markdown = "Hier :entity{#josef} steht.";
		expect(validate(parse(markdown), markdown)[0]?.source).toBe(
			":entity{#josef}",
		);
	});

	test("an invalid chip contributes no link — extraction never guesses", () => {
		expect(extractLinks(parse(`:entity[Josef]{#${josef}}`))).toEqual([]);
	});
});

describe("normalising never makes a chip out of text", () => {
	// Each is text that merely looks like a chip. Written back unescaped it would be parsed
	// as a real one next time — a reference that never passed a check.
	const lookalikes = [
		// Escaped on purpose: a contributor writing about the syntax, not using it.
		`\\:entity{#${josef}}`,
	];

	test.each(lookalikes)("%p links to nothing, before and after", (markdown) => {
		expect(extractLinks(parse(markdown))).toEqual([]);
		expect(extractLinks(parse(normalize(markdown)))).toEqual([]);
		expect(normalize(normalize(markdown))).toBe(normalize(markdown));
	});
});

describe("chips inside syntax this archive does not support are still chips", () => {
	// The directive around them becomes text; what they are does not change — before or
	// after normalising, so what is checked on save is what is stored.
	test.each([
		`a :b[${chip(josef)}] c`,
		`:::note
${chip(josef)}
:::`,
		`:::note[${chip(josef)}]
text
:::`,
	])("%p", (markdown) => {
		expect(extractLinks(parse(markdown))).toEqual([josef]);
		expect(extractLinks(parse(normalize(markdown)))).toEqual([josef]);
		expect(normalize(normalize(markdown))).toBe(normalize(markdown));
	});
});

describe("canonical form", () => {
	const samples = [
		"*kursiv* und __fett__\n\n* a\n* b\n",
		`Josef ${chip(josef)} stand vor der Kirche.`,
		"# Titel\n\nAbsatz mit [Link](https://example.org) und 10:30 Uhr.",
		"> Zitat\n>\n> - eins\n> - zwei",
		`1. ${chip(kirche)}\n2. Hinweis:Text`,
		// Unsupported directive syntax stays the text it was, and stays put.
		`:::note\nJosef ${chip(josef)}\n:::`,
		"::foo{x=1}",
	];

	test.each(samples)("normalising is a fixed point: %p", (markdown) => {
		const once = normalize(markdown);
		expect(normalize(once)).toBe(once);
	});

	test.each(samples)("normalising keeps the links: %p", (markdown) => {
		expect(extractLinks(parse(normalize(markdown)))).toEqual(
			extractLinks(parse(markdown)),
		);
	});

	test("a chip is written back exactly as the one accepted spelling", () => {
		expect(serialize(parse(chip(josef))).trim()).toBe(chip(josef));
	});
});

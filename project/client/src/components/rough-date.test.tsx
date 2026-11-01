import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { day, decade, month, year } from "shared";
import { RoughDate } from "./rough-date";

/** PLAN.md §6: inline only, `<time>` where representable, a `<span>` for a decade. */

// HTML attribute names are case-insensitive; React writes `dateTime`. Normalised so the
// expectations read as the HTML they describe.
const render = (value: Parameters<typeof RoughDate>[0]["value"]) =>
	renderToStaticMarkup(<RoughDate value={value} />).replaceAll(
		"dateTime=",
		"datetime=",
	);

describe("RoughDate", () => {
	test("a day, a month and a year are <time> with the matching precision", () => {
		expect(render(day(1920, 3, 14))).toBe(
			'<time datetime="1920-03-14" class="whitespace-nowrap">14. März 1920</time>',
		);
		expect(render(month(1920, 3))).toContain('datetime="1920-03"');
		expect(render(year(1920))).toContain('datetime="1920"');
	});

	// `datetime="1920"` would claim a precision the data does not have.
	test("a decade is a plain span — HTML has no form for it", () => {
		expect(render(decade(1920))).toBe(
			'<span class="whitespace-nowrap">1920er</span>',
		);
	});

	test("a period is two ends at their own granularity, with no wrapper", () => {
		const html = render({ start: decade(1920), end: month(1931, 3) });

		expect(html).toBe(
			'<span class="whitespace-nowrap">1920er</span> – ' +
				'<time datetime="1931-03" class="whitespace-nowrap">März 1931</time>',
		);
	});

	test("a DateOrInterval without an end is just a date", () => {
		expect(render({ start: year(1945) })).toBe(render(year(1945)));
	});

	// The rule that matters inside prose: nothing block-level, ever.
	test("never emits a block element", () => {
		for (const value of [
			day(1920, 3, 14),
			decade(1920),
			{ start: year(1939), end: year(1945) },
		]) {
			expect(render(value)).not.toMatch(/<(div|p|section|br)\b/);
		}
	});
});

import { describe, expect, test } from "bun:test";
import { formatDateOrInterval, formatRoughDate } from "./format";
import { dateOrInterval } from "./interval";
import { day, decade, month, year } from "./rough-date";

// PLAN.md §2.5: "The UI must show roughness, never launder it. A date entered as a decade
// renders 1920er, not 1920 — presenting a guess as a precise date is a small lie that an
// archive compounds over time."
describe("formatRoughDate", () => {
	test.each([
		[day(1920, 3, 14), "14. März 1920"],
		[month(1920, 3), "März 1920"],
		[year(1920), "1920"],
		[decade(1920), "1920er"],
	])("renders %o as %s", (date, expected) => {
		expect(formatRoughDate(date)).toBe(expected);
	});

	test("renders every German month name", () => {
		const names = Array.from({ length: 12 }, (_, index) =>
			formatRoughDate(month(1920, index + 1)),
		);

		expect(names).toEqual([
			"Januar 1920",
			"Februar 1920",
			"März 1920",
			"April 1920",
			"Mai 1920",
			"Juni 1920",
			"Juli 1920",
			"August 1920",
			"September 1920",
			"Oktober 1920",
			"November 1920",
			"Dezember 1920",
		]);
	});

	test("does not pad the day, as German prose does not", () => {
		expect(formatRoughDate(day(1920, 3, 4))).toBe("4. März 1920");
	});

	test("renders a year before 1000 without padding", () => {
		expect(formatRoughDate(year(875))).toBe("875");
	});
});

describe("formatDateOrInterval", () => {
	test("renders a lone date as just that date", () => {
		expect(formatDateOrInterval(dateOrInterval(decade(1920)))).toBe("1920er");
	});

	// "Intervals render each end at its own granularity: 1920er – März 1931."
	test("renders each end at its own granularity", () => {
		expect(
			formatDateOrInterval(dateOrInterval(decade(1920), month(1931, 3))),
		).toBe("1920er – März 1931");
	});

	test("separates with an en dash and spaces, not a hyphen", () => {
		const rendered = formatDateOrInterval(
			dateOrInterval(year(1850), year(1900)),
		);

		expect(rendered).toBe("1850 – 1900");
		expect(rendered).not.toContain("-");
	});
});

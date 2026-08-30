import { describe, expect, test } from "bun:test";
import {
	day,
	decade,
	month,
	RoughDateError,
	roughDate,
	spanOf,
	year,
} from "./rough-date";

describe("construction", () => {
	test("a day carries all three parts", () => {
		expect(day(1920, 3, 14)).toEqual({
			granularity: "day",
			year: 1920,
			month: 3,
			day: 14,
		});
	});

	test("a month carries no day", () => {
		expect(month(1920, 3)).toEqual({
			granularity: "month",
			year: 1920,
			month: 3,
		});
	});

	test("a year carries only the year", () => {
		expect(year(1920)).toEqual({ granularity: "year", year: 1920 });
	});

	// PLAN.md §2.5: "1920s is 1920-01-01 … 1929-12-31". A decade is identified by the year
	// it starts, so any year inside it has to normalise to the same value — otherwise two
	// dates denoting the same span would compare as different.
	test.each([
		[1920, 1920],
		[1923, 1920],
		[1929, 1920],
		[1930, 1930],
		[1899, 1890],
	])("decade(%i) anchors at %i", (input, expected) => {
		expect(decade(input)).toEqual({ granularity: "decade", year: expected });
	});

	test("rejects a month outside 1-12", () => {
		expect(() => month(1920, 0)).toThrow(RoughDateError);
		expect(() => month(1920, 13)).toThrow(RoughDateError);
	});

	test("rejects a day the month does not have", () => {
		expect(() => day(1921, 2, 29)).toThrow(RoughDateError);
		expect(() => day(1920, 4, 31)).toThrow(RoughDateError);
		expect(() => day(1920, 1, 0)).toThrow(RoughDateError);
	});

	test("accepts 29 February in a leap year", () => {
		expect(day(1920, 2, 29).day).toBe(29);
	});

	// 1900 is not a leap year; 2000 is. The archive holds nineteenth-century church-book
	// dates, so the century rule is not academic here.
	test("applies the full leap year rule, not just the four-year one", () => {
		expect(() => day(1900, 2, 29)).toThrow(RoughDateError);
		expect(day(2000, 2, 29).day).toBe(29);
	});

	test("rejects a non-integer or absurd year", () => {
		expect(() => year(1920.5)).toThrow(RoughDateError);
		expect(() => year(Number.NaN)).toThrow(RoughDateError);
	});

	test("roughDate builds any granularity from parts", () => {
		expect(roughDate({ granularity: "month", year: 1920, month: 3 })).toEqual(
			month(1920, 3),
		);
		expect(roughDate({ granularity: "decade", year: 1923 })).toEqual(
			decade(1920),
		);
	});

	test("roughDate rejects parts the granularity does not take", () => {
		expect(() =>
			roughDate({ granularity: "year", year: 1920, month: 3 } as never),
		).toThrow(RoughDateError);
	});

	test("roughDate rejects parts the granularity requires but lacks", () => {
		expect(() =>
			roughDate({ granularity: "day", year: 1920, month: 3 } as never),
		).toThrow(RoughDateError);
	});
});

// Every rough date denotes a span (PLAN.md §2.5), and the span is what the database stores
// and the timeline overlaps against — so it is the part that has to be exactly right.
describe("spanOf", () => {
	test.each([
		[decade(1920), "1920-01-01", "1929-12-31"],
		[year(1920), "1920-01-01", "1920-12-31"],
		[month(1920, 3), "1920-03-01", "1920-03-31"],
		[day(1920, 3, 14), "1920-03-14", "1920-03-14"],
	])("%o spans %s to %s", (date, start, end) => {
		expect(spanOf(date)).toEqual({ start, end });
	});

	test("February spans 29 days in a leap year and 28 otherwise", () => {
		expect(spanOf(month(1920, 2)).end).toBe("1920-02-29");
		expect(spanOf(month(1921, 2)).end).toBe("1921-02-28");
	});

	test("pads single-digit months and days to ISO width", () => {
		expect(spanOf(day(875, 1, 2))).toEqual({
			start: "0875-01-02",
			end: "0875-01-02",
		});
	});

	test("a decade spans exactly ten years", () => {
		expect(spanOf(decade(1890))).toEqual({
			start: "1890-01-01",
			end: "1899-12-31",
		});
	});
});

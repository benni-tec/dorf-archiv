import { describe, expect, test } from "bun:test";
import { dateOrInterval, extentOf, IntervalError, interval } from "./interval";
import { day, decade, month, year } from "./rough-date";

describe("dateOrInterval", () => {
	test("a start alone is a date, not an interval", () => {
		const value = dateOrInterval(year(1920));

		expect(value).toEqual({ start: year(1920) });
		expect(value.end).toBeUndefined();
	});

	test("a start and an end make an interval", () => {
		expect(dateOrInterval(decade(1920), month(1931, 3))).toEqual({
			start: decade(1920),
			end: month(1931, 3),
		});
	});

	// PLAN.md §2.5: "the start's span must end at or before the end's span begins."
	test("accepts an end whose span begins after the start's ends", () => {
		expect(() => dateOrInterval(decade(1920), decade(1930))).not.toThrow();
		expect(() => dateOrInterval(year(1920), day(1921, 1, 1))).not.toThrow();
	});

	test("accepts spans that merely touch", () => {
		// 1920-12-31 then 1921-01-01 — adjacent, no overlap.
		expect(() => dateOrInterval(year(1920), year(1921))).not.toThrow();
	});

	// "From the 1920s to 1925 is not a wide interval, it is a contradiction: the start's
	// span already contains the end."
	test("rejects an end contained in the start's span", () => {
		expect(() => dateOrInterval(decade(1920), year(1925))).toThrow(
			IntervalError,
		);
	});

	test("rejects an end that precedes the start", () => {
		expect(() => dateOrInterval(year(1930), year(1920))).toThrow(IntervalError);
	});

	// "a start and end resolving to the same span is rejected, because 1920 to 1920 is a
	// single rough date rather than an interval and should be stored as one."
	test("rejects a start and end denoting the same span", () => {
		expect(() => dateOrInterval(year(1920), year(1920))).toThrow(IntervalError);
		expect(() => dateOrInterval(decade(1920), decade(1923))).toThrow(
			IntervalError,
		);
	});

	test("says which way round the problem is", () => {
		let message = "";
		try {
			dateOrInterval(decade(1920), year(1925));
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toContain("1920er");
		expect(message).toContain("1925");
	});

	// An end without a start is a corrupt value rather than an open-ended interval
	// (PLAN.md §2.5, the nullable-embedding CHECK).
	test("refuses an end with no start", () => {
		expect(() => dateOrInterval(undefined as never, year(1925))).toThrow(
			IntervalError,
		);
	});
});

describe("interval", () => {
	test("requires both ends", () => {
		expect(interval(year(1850), year(1900))).toEqual({
			start: year(1850),
			end: year(1900),
		});
		expect(() => interval(year(1850), undefined as never)).toThrow(
			IntervalError,
		);
	});

	test("enforces the same non-overlap rule", () => {
		expect(() => interval(decade(1920), year(1925))).toThrow(IntervalError);
	});
});

// The generated `extent` column is what the timeline's `&&` overlap query runs against, so
// it is the hull of both ends rather than either one.
describe("extentOf", () => {
	test("a lone date extends over its own span", () => {
		expect(extentOf(dateOrInterval(decade(1920)))).toEqual({
			start: "1920-01-01",
			end: "1929-12-31",
		});
	});

	test("an interval extends from the start's first day to the end's last", () => {
		expect(extentOf(dateOrInterval(decade(1920), month(1931, 3)))).toEqual({
			start: "1920-01-01",
			end: "1931-03-31",
		});
	});

	test("takes its granularity from each end independently", () => {
		expect(extentOf(dateOrInterval(day(1920, 3, 14), decade(1930)))).toEqual({
			start: "1920-03-14",
			end: "1939-12-31",
		});
	});
});

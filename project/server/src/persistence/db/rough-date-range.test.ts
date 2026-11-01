import { afterAll, describe, expect, test } from "bun:test";
import { day, decade, month, type RoughDate, year } from "shared";
import {
	decodeDateOrInterval,
	decodeRoughDate,
	encodeRoughDate,
	fromDaterange,
	StoredDateError,
	toDaterange,
} from "./rough-date-range";
import { connectForTests, NO_DATABASE_REASON } from "./testing";

const cases: [string, RoughDate, string][] = [
	["a day", day(1920, 3, 14), "[1920-03-14,1920-03-15)"],
	["the last day of a month", day(1920, 4, 30), "[1920-04-30,1920-05-01)"],
	["the last day of a year", day(1920, 12, 31), "[1920-12-31,1921-01-01)"],
	["a leap February", month(1920, 2), "[1920-02-01,1920-03-01)"],
	["a common February", month(1921, 2), "[1921-02-01,1921-03-01)"],
	["December", month(1920, 12), "[1920-12-01,1921-01-01)"],
	["a year", year(1920), "[1920-01-01,1921-01-01)"],
	["a decade", decade(1923), "[1920-01-01,1930-01-01)"],
];

describe("toDaterange", () => {
	test.each(cases)("%s", (_, date, range) => {
		expect(toDaterange(date)).toBe(range);
	});
});

describe("fromDaterange", () => {
	test.each(cases)("%s round-trips", (_, date, range) => {
		expect(fromDaterange(range, date.granularity)).toEqual(date);
	});

	// The whole reason it is strict: rounding this to the 1920s would make a corrupt row look
	// like a deliberate decade.
	test("refuses a range that is not its granularity's span", () => {
		expect(() => fromDaterange("[1923-01-01,1924-01-01)", "decade")).toThrow(
			StoredDateError,
		);
		expect(() => fromDaterange("[1920-01-01,1920-01-03)", "day")).toThrow(
			StoredDateError,
		);
	});

	test("refuses anything but a bounded canonical range", () => {
		for (const range of [
			"empty",
			"(,)",
			"[1920-01-01,)",
			"[1920-01-01,1921-01-01]",
		]) {
			expect(() => fromDaterange(range, "year")).toThrow(StoredDateError);
		}
	});
});

describe("encode / decode", () => {
	test("absent is both columns null, and back", () => {
		expect(encodeRoughDate(null)).toEqual({ range: null, granularity: null });
		expect(encodeRoughDate(undefined)).toEqual({
			range: null,
			granularity: null,
		});
		expect(decodeRoughDate(null, null)).toBeNull();
	});

	test("a present date is the pair", () => {
		expect(encodeRoughDate(decade(1920))).toEqual({
			range: "[1920-01-01,1930-01-01)",
			granularity: "decade",
		});
		expect(decodeRoughDate("[1920-01-01,1930-01-01)", "decade")).toEqual(
			decade(1920),
		);
	});

	// Half a value is corruption, and reading it as "unknown" would hide that.
	test("half a pair is refused rather than read as absent", () => {
		expect(() => decodeRoughDate("[1920-01-01,1921-01-01)", null)).toThrow(
			StoredDateError,
		);
		expect(() => decodeRoughDate(null, "year")).toThrow(StoredDateError);
	});
});

describe("decodeDateOrInterval", () => {
	const y1920 = "[1920-01-01,1921-01-01)";
	const y1925 = "[1925-01-01,1926-01-01)";

	test("absent, a date, and a period", () => {
		expect(decodeDateOrInterval(null, null, null, null)).toBeNull();
		expect(decodeDateOrInterval(y1920, "year", null, null)).toEqual({
			start: year(1920),
		});
		expect(decodeDateOrInterval(y1920, "year", y1925, "year")).toEqual({
			start: year(1920),
			end: year(1925),
		});
	});

	test("an end without a start is corruption, not an open period", () => {
		expect(() => decodeDateOrInterval(null, null, y1925, "year")).toThrow(
			StoredDateError,
		);
	});

	test("overlapping ends are refused", () => {
		expect(() =>
			decodeDateOrInterval("[1920-01-01,1930-01-01)", "decade", y1925, "year"),
		).toThrow(StoredDateError);
	});
});

// The literal has to be exactly what Postgres hands back, or `fromDaterange` — which is
// strict — would throw on every row read. Only a real database can say what that is.
const connection = await connectForTests();

describe.skipIf(connection === null)(
	`Postgres agrees on the canonical form (${connection === null ? NO_DATABASE_REASON : "live database"})`,
	() => {
		afterAll(async () => {
			await connection?.close();
		});

		test.each(cases)("%s", async (_, date, range) => {
			const sql = connection?.sql;
			if (!sql) throw new Error("unreachable");

			const [row] = await sql<{ canonical: string }[]>`
				SELECT ${toDaterange(date)}::daterange::text AS canonical
			`;

			expect(row?.canonical).toBe(range);
			expect(fromDaterange(row?.canonical ?? "", date.granularity)).toEqual(
				date,
			);
		});
	},
);

/**
 * Rough dates — PLAN.md §2.5.
 *
 * **A date is an anchor plus a granularity**, and therefore always denotes a *span*:
 * `1920er` is 1920-01-01…1929-12-31, `März 1920` is that month, `14. März 1920` is that day.
 * "Specific" is not a separate kind; it is `day` granularity. Nobody in a village archive
 * knows exactly when grandmother's photograph was taken, so roughness is the normal case
 * and exactness is the special one — which is the opposite of how a date type usually reads.
 *
 * The plan calls the embedded single-date type `Date`. Here it is {@link RoughDate}: an
 * exported type literally named `Date` would shadow the global in every importing module,
 * and the ambiguity that naming exists to prevent would come back as a subtler bug.
 *
 * No JavaScript `Date` appears anywhere below. A `Date` carries a time and a timezone, and
 * an archival date has neither — round-tripping 1920-03-14 through one is how it becomes
 * 1920-03-13 for readers west of Greenwich.
 */

export type Granularity = "day" | "month" | "year" | "decade";

/**
 * A date known to whatever precision the contributor actually had.
 *
 * Modelled as a union rather than one shape with optional parts, so that a `month` date
 * cannot carry a day and a `decade` cannot carry a month — states that would otherwise need
 * checking everywhere they are read.
 */
export type RoughDate =
	| { readonly granularity: "decade"; readonly year: number }
	| { readonly granularity: "year"; readonly year: number }
	| {
			readonly granularity: "month";
			readonly year: number;
			readonly month: number;
	  }
	| {
			readonly granularity: "day";
			readonly year: number;
			readonly month: number;
			readonly day: number;
	  };

/** The inclusive span a rough date denotes, as ISO `yyyy-mm-dd` strings. */
export type Span = { readonly start: string; readonly end: string };

export class RoughDateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RoughDateError";
	}
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** The proleptic Gregorian rule, century exceptions included. */
export function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
	if (month === 2 && isLeapYear(year)) return 29;
	return MONTH_LENGTHS[month - 1] as number;
}

function assertYear(value: number): void {
	if (!Number.isInteger(value)) {
		throw new RoughDateError(`Year must be a whole number, got ${value}.`);
	}
}

function assertMonth(value: number): void {
	if (!Number.isInteger(value) || value < 1 || value > 12) {
		throw new RoughDateError(`Month must be 1–12, got ${value}.`);
	}
}

function assertDay(year: number, month: number, value: number): void {
	const limit = daysInMonth(year, month);
	if (!Number.isInteger(value) || value < 1 || value > limit) {
		throw new RoughDateError(
			`${year}-${pad(month, 2)} has ${limit} days, so day ${value} does not exist.`,
		);
	}
}

/** A date known to the day. */
export function day(year: number, month: number, day: number): RoughDate {
	assertYear(year);
	assertMonth(month);
	assertDay(year, month, day);
	return { granularity: "day", year, month, day };
}

/** A date known to the month. */
export function month(year: number, month: number): RoughDate {
	assertYear(year);
	assertMonth(month);
	return { granularity: "month", year, month };
}

/** A date known to the year. */
export function year(year: number): RoughDate {
	assertYear(year);
	return { granularity: "year", year };
}

/**
 * A date known only to the decade.
 *
 * The anchor is normalised to the year the decade starts, so `decade(1923)` and
 * `decade(1920)` are the same value. Without that, two dates denoting the same span would
 * compare unequal and round-trip differently.
 */
export function decade(year: number): RoughDate {
	assertYear(year);
	return { granularity: "decade", year: Math.floor(year / 10) * 10 };
}

/**
 * Builds a rough date from loose parts — the shape that arrives from a form or a database
 * row. Rejects parts the granularity does not take, rather than ignoring them: a `year`
 * date carrying a month means the caller believes something this value cannot express.
 */
export function roughDate(parts: {
	granularity: Granularity;
	year: number;
	month?: number;
	day?: number;
}): RoughDate {
	const { granularity } = parts;

	const reject = (unexpected: string) => {
		throw new RoughDateError(
			`A ${granularity} date has no ${unexpected}; drop it or use a finer granularity.`,
		);
	};
	const require = (missing: string): number => {
		throw new RoughDateError(`A ${granularity} date needs a ${missing}.`);
	};

	switch (granularity) {
		case "decade":
			if (parts.month !== undefined) reject("month");
			if (parts.day !== undefined) reject("day");
			return decade(parts.year);
		case "year":
			if (parts.month !== undefined) reject("month");
			if (parts.day !== undefined) reject("day");
			return year(parts.year);
		case "month":
			if (parts.day !== undefined) reject("day");
			return month(parts.year, parts.month ?? require("month"));
		case "day":
			return day(
				parts.year,
				parts.month ?? require("month"),
				parts.day ?? require("day"),
			);
	}
}

function pad(value: number, width: number): string {
	return String(value).padStart(width, "0");
}

function iso(year: number, month: number, day: number): string {
	return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/**
 * The inclusive span the date denotes.
 *
 * This is what the database stores as a `daterange` and what the timeline overlaps against,
 * so it is the part that has to be exactly right.
 */
export function spanOf(date: RoughDate): Span {
	switch (date.granularity) {
		case "decade":
			return { start: iso(date.year, 1, 1), end: iso(date.year + 9, 12, 31) };
		case "year":
			return { start: iso(date.year, 1, 1), end: iso(date.year, 12, 31) };
		case "month":
			return {
				start: iso(date.year, date.month, 1),
				end: iso(date.year, date.month, daysInMonth(date.year, date.month)),
			};
		case "day":
			return {
				start: iso(date.year, date.month, date.day),
				end: iso(date.year, date.month, date.day),
			};
	}
}

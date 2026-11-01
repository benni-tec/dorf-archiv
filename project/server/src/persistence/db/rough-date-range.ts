import {
	type DateOrInterval,
	dateOrInterval,
	daysInMonth,
	type Granularity,
	type RoughDate,
	roughDate,
	spanOf,
} from "shared";

/**
 * Rough dates to and from Postgres `daterange` — PLAN.md §2.5.
 *
 * `shared` describes a rough date's span as **inclusive at both ends**: the 1920s are
 * 1920-01-01 … 1929-12-31. Postgres canonicalises a `daterange` to **inclusive lower,
 * exclusive upper**: `[1920-01-01,1930-01-01)`. The two are converted for each other here
 * rather than assumed compatible, because an off-by-one at this boundary is invisible in
 * every test that only round-trips through one side — and it silently widens every date by a
 * day, which is exactly the kind of small lie §2.5 says an archive compounds over time.
 *
 * No JavaScript `Date` appears here either, for the reason `shared` gives: it carries a time
 * and a timezone, and an archival date has neither.
 */

export class StoredDateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StoredDateError";
	}
}

/** The two columns a rough date occupies in a row. */
export type StoredRoughDate = {
	range: string | null;
	granularity: Granularity | null;
};

function pad(value: number, width: number): string {
	return String(value).padStart(width, "0");
}

/** `yyyy-mm-dd` → its parts. Only the canonical form Postgres and `shared` both produce. */
function parseIso(value: string): { year: number; month: number; day: number } {
	const match = /^(\d{4,})-(\d{2})-(\d{2})$/.exec(value);
	if (!match) throw new StoredDateError(`Not an ISO date: ${value}`);

	return {
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3]),
	};
}

function nextDay(value: string): string {
	const { year, month, day } = parseIso(value);

	if (day < daysInMonth(year, month)) {
		return `${pad(year, 4)}-${pad(month, 2)}-${pad(day + 1, 2)}`;
	}
	if (month < 12) return `${pad(year, 4)}-${pad(month + 1, 2)}-01`;
	return `${pad(year + 1, 4)}-01-01`;
}

/** The rough date as the `daterange` literal Postgres stores — `[start,end+1)`. */
export function toDaterange(date: RoughDate): string {
	const span = spanOf(date);
	return `[${span.start},${nextDay(span.end)})`;
}

/**
 * The rough date a stored range and granularity denote.
 *
 * Strict in both directions: the range must be **exactly** the span its granularity implies.
 * A row holding `[1923-01-01,1924-01-01)` with granularity `decade` is not a decade — it is a
 * corrupted value, and rounding it to the 1920s would launder the corruption into something
 * that looks deliberate. So it throws instead.
 *
 * @throws {StoredDateError}
 */
export function fromDaterange(
	range: string,
	granularity: Granularity,
): RoughDate {
	const match = /^\[(\d{4,}-\d{2}-\d{2}),(\d{4,}-\d{2}-\d{2})\)$/.exec(range);
	if (!match) {
		throw new StoredDateError(
			`Expected a bounded daterange in canonical [lower,upper) form, got ${range}.`,
		);
	}

	// Only the lower bound is parsed: comparing the whole literal below checks the upper.
	const { year, month, day } = parseIso(match[1] as string);

	const date = roughDate(
		granularity === "day"
			? { granularity, year, month, day }
			: granularity === "month"
				? { granularity, year, month }
				: { granularity, year },
	);

	if (toDaterange(date) !== range) {
		throw new StoredDateError(
			`The stored range ${range} is not the span of a ${granularity} date ` +
				`(that would be ${toDaterange(date)}). The row is inconsistent; it is not rounded.`,
		);
	}

	return date;
}

/** A nullable rough date as its two columns — both null when the date is absent. */
export function encodeRoughDate(
	date: RoughDate | null | undefined,
): StoredRoughDate {
	if (date === null || date === undefined) {
		return { range: null, granularity: null };
	}
	return { range: toDaterange(date), granularity: date.granularity };
}

/**
 * Two columns back to a nullable rough date.
 *
 * The CHECK constraints already refuse a range without a granularity and vice versa; this
 * refuses it again rather than treating half a value as absent, because a read that returned
 * null for a corrupt row would make the corruption look like an unknown date.
 *
 * @throws {StoredDateError}
 */
export function decodeRoughDate(
	range: string | null,
	granularity: Granularity | null,
): RoughDate | null {
	if (range === null && granularity === null) return null;
	if (range === null || granularity === null) {
		throw new StoredDateError(
			"A rough date is stored as a range and a granularity together; this row has only one.",
		);
	}
	return fromDaterange(range, granularity);
}

/**
 * Four columns back to a nullable `DateOrInterval` — absent, a date, or a period.
 *
 * An end without a start is a corrupt row rather than an open-ended period (§2.5); so is a
 * pair whose ends overlap, which the database refuses too. Both throw rather than being read
 * as something plausible.
 *
 * @throws {StoredDateError}
 */
export function decodeDateOrInterval(
	start: string | null,
	startGranularity: Granularity | null,
	end: string | null,
	endGranularity: Granularity | null,
): DateOrInterval | null {
	const first = decodeRoughDate(start, startGranularity);
	const last = decodeRoughDate(end, endGranularity);

	if (first === null) {
		if (last === null) return null;
		throw new StoredDateError(
			"This row has the end of a period without its start, which is not a value.",
		);
	}

	try {
		return last === null ? dateOrInterval(first) : dateOrInterval(first, last);
	} catch (error) {
		throw new StoredDateError(
			`The stored period is not a valid one: ${(error as Error).message}`,
		);
	}
}

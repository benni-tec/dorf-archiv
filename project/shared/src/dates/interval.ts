import { formatRoughDate } from "./format";
import { type RoughDate, type Span, spanOf } from "./rough-date";

/**
 * The two embedded types built on {@link RoughDate} — PLAN.md §2.5.
 *
 * | Type | Shape | Meaning |
 * | --- | --- | --- |
 * | `RoughDate` | one, required | a single point-or-span |
 * | `DateOrInterval` | start required, end optional | one set ⇒ a date; both ⇒ an interval |
 * | `Interval` | both required | genuinely spans a period |
 *
 * **`RoughDate` for things that happen once, `DateOrInterval` for things that can last.** A
 * birth, a death, a shutter firing — each is one event, and "1890er" expresses uncertainty
 * about *when*, which is granularity's job, not an interval's. A story about the war years
 * genuinely occupies a stretch of time; that is what an interval is for.
 *
 * Keeping intervals to things that can genuinely last also settles an ambiguity: `1890–1895`
 * could otherwise mean "this lasted five years" or "this happened once, somewhere in there".
 * The second reading is removed by construction, so no disambiguating flag is needed.
 */

export type DateOrInterval = {
	readonly start: RoughDate;
	readonly end?: RoughDate | undefined;
};

export type Interval = {
	readonly start: RoughDate;
	readonly end: RoughDate;
};

export class IntervalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IntervalError";
	}
}

/**
 * Rough boundaries must not overlap: the start's span has to end strictly before the end's
 * span begins.
 *
 * One comparison covers all three ways this goes wrong, which is why it is stated once here
 * rather than as a chain of cases:
 *
 * - **contained** — "from the 1920s to 1925" is not a wide interval but a contradiction,
 *   since the start's span already holds the end;
 * - **reversed** — 1930 to 1920;
 * - **identical** — "1920 to 1920" is a single rough date, and should be stored as one.
 *
 * Adjacent spans are fine: 1920 → 1921, or the 1920s → the 1930s.
 *
 * The database enforces the same rule as a CHECK, because these dates arrive from the upload
 * form, the moderation UI and any future import alike. This is the copy that gives a person
 * a sentence they can act on.
 */
function assertOrdered(start: RoughDate, end: RoughDate): void {
	if (spanOf(start).end < spanOf(end).start) return;

	throw new IntervalError(
		`“${formatRoughDate(start)}” does not end before “${formatRoughDate(end)}” begins. ` +
			`A period needs its start to fall entirely before its end; if both denote the same ` +
			`time, record a single date instead.`,
	);
}

/**
 * A date, or a period if an end is given.
 *
 * @throws {IntervalError} if the end is given without a start — that is a corrupt value
 * rather than an open-ended period — or if the two ends overlap.
 */
export function dateOrInterval(
	start: RoughDate,
	end?: RoughDate,
): DateOrInterval {
	if (start === undefined || start === null) {
		throw new IntervalError(
			"A period cannot have an end without a start. Leave both empty for an unknown date.",
		);
	}

	if (end === undefined) return { start };

	assertOrdered(start, end);
	return { start, end };
}

/** A period that genuinely spans time; both ends are required. */
export function interval(start: RoughDate, end: RoughDate): Interval {
	if (end === undefined || end === null) {
		throw new IntervalError("A period needs both a start and an end.");
	}

	const value = dateOrInterval(start, end);
	return { start: value.start, end };
}

/**
 * The hull of both ends — what the generated `extent` column holds and what the timeline's
 * `&&` overlap test runs against. Each end contributes its own granularity's span, so a
 * period from a day to a decade reaches to the end of that decade.
 */
export function extentOf(value: DateOrInterval): Span {
	const start = spanOf(value.start);
	if (value.end === undefined) return start;

	return { start: start.start, end: spanOf(value.end).end };
}

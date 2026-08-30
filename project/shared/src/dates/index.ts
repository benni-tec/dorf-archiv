/**
 * Rough dates — the archival date primitive. See `rough-date.ts` for what a rough date is
 * and why it is not a JavaScript `Date`.
 */

export {
	formatDateOrInterval,
	formatRoughDate,
} from "./format";
export {
	type DateOrInterval,
	dateOrInterval,
	extentOf,
	type Interval,
	IntervalError,
	interval,
} from "./interval";
export {
	day,
	daysInMonth,
	decade,
	type Granularity,
	isLeapYear,
	month,
	type RoughDate,
	RoughDateError,
	roughDate,
	type Span,
	spanOf,
	year,
} from "./rough-date";

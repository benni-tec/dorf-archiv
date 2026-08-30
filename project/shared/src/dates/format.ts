import type { DateOrInterval } from "./interval";
import type { RoughDate } from "./rough-date";

/**
 * Rendering rough dates — PLAN.md §2.5.
 *
 * **Show roughness, never launder it.** A date entered as a decade renders `1920er`, not
 * `1920`: presenting a guess as a precise date is a small lie, and an archive compounds it
 * every time the value is read back, cited, or copied into another record.
 *
 * Output is plain text with no markup. Dates appear mid-sentence inside prose, so the
 * component that renders one is inline (`<span>`/`<time>`) and lives in the client; this
 * module's job is to decide what the words are.
 *
 * German is hard-coded here, and deliberately so for now: the archive is German-first, and
 * a formatter that guesses at a locale is worse than one that states which it speaks.
 * Localising this is one map away when a second language earns its place.
 */

const MONTH_NAMES = [
	"Januar",
	"Februar",
	"März",
	"April",
	"Mai",
	"Juni",
	"Juli",
	"August",
	"September",
	"Oktober",
	"November",
	"Dezember",
] as const;

/** An en dash with spaces, which is what German typography uses for a span. */
const RANGE_SEPARATOR = " – ";

export function formatRoughDate(date: RoughDate): string {
	switch (date.granularity) {
		case "decade":
			return `${date.year}er`;
		case "year":
			return String(date.year);
		case "month":
			return `${MONTH_NAMES[date.month - 1]} ${date.year}`;
		case "day":
			return `${date.day}. ${MONTH_NAMES[date.month - 1]} ${date.year}`;
	}
}

/**
 * Renders a date, or a period as both of its ends — each at its own granularity, so
 * "1920er – März 1931" stays honest about knowing the second end more precisely than the
 * first.
 */
export function formatDateOrInterval(value: DateOrInterval): string {
	if (value.end === undefined) return formatRoughDate(value.start);

	return `${formatRoughDate(value.start)}${RANGE_SEPARATOR}${formatRoughDate(value.end)}`;
}

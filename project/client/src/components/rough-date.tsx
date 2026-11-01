import {
	type DateOrInterval,
	formatRoughDate,
	type RoughDate as RoughDateValue,
} from "shared";

/**
 * A rough date, rendered at its own granularity — PLAN.md §2.5, §6.
 *
 * **Show roughness, never launder it.** A decade renders "1920er", not "1920", and a period
 * renders each end at its own precision: "1920er – März 1931". The words come from `shared`;
 * this decides the markup.
 *
 * **Inline only.** Dates appear mid-sentence in a description, inside a chip, in a table cell
 * and in a heading, so this renders `<time>`/`<span>` and nothing else — a `<div>` inside a
 * `<p>` is invalid nesting that the browser silently re-parses, breaking the markup around it.
 *
 * `<time datetime>` is used where HTML can express the granularity — `1920`, `1920-03`,
 * `1920-03-14` — and a plain `<span>` for a decade, which it cannot: there is no `192X`
 * form, and `datetime="1920"` would assert a precision the data does not have. An interval is
 * two such elements and a separator; HTML has no range form, so none is invented.
 */

const pad = (value: number, width: number) =>
	String(value).padStart(width, "0");

/** The machine-readable form, or null where HTML has none (a decade). */
function machineReadable(date: RoughDateValue): string | null {
	switch (date.granularity) {
		case "decade":
			return null;
		case "year":
			return pad(date.year, 4);
		case "month":
			return `${pad(date.year, 4)}-${pad(date.month, 2)}`;
		case "day":
			return `${pad(date.year, 4)}-${pad(date.month, 2)}-${pad(date.day, 2)}`;
	}
}

/**
 * One end. `nowrap` so "März 1931" cannot break across lines, while an interval as a whole
 * still wraps at its separator.
 */
function Endpoint({ date }: { date: RoughDateValue }) {
	const text = formatRoughDate(date);
	const datetime = machineReadable(date);

	return datetime === null ? (
		<span className="whitespace-nowrap">{text}</span>
	) : (
		<time dateTime={datetime} className="whitespace-nowrap">
			{text}
		</time>
	);
}

const isPeriod = (
	value: RoughDateValue | DateOrInterval,
): value is DateOrInterval => "start" in value;

export function RoughDate({
	value,
}: {
	/** A single rough date, or a `DateOrInterval` — which is a date when it has no end. */
	value: RoughDateValue | DateOrInterval;
}) {
	if (!isPeriod(value)) return <Endpoint date={value} />;
	if (value.end === undefined) return <Endpoint date={value.start} />;

	// A fragment, not a wrapper: the separator sits *between* the two nowrap ends, which is
	// the one place the period may break.
	return (
		<>
			<Endpoint date={value.start} />
			{" – "}
			<Endpoint date={value.end} />
		</>
	);
}

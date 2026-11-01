/**
 * The three-way merge publishing is built on — PLAN.md §11.
 *
 * **A proposal is the entity's complete state, never a delta.** What a proposal *changed* is
 * therefore not stored anywhere: it is the difference between the proposal and the version
 * it was based on. Comparing all three — base, proposal, and whatever is current now — is
 * what lets a stale proposal publish without reverting what landed in between, and lets two
 * proposals that touched different things combine into one version.
 *
 * The merge works on **parts**, not on fields. A part is a unit that is taken whole from one
 * side or the other:
 *
 * - `own` — the type's own row. One per entity; a proposal must carry it.
 * - `language` — one language's content row. A proposal **may not drop** one the base had
 *   (§2.4): complete means complete, so leaving it out would read as deleting it, and that
 *   is refused rather than obeyed. Content that must go is a redaction (§2.2a).
 * - `member` — one element of a set merged element by element, so one proposal adding a tag
 *   and another adding a different one keeps both.
 * - `set` — a set merged whole, where elements constrain each other (one primary file, one
 *   sort order) and combining two edits element by element could break that.
 *
 * Parts are opaque here: a key and a value that are equal or not. What a part *is* — which
 * table, which columns — is the repository's business, which is what lets this be tested
 * without a database and lets a new column take part without anyone remembering it.
 */

export type PartKind = "own" | "language" | "member" | "set";

/** One part of one state. `value` compares by equality and means nothing else here. */
export type Part = { kind: PartKind; value: string };

/** Everything one state holds, by part key. An absent key is an absent part. */
export type State = ReadonlyMap<string, Part>;

/** Where a part of the merged result comes from. */
export type Origin =
	| { kind: "version"; version: number }
	| { kind: "proposal"; proposalId: string };

/** A merged state, every part remembering where it came from. */
export type Merged = ReadonlyMap<string, { part: Part; origin: Origin }>;

/** A part both sides changed since the base, and changed differently. */
export type Conflict = {
	key: string;
	kind: PartKind;
	/** The proposal being merged in. */
	proposalId: string;
};

export class ConflictError extends Error {
	readonly conflicts: Conflict[];

	constructor(conflicts: Conflict[]) {
		super(
			`Cannot publish: ${conflicts.length} part(s) were changed differently since the ` +
				`proposal was made — ${conflicts.map((item) => item.key).join(", ")}. ` +
				"Edit the proposal against the current version to decide between them.",
		);
		this.name = "ConflictError";
		this.conflicts = conflicts;
	}
}

/** A proposal that leaves out something a complete state must have. */
export class IncompleteProposalError extends Error {
	readonly missing: { key: string; kind: PartKind }[];

	constructor(proposalId: string, missing: { key: string; kind: PartKind }[]) {
		super(
			`Proposal ${proposalId} is not a complete state: it leaves out ` +
				`${missing.map((item) => `${item.key} (${item.kind})`).join(", ")}. A proposal ` +
				"may not drop a published language or its entity's own fields; content that " +
				"must go is a redaction, not an edit.",
		);
		this.name = "IncompleteProposalError";
		this.missing = missing;
	}
}

/** The state a version that does not exist has — what a create is based on. */
export const EMPTY: State = new Map();

/** A current state where every part comes from one published version. */
export function fromVersion(state: State, version: number): Merged {
	return new Map(
		[...state].map(([key, part]) => [
			key,
			{ part, origin: { kind: "version", version } as Origin },
		]),
	);
}

/**
 * What a proposal must carry, given the version it was based on.
 *
 * Its own row always, and every language the base had. Members and sets may be missing —
 * removing a tag or every file is a legitimate edit.
 *
 * @throws {IncompleteProposalError}
 */
export function assertComplete(
	proposalId: string,
	base: State,
	proposal: State,
): void {
	const missing: { key: string; kind: PartKind }[] = [];

	for (const [key, part] of base) {
		if (part.kind === "language" && !proposal.has(key))
			missing.push({ key, kind: part.kind });
	}

	const ownKeys = [...proposal.values()].some((part) => part.kind === "own");
	if (!ownKeys) {
		const baseOwn = [...base].find(([, part]) => part.kind === "own");
		missing.push({ key: baseOwn?.[0] ?? "own", kind: "own" });
	}

	if (missing.length > 0)
		throw new IncompleteProposalError(proposalId, missing);
}

/**
 * Merges one proposal into the current state, against the base it was made from.
 *
 * Per part, comparing values:
 *
 * | base → proposal | base → current | result |
 * | --- | --- | --- |
 * | unchanged | anything | current's |
 * | changed | unchanged | the proposal's |
 * | changed | changed the same way | either — they agree |
 * | changed | changed differently | **conflict** |
 *
 * "Changed" includes appearing and disappearing, so a proposal removing a tag removes it,
 * and one that never had a tag someone else has since added leaves it alone.
 *
 * Conflicts are collected rather than thrown one at a time, so a moderator sees every part
 * to decide on at once.
 *
 * @throws {ConflictError}
 */
export function mergeProposal(
	base: State,
	current: Merged,
	proposal: State,
	proposalId: string,
): Merged {
	const keys = new Set([...base.keys(), ...current.keys(), ...proposal.keys()]);
	const merged = new Map(current);
	const conflicts: Conflict[] = [];
	const fromProposal: Origin = { kind: "proposal", proposalId };

	for (const key of [...keys].sort()) {
		const was = base.get(key)?.value;
		const proposed = proposal.get(key);
		const now = current.get(key)?.part.value;

		// The proposer left it as they found it: whatever is current stands.
		if (proposed?.value === was) continue;

		if (now === was) {
			// Nobody else touched it: the proposal's change goes in, removals included.
			if (proposed) merged.set(key, { part: proposed, origin: fromProposal });
			else merged.delete(key);
			continue;
		}

		// Both changed it. Agreeing is not a conflict.
		if (proposed?.value === now) continue;

		const kind =
			proposed?.kind ?? current.get(key)?.part.kind ?? base.get(key)?.kind;
		conflicts.push({ key, kind: kind ?? "member", proposalId });
	}

	if (conflicts.length > 0) throw new ConflictError(conflicts);
	return merged;
}

/** Whether a merged state differs from the published version it started from. */
export function changesAnything(merged: Merged, current: Merged): boolean {
	if (merged.size !== current.size) return true;
	for (const [key, entry] of merged) {
		if (current.get(key)?.part.value !== entry.part.value) return true;
	}
	return false;
}

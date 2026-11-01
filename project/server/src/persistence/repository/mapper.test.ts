import { describe, expect, test } from "bun:test";
import {
	assertPublished,
	assertPublishedRows,
	ProposalLeakError,
} from "./mapper";

/**
 * PLAN.md §4.6 #1 and §5.1. The mapper asserts rather than maps, because a mapper alone
 * would *hide* proposal-ness rather than catch it — turning a leak into a silently
 * well-typed one.
 */

const published = { entityId: "e1", version: 3, proposalId: null };
const proposal = { entityId: "e1", version: null, proposalId: "p1" };
const incorporated = { entityId: "e1", version: 3, proposalId: "p1" };

describe("assertPublished", () => {
	test("passes a published row through unchanged", () => {
		expect(assertPublished(published)).toBe(published);
	});

	test("throws on a pending proposal", () => {
		expect(() => assertPublished(proposal)).toThrow(ProposalLeakError);
	});

	// The row-set of version 3 is the one with `proposal_id IS NULL`. A proposal that fed
	// into version 3 keeps its own rows, annotated — so a version number is not evidence
	// that a row is published, and treating it as such duplicates the version once per
	// incorporated proposal (PLAN.md §2.2).
	test("throws on a proposal that was incorporated into a version", () => {
		expect(() => assertPublished(incorporated)).toThrow(ProposalLeakError);
	});

	test("says what went wrong in terms a reader can act on", () => {
		let message = "";
		try {
			assertPublished(proposal);
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toContain("proposal_id IS NULL");
		expect(message).toContain("p1");
	});

	test("throws when the column is missing entirely rather than assuming it is null", () => {
		// A row shape without the column means the query did not select it, so nothing here
		// can tell whether it was a proposal. Deny on doubt (§4.6 #9).
		expect(() =>
			assertPublished({ entityId: "e1", version: 3 } as never),
		).toThrow(ProposalLeakError);
	});
});

describe("assertPublishedRows", () => {
	test("passes a set of published rows through", () => {
		const rows = [published, { ...published, entityId: "e2" }];

		expect(assertPublishedRows(rows)).toBe(rows);
	});

	test("throws if any single row is a proposal", () => {
		expect(() => assertPublishedRows([published, proposal])).toThrow(
			ProposalLeakError,
		);
	});

	test("names the offending row, not just that there was one", () => {
		let message = "";
		try {
			assertPublishedRows([published, proposal]);
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toContain("p1");
	});

	test("accepts an empty result", () => {
		expect(assertPublishedRows([])).toEqual([]);
	});
});

import { describe, expect, test } from "bun:test";
import { AnonymousActorError, accountActor, anonymousActor } from "./actor";
import { NotPublishableError } from "./publishing";
import {
	type RejectDependencies,
	RejectionReasonRequiredError,
	rejectProposal,
} from "./rejection";

/**
 * PLAN.md §2.2: **proposals are never deleted** — a rejected one persists with its reason and
 * the moderator who rejected it. That is the whole point of the operation: not to make a
 * contribution go away, but to record what happened to it and why.
 */

const moderator = accountActor("mod-1", [], ["story:moderate"]);

const recorder = () => {
	const calls: string[] = [];
	const deps: RejectDependencies = {
		loadProposal: async () => ({
			id: "p-1",
			entityId: "e-1",
			type: "story",
			status: "pending",
			basedOnVersion: 1,
		}),
		recordRejection: async (proposalId, reason, moderatorId) => {
			calls.push(`reject ${proposalId} by ${moderatorId}: ${reason}`);
		},
	};
	return { calls, deps };
};

describe("rejectProposal", () => {
	test("records the reason and the moderator", async () => {
		const { calls, deps } = recorder();

		await rejectProposal(
			deps,
			"p-1",
			"Das Foto zeigt eine lebende Person.",
			moderator,
		);

		expect(calls).toEqual([
			"reject p-1 by mod-1: Das Foto zeigt eine lebende Person.",
		]);
	});

	test("returns what it rejected, so a caller can tell the contributor", async () => {
		const { deps } = recorder();

		const result = await rejectProposal(deps, "p-1", "Unbelegt.", moderator);

		expect(result).toEqual({ proposalId: "p-1", entityId: "e-1" });
	});

	// The database CHECK refuses a rejected row without both, but a constraint violation is
	// not an error a moderator can act on, and the rule belongs where the reason is written.
	describe("a rejection without a reason is not a rejection", () => {
		test.each([[""], ["   "], ["\n\t "]])("refuses %p", async (reason) => {
			const { calls, deps } = recorder();

			const error = await rejectProposal(deps, "p-1", reason, moderator).catch(
				(caught: unknown) => caught as Error,
			);

			expect(error).toBeInstanceOf(RejectionReasonRequiredError);
			expect(calls).toEqual([]);
		});

		test("keeps the reason as written, trimming only the edges", async () => {
			const { calls, deps } = recorder();

			await rejectProposal(
				deps,
				"p-1",
				"  Zwei Gründe:\n  unbelegt.  ",
				moderator,
			);

			expect(calls[0]).toContain("Zwei Gründe:\n  unbelegt.");
		});
	});

	test("an anonymous actor cannot reject, since the audit trail needs a name", async () => {
		const { calls, deps } = recorder();

		const error = await rejectProposal(
			deps,
			"p-1",
			"Unbelegt.",
			anonymousActor([]),
		).catch((caught: unknown) => caught as Error);

		expect(error).toBeInstanceOf(AnonymousActorError);
		expect(calls).toEqual([]);
	});

	describe("what cannot be rejected", () => {
		test("a proposal that was already published", async () => {
			const { deps } = recorder();
			deps.loadProposal = async () => ({
				id: "p-1",
				entityId: "e-1",
				type: "story",
				status: "accepted",
				basedOnVersion: 1,
			});

			const error = await rejectProposal(
				deps,
				"p-1",
				"Zu spät.",
				moderator,
			).catch((caught: unknown) => caught as Error);

			expect(error).toBeInstanceOf(NotPublishableError);
		});

		test("one that was already rejected — the first reason stands", async () => {
			const { deps } = recorder();
			deps.loadProposal = async () => ({
				id: "p-1",
				entityId: "e-1",
				type: "story",
				status: "rejected",
				basedOnVersion: 1,
			});

			const error = await rejectProposal(
				deps,
				"p-1",
				"Nochmal.",
				moderator,
			).catch((caught: unknown) => caught as Error);

			expect(error).toBeInstanceOf(NotPublishableError);
		});

		test("one that does not exist", async () => {
			const { deps } = recorder();
			deps.loadProposal = async () => null;

			const error = await rejectProposal(
				deps,
				"p-1",
				"Unbelegt.",
				moderator,
			).catch((caught: unknown) => caught as Error);

			expect(error).toBeInstanceOf(NotPublishableError);
		});
	});
	test("a moderator of another type cannot reject, and learns nothing", async () => {
		const { deps, calls } = recorder();
		const error = await rejectProposal(
			deps,
			"p-1",
			"Unbelegt.",
			accountActor("mod-2", [], ["place:moderate"]),
		).catch((caught) => caught as Error);

		expect(error).toBeInstanceOf(NotPublishableError);
		expect(error.message).toBe("No proposal p-1.");
		expect(calls).toEqual([]);
	});
});

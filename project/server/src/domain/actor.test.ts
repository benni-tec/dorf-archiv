import { describe, expect, test } from "bun:test";
import {
	accountActor,
	anonymousActor,
	can,
	isAnonymous,
	type Permission,
	PermissionResolutionError,
	resolveActor,
} from "./actor";

/**
 * PLAN.md §4.4 and §5.1. Anonymous is *an actor holding the public role set*, never the
 * absence of one — so there is always something to pass, and scoping stops being a step
 * anyone can forget.
 */

describe("anonymousActor", () => {
	test("is an actor, not the absence of one", () => {
		const actor = anonymousActor(["person:preview"]);

		expect(isAnonymous(actor)).toBe(true);
		expect(actor.id).toBeNull();
		expect(can(actor, "person:preview")).toBe(true);
	});

	test("holds only what the public role set grants", () => {
		const actor = anonymousActor(["person:preview"]);

		expect(can(actor, "person:view")).toBe(false);
	});

	test("can hold nothing at all", () => {
		expect(can(anonymousActor([]), "person:preview")).toBe(false);
	});
});

describe("accountActor", () => {
	// "Effective permissions are the union of the public roles and the caller's own", so a
	// signed-in caller never has *less* than a visitor.
	test("holds the union of the public set and its own", () => {
		const actor = accountActor("u1", ["person:preview"], ["person:view"]);

		expect(can(actor, "person:preview")).toBe(true);
		expect(can(actor, "person:view")).toBe(true);
	});

	test("is not anonymous, and carries the id ownership filtering needs", () => {
		const actor = accountActor("u1", [], []);

		expect(isAnonymous(actor)).toBe(false);
		expect(actor.id).toBe("u1");
	});

	test("granting the same permission twice grants it once", () => {
		const actor = accountActor("u1", ["person:view"], ["person:view"]);

		expect(actor.permissions).toEqual(["person:view"]);
	});
});

describe("can", () => {
	test("is exact, not prefix matching", () => {
		const actor = anonymousActor(["person:preview"]);

		expect(can(actor, "person:preview:extra" as never)).toBe(false);
		expect(can(actor, "person" as never)).toBe(false);
	});

	// §4.6 #9: permission resolution erroring must never be read as "no restrictions".
	// The set is the only source, so an unknown permission is simply absent.
	test("an unrecognised permission is denied, not ignored", () => {
		expect(can(anonymousActor([]), "made:up" as never)).toBe(false);
	});
});

describe("the actor is immutable", () => {
	test("its permission set cannot be widened after the fact", () => {
		const actor = anonymousActor(["person:preview"]);

		expect(() =>
			(actor.permissions as Permission[]).push("person:view"),
		).toThrow();
		expect(can(actor, "person:view")).toBe(false);
	});
});

describe("resolveActor", () => {
	const resolution = {
		publicPermissions: async (): Promise<Permission[]> => ["place:preview"],
		permissionsOfUser: async (): Promise<Permission[]> => ["place:moderate"],
	};

	test("anonymous gets the public set and nothing else", async () => {
		const actor = await resolveActor(resolution, null);
		expect(isAnonymous(actor)).toBe(true);
		expect([...actor.permissions]).toEqual(["place:preview"]);
	});

	test("an account gets the union, never less than a stranger", async () => {
		const actor = await resolveActor(resolution, "user-1");
		expect(actor.id).toBe("user-1");
		expect(can(actor, "place:preview")).toBe(true);
		expect(can(actor, "place:moderate")).toBe(true);
	});

	// §4.6 #9: an error is never "no restrictions" — and not a silent downgrade either.
	test("a failure to read either half refuses rather than guessing", async () => {
		const failing = new Error("connection reset");

		for (const broken of [
			{ ...resolution, publicPermissions: async () => Promise.reject(failing) },
			{ ...resolution, permissionsOfUser: async () => Promise.reject(failing) },
		]) {
			const error = await resolveActor(broken, "user-1").catch(
				(caught) => caught as Error,
			);
			expect(error).toBeInstanceOf(PermissionResolutionError);
			expect((error as Error).cause).toBe(failing);
		}
	});
});

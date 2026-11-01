import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Permission } from "../domain/actor";
import {
	assertEveryRouteDeclared,
	createGuards,
	exempt,
	UndeclaredRouteError,
} from "./guard";

/**
 * PLAN.md §4.4: route permissions are declared per route and fail closed.
 */

const guardsFor = (
	publicSet: Permission[],
	own: Permission[] = [],
	userId: string | null = null,
) =>
	createGuards({
		resolution: {
			publicPermissions: async () => publicSet,
			permissionsOfUser: async () => own,
		},
		identify: async () => userId,
	});

describe("requires", () => {
	test("admits a caller holding the permission and hands the handler its actor", async () => {
		const { requires } = guardsFor(["place:preview"], ["place:view"], "u1");
		const app = new Hono().get("/", requires("place:view"), (c) =>
			c.json({ id: c.var.actor.id }),
		);

		const response = await app.request("/");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ id: "u1" });
	});

	// Anonymous is an actor without the permission, not a special case.
	test("refuses a caller without it with 403, anonymous included", async () => {
		const { requires } = guardsFor(["place:preview"]);
		const app = new Hono().get("/", requires("place:view"), (c) =>
			c.text("no"),
		);

		const response = await app.request("/");
		expect(response.status).toBe(403);
	});

	test("anonymous holds what the public roles grant", async () => {
		const { requires } = guardsFor(["place:preview"]);
		const app = new Hono().get("/", requires("place:preview"), (c) =>
			c.text("yes"),
		);

		expect((await app.request("/")).status).toBe(200);
	});

	// §4.6 #9: an error is not "no restrictions" — the handler must not run.
	test("refuses with 503 when permissions cannot be resolved", async () => {
		let ran = false;
		const { requires } = createGuards({
			resolution: {
				publicPermissions: () => Promise.reject(new Error("db down")),
				permissionsOfUser: async () => [],
			},
			identify: async () => null,
		});
		const app = new Hono().get("/", requires("place:preview"), (c) => {
			ran = true;
			return c.text("leaked");
		});

		const response = await app.request("/");
		expect(response.status).toBe(503);
		expect(ran).toBe(false);
	});
});

describe("assertEveryRouteDeclared", () => {
	const { requires } = guardsFor([]);

	test("accepts routes that require a permission or are exempt", () => {
		const app = new Hono()
			.get("/a", requires("place:view"), (c) => c.text("a"))
			.get("/b", exempt("a reason"), (c) => c.text("b"));

		expect(() => assertEveryRouteDeclared(app)).not.toThrow();
	});

	test("refuses a route that declares nothing, and names it", () => {
		const app = new Hono()
			.get("/a", requires("place:view"), (c) => c.text("a"))
			.post("/forgot", (c) => c.text("open"));

		const error = (() => {
			try {
				assertEveryRouteDeclared(app);
			} catch (caught) {
				return caught as UndeclaredRouteError;
			}
		})();

		expect(error).toBeInstanceOf(UndeclaredRouteError);
		expect(error?.routes).toEqual(["POST /forgot"]);
	});

	// App-wide middleware is not a declaration for any particular route.
	test("app-wide middleware does not count as declaring a route", () => {
		const app = new Hono().use(exempt("blanket")).get("/a", (c) => c.text("a"));

		expect(() => assertEveryRouteDeclared(app)).toThrow(UndeclaredRouteError);
	});

	test("sees declarations in mounted controllers", () => {
		const controller = new Hono().get("/", requires("place:view"), (c) =>
			c.text("x"),
		);
		const app = new Hono().route("/places", controller);

		expect(() => assertEveryRouteDeclared(app)).not.toThrow();
	});

	// Hono wraps a mounted app's handlers when it has its own error handler.
	test("sees declarations in a mounted controller with its own error handler", () => {
		const controller = new Hono()
			.onError((_, c) => c.text("handled", 500))
			.get("/", requires("place:view"), (c) => c.text("x"));
		const app = new Hono().route("/places", controller);

		expect(() => assertEveryRouteDeclared(app)).not.toThrow();

		const undeclared = new Hono()
			.onError((_, c) => c.text("handled", 500))
			.get("/", (c) => c.text("x"));
		expect(() =>
			assertEveryRouteDeclared(new Hono().route("/x", undeclared)),
		).toThrow(UndeclaredRouteError);
	});

	test("an exemption has to say why", () => {
		expect(() => exempt("  ")).toThrow();
	});
});

import { describe, expect, test } from "bun:test";
import { createApp } from "./app";

const ok = () => Promise.resolve();
const fail = () => Promise.reject(new Error("connection refused"));

const appWith = (probes: Parameters<typeof createApp>[0]["probes"]) =>
	createApp({ probes });

describe("GET /health", () => {
	test("answers 200 with a per-dependency report when everything is up", async () => {
		const response = await appWith({ database: ok, storage: ok }).request(
			"/health",
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			checks: {
				database: { status: "ok" },
				storage: { status: "ok" },
			},
		});
	});

	test("answers 503 when a dependency is unreachable", async () => {
		const response = await appWith({ database: fail, storage: ok }).request(
			"/health",
		);

		expect(response.status).toBe(503);

		const body = (await response.json()) as { status: string };
		expect(body.status).toBe("degraded");
	});

	test("answers 503 when nothing is reachable", async () => {
		const response = await appWith({ database: fail, storage: fail }).request(
			"/health",
		);

		expect(response.status).toBe(503);
		expect(((await response.json()) as { status: string }).status).toBe("down");
	});

	// PLAN.md §4.4 / §4.6 #10: nothing is HTTP-cached yet, and the default has to stay
	// `no-store` so that adding caching later is opt-in per route rather than a silent
	// flip to something permissive.
	test("is not cacheable", async () => {
		const response = await appWith({ database: ok, storage: ok }).request(
			"/health",
		);

		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	test("sends no-store even on a failed response", async () => {
		const response = await appWith({ database: fail, storage: fail }).request(
			"/health",
		);

		expect(response.headers.get("cache-control")).toBe("no-store");
	});
});

describe("the app", () => {
	test("404s an unknown path", async () => {
		const response = await appWith({ database: ok, storage: ok }).request(
			"/nope",
		);

		expect(response.status).toBe(404);
	});
});

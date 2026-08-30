import { describe, expect, test } from "bun:test";
import { checkHealth } from "./health";

const ok = () => Promise.resolve();
const fail = (message: string) => () => Promise.reject(new Error(message));
const never = () => new Promise<void>(() => {});

describe("checkHealth", () => {
	test("is ok when every dependency answers", async () => {
		const report = await checkHealth({ database: ok, storage: ok });

		expect(report.status).toBe("ok");
		expect(report.checks).toEqual({
			database: { status: "ok" },
			storage: { status: "ok" },
		});
	});

	test("is degraded when some dependencies answer and some do not", async () => {
		const report = await checkHealth({
			database: ok,
			storage: fail("bucket missing"),
		});

		expect(report.status).toBe("degraded");
		expect(report.checks.database.status).toBe("ok");
		expect(report.checks.storage).toEqual({
			status: "error",
			detail: "bucket missing",
		});
	});

	test("is down when no dependency answers", async () => {
		const report = await checkHealth({
			database: fail("connection refused"),
			storage: fail("connection refused"),
		});

		expect(report.status).toBe("down");
	});

	test("treats a probe that never settles as an error", async () => {
		const report = await checkHealth(
			{ database: never, storage: ok },
			{ timeoutMs: 10 },
		);

		expect(report.checks.database.status).toBe("error");
		expect(report.checks.database.detail).toContain("timed out");
		expect(report.status).toBe("degraded");
	});

	test("runs the probes concurrently rather than one after another", async () => {
		const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

		const started = Date.now();
		await checkHealth({ database: slow, storage: slow });

		expect(Date.now() - started).toBeLessThan(120);
	});

	// A probe failure message can carry the connection string it failed to reach —
	// credentials included. The report is served over HTTP, so it must not.
	test("redacts credentials that a probe error carries in a url", async () => {
		const report = await checkHealth({
			database: fail(
				"failed to connect to postgres://dorf:hunter2@db.example:5432/archive",
			),
			storage: ok,
		});

		expect(report.checks.database.detail).not.toContain("hunter2");
		expect(report.checks.database.detail).toContain("postgres://");
	});

	test("survives a probe that throws something which is not an Error", async () => {
		const report = await checkHealth({
			database: () => Promise.reject("nope"),
			storage: ok,
		});

		expect(report.checks.database).toEqual({
			status: "error",
			detail: "unknown error",
		});
	});
});

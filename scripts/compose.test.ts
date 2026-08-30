import { describe, expect, test } from "bun:test";
import {
	assertNonDestructive,
	buildComposeArgs,
	DestructiveComposeError,
} from "./compose";

describe("buildComposeArgs", () => {
	test("targets the dependencies-only file for the dev stack", () => {
		const args = buildComposeArgs("dev", ["up", "-d"], { envFile: null });

		expect(args).toEqual([
			"compose",
			"--file",
			"project/compose.dev.yml",
			"up",
			"-d",
		]);
	});

	test("targets the full stack file for the full stack", () => {
		const args = buildComposeArgs("full", ["down"], { envFile: null });

		expect(args).toContain("project/compose.yml");
	});

	test("passes an env file through when there is one", () => {
		const args = buildComposeArgs("dev", ["up"], { envFile: "/repo/.env" });

		expect(args.join(" ")).toContain("--env-file /repo/.env");
	});

	test("omits --env-file entirely when there is none, rather than pointing at a missing path", () => {
		const args = buildComposeArgs("dev", ["up"], { envFile: null });

		expect(args).not.toContain("--env-file");
	});

	test("keeps the compose file ahead of the subcommand", () => {
		const args = buildComposeArgs("dev", ["up"], { envFile: "/repo/.env" });

		expect(args.indexOf("project/compose.dev.yml")).toBeLessThan(
			args.indexOf("up"),
		);
	});
});

// PLAN.md §4.1: "teardown is `down` without `-v`. Volumes are named and survive, so
// stopping the dev stack must never wipe the local database."
describe("assertNonDestructive", () => {
	test("allows a plain down", () => {
		expect(() => assertNonDestructive(["down"])).not.toThrow();
	});

	test.each([["-v"], ["--volumes"]])(
		"refuses `down %s`, which would wipe the local database",
		(flag) => {
			expect(() => assertNonDestructive(["down", flag])).toThrow(
				DestructiveComposeError,
			);
		},
	);

	test("allows volume removal when it is asked for explicitly", () => {
		expect(() =>
			assertNonDestructive(["down", "-v", "--yes-destroy-data"]),
		).not.toThrow();
	});

	test("does not mistake an unrelated -v for volume removal", () => {
		expect(() => assertNonDestructive(["up", "-d"])).not.toThrow();
		expect(() => assertNonDestructive(["logs", "-f"])).not.toThrow();
	});

	test("strips the acknowledgement flag before docker sees it", () => {
		expect(assertNonDestructive(["down", "-v", "--yes-destroy-data"])).toEqual([
			"down",
			"-v",
		]);
	});
});

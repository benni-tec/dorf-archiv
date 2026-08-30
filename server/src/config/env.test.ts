import { describe, expect, test } from "bun:test";
import { EnvError, loadEnv } from "./env";

const complete = {
	DATABASE_URL: "postgres://dorf:dorf@localhost:5432/dorf_archiv",
	S3_ENDPOINT: "http://localhost:9000",
	S3_BUCKET: "dorf-archiv",
	S3_ACCESS_KEY_ID: "dorf",
	S3_SECRET_ACCESS_KEY: "sup3rs3cret",
};

describe("loadEnv", () => {
	test("reads a complete environment into a nested config object", () => {
		const env = loadEnv({
			...complete,
			PORT: "4000",
			S3_REGION: "eu-central-1",
			TEXT_SEARCH_CONFIG: "german_hunspell",
		});

		expect(env).toEqual({
			port: 4000,
			databaseUrl: complete.DATABASE_URL,
			textSearchConfig: "german_hunspell",
			storage: {
				endpoint: complete.S3_ENDPOINT,
				region: "eu-central-1",
				bucket: complete.S3_BUCKET,
				accessKeyId: complete.S3_ACCESS_KEY_ID,
				secretAccessKey: complete.S3_SECRET_ACCESS_KEY,
				forcePathStyle: true,
			},
		});
	});

	test("applies defaults for everything optional", () => {
		const env = loadEnv(complete);

		expect(env.port).toBe(3000);
		expect(env.storage.region).toBe("us-east-1");
		expect(env.storage.forcePathStyle).toBe(true);
	});

	// PLAN.md §4.3: the text-search configuration name is a setting, never a constant.
	// Stock `german` is the degraded-but-working default; a Hunspell-equipped host
	// overrides it.
	test("defaults the text search configuration to stock german", () => {
		expect(loadEnv(complete).textSearchConfig).toBe("german");
	});

	test("rejects a blank text search configuration rather than silently defaulting", () => {
		expect(() => loadEnv({ ...complete, TEXT_SEARCH_CONFIG: "  " })).toThrow(
			EnvError,
		);
	});

	test("reports every missing variable at once, not just the first", () => {
		let issues: string[] = [];
		try {
			loadEnv({ S3_ENDPOINT: complete.S3_ENDPOINT });
		} catch (error) {
			issues = (error as EnvError).issues;
		}

		const reported = issues.join("\n");
		expect(reported).toContain("DATABASE_URL");
		expect(reported).toContain("S3_BUCKET");
		expect(reported).toContain("S3_ACCESS_KEY_ID");
		expect(reported).toContain("S3_SECRET_ACCESS_KEY");
	});

	test("never echoes a supplied value back in the error", () => {
		let message = "";
		try {
			loadEnv({ ...complete, DATABASE_URL: undefined, PORT: "not-a-port" });
		} catch (error) {
			message = (error as EnvError).message;
		}

		expect(message).not.toContain("sup3rs3cret");
		expect(message).not.toContain("not-a-port");
		expect(message).toContain("PORT");
	});

	test.each([
		["false", false],
		["0", false],
		["no", false],
		["true", true],
		["1", true],
	])("reads S3_FORCE_PATH_STYLE=%s as %p", (raw, expected) => {
		expect(
			loadEnv({ ...complete, S3_FORCE_PATH_STYLE: raw }).storage.forcePathStyle,
		).toBe(expected);
	});

	test("rejects a port that is not a number", () => {
		expect(() => loadEnv({ ...complete, PORT: "3000x" })).toThrow(EnvError);
	});

	test("rejects a database url that is not postgres", () => {
		expect(() =>
			loadEnv({ ...complete, DATABASE_URL: "mysql://localhost/dorf" }),
		).toThrow(EnvError);
	});

	test("rejects an endpoint that is not a url", () => {
		expect(() =>
			loadEnv({ ...complete, S3_ENDPOINT: "localhost:9000" }),
		).toThrow(EnvError);
	});
});

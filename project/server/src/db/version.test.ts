import { describe, expect, test } from "bun:test";
import {
	assertSupportedPostgres,
	MINIMUM_POSTGRES_MAJOR,
	UnsupportedPostgresError,
} from "./version";

describe("assertSupportedPostgres", () => {
	test("accepts the minimum supported major version", () => {
		expect(() => assertSupportedPostgres(180000)).not.toThrow();
	});

	test("accepts a later major version", () => {
		expect(() => assertSupportedPostgres(190003)).not.toThrow();
	});

	test("rejects anything older", () => {
		expect(() => assertSupportedPostgres(170004)).toThrow(
			UnsupportedPostgresError,
		);
	});

	// The failure this prevents is `function uuidv7() does not exist` from the first
	// migration, which reads as a broken migration rather than a wrong server version.
	test("names both the requirement and what it found", () => {
		let message = "";
		try {
			assertSupportedPostgres(160009);
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toContain(String(MINIMUM_POSTGRES_MAJOR));
		expect(message).toContain("16");
		expect(message).toContain("uuidv7");
	});

	test("rejects a version number it cannot make sense of", () => {
		expect(() => assertSupportedPostgres(Number.NaN)).toThrow(
			UnsupportedPostgresError,
		);
		expect(() => assertSupportedPostgres(0)).toThrow(UnsupportedPostgresError);
	});
});

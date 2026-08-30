import { z } from "zod";

/**
 * Every connection parameter is an environment variable (PLAN.md §4.1), so that the same
 * source serves development, Compose-as-production and app-container-plus-external-services
 * without a code change. This module is the only place that reads them: the rest of the
 * server takes a {@link ServerEnv}, which is why nothing downstream can quietly grow a
 * `process.env` lookup with a silent default.
 */

const booleanish = z
	.string()
	.trim()
	.toLowerCase()
	.pipe(z.enum(["true", "1", "yes", "on", "false", "0", "no", "off"]))
	.transform((value) => ["true", "1", "yes", "on"].includes(value));

const nonEmpty = z.string().trim().min(1);

const schema = z.object({
	PORT: z.coerce.number().int().positive().max(65535).default(3000),

	DATABASE_URL: nonEmpty.refine(
		(value) => /^postgres(ql)?:\/\//.test(value),
		"must be a postgres:// or postgresql:// connection string",
	),

	/**
	 * PLAN.md §4.3: a Hunspell `de_DE` dictionary gives German compound splitting, but
	 * installing one needs filesystem access many hosts cannot grant. The configuration
	 * name is therefore a setting and never a constant — stock `german` works with reduced
	 * recall, `german_hunspell` (what the `postgres/` image builds) works at full quality.
	 */
	TEXT_SEARCH_CONFIG: nonEmpty.default("german"),

	S3_ENDPOINT: nonEmpty.refine(
		(value) => /^https?:\/\//.test(value) && URL.canParse(value),
		"must be an absolute http(s) URL, e.g. http://localhost:9000",
	),
	S3_REGION: nonEmpty.default("us-east-1"),
	S3_BUCKET: nonEmpty,
	S3_ACCESS_KEY_ID: nonEmpty,
	S3_SECRET_ACCESS_KEY: nonEmpty,
	/** Garage and most self-hosted S3 implementations serve path-style URLs only. */
	S3_FORCE_PATH_STYLE: booleanish.default(true),
});

export type ServerEnv = {
	port: number;
	databaseUrl: string;
	textSearchConfig: string;
	storage: {
		endpoint: string;
		region: string;
		bucket: string;
		accessKeyId: string;
		secretAccessKey: string;
		forcePathStyle: boolean;
	};
};

export class EnvError extends Error {
	readonly issues: string[];

	constructor(issues: string[]) {
		super(
			`Invalid environment configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
		);
		this.name = "EnvError";
		this.issues = issues;
	}
}

/**
 * Validates a raw environment and returns the server's configuration.
 *
 * Reports every problem at once — a startup that fails one variable per restart wastes the
 * operator's afternoon — and reports only variable *names* and expectations, never the
 * supplied values, since half of them are credentials.
 *
 * @throws {EnvError} if anything is missing or malformed.
 */
export function loadEnv(source: Record<string, string | undefined>): ServerEnv {
	const result = schema.safeParse(source);

	if (!result.success) {
		throw new EnvError(
			result.error.issues.map(
				(issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
			),
		);
	}

	const raw = result.data;

	return {
		port: raw.PORT,
		databaseUrl: raw.DATABASE_URL,
		textSearchConfig: raw.TEXT_SEARCH_CONFIG,
		storage: {
			endpoint: raw.S3_ENDPOINT,
			region: raw.S3_REGION,
			bucket: raw.S3_BUCKET,
			accessKeyId: raw.S3_ACCESS_KEY_ID,
			secretAccessKey: raw.S3_SECRET_ACCESS_KEY,
			forcePathStyle: raw.S3_FORCE_PATH_STYLE,
		},
	};
}

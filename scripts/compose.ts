#!/usr/bin/env bun
/**
 * Thin wrapper around `docker compose`, so nobody types paths (PLAN.md §4.1).
 *
 * Bun rather than a shell script because it behaves the same on Windows and Linux, which
 * matters here: this is the one part of the toolchain a contributor hits before anything
 * else works. Bun is a hard requirement for the repository, so this uses Bun's own APIs
 * rather than the Node compatibility layer.
 *
 * Usage: bun scripts/compose.ts <deps|full> <...docker compose arguments>
 */

export type Stack = "deps" | "full";

const COMPOSE_FILES: Record<Stack, string> = {
	/** Backing services only — what development runs against source on the host. */
	deps: "project/compose.infra.yml",
	/** The whole stack, application and client included. */
	full: "project/compose.yml",
};

/** This file lives in `scripts/`, so the repository root is one level up. */
export const REPO_ROOT = Bun.fileURLToPath(new URL("..", import.meta.url));

/**
 * The flag that has to be typed alongside `-v` to actually remove volumes. It is stripped
 * before docker sees it.
 */
const DESTROY_ACKNOWLEDGEMENT = "--yes-destroy-data";

export class DestructiveComposeError extends Error {
	constructor() {
		super(
			`Refusing to remove volumes: that deletes the local Postgres data and the MinIO bucket.\n` +
				`Teardown is \`down\` without \`-v\`. If you really mean it, add ${DESTROY_ACKNOWLEDGEMENT}.`,
		);
		this.name = "DestructiveComposeError";
	}
}

/**
 * Guards the one Compose invocation that destroys work: `down -v`.
 *
 * PLAN.md §4.1 makes this an invariant rather than a habit — volumes are named and must
 * survive teardown, because `dev:deps` tears the stack down every time you stop it.
 *
 * @returns the arguments with the acknowledgement flag removed.
 * @throws {DestructiveComposeError} if volumes would be removed without acknowledgement.
 */
export function assertNonDestructive(args: string[]): string[] {
	const acknowledged = args.includes(DESTROY_ACKNOWLEDGEMENT);
	const remaining = args.filter((arg) => arg !== DESTROY_ACKNOWLEDGEMENT);

	const removesVolumes =
		remaining[0] === "down" &&
		remaining.some((arg) => arg === "-v" || arg === "--volumes");

	if (removesVolumes && !acknowledged) throw new DestructiveComposeError();

	return remaining;
}

/**
 * Builds the `docker` argument list for a stack.
 *
 * The compose file's directory becomes Compose's project directory, which is what makes the
 * relative build contexts resolve. The env file is passed only when one exists — every
 * variable has a development default, so a missing `.env` is not an error.
 */
export function buildComposeArgs(
	stack: Stack,
	args: string[],
	options: { envFile: string | null },
): string[] {
	const composeArgs = ["compose", "--file", COMPOSE_FILES[stack]];

	if (options.envFile) composeArgs.push("--env-file", options.envFile);

	return [...composeArgs, ...args];
}

/**
 * The project's `.env`, or null when there isn't one.
 *
 * Passing it explicitly matters: Compose would otherwise look for a `.env` in its own
 * project directory, and `docker` is spawned from the repository root.
 */
export async function findEnvFile(): Promise<string | null> {
	const candidate = Bun.fileURLToPath(
		new URL("../project/.env", import.meta.url),
	);
	return (await Bun.file(candidate).exists()) ? candidate : null;
}

/** Spawns `docker` with the given compose arguments, inheriting the terminal. */
export async function spawnCompose(stack: Stack, args: string[]) {
	return Bun.spawn(
		[
			"docker",
			...buildComposeArgs(stack, args, { envFile: await findEnvFile() }),
		],
		{ cwd: REPO_ROOT, stdio: ["inherit", "inherit", "inherit"] },
	);
}

function isStack(value: string | undefined): value is Stack {
	return value === "deps" || value === "full";
}

if (import.meta.main) {
	const [stack, ...rest] = Bun.argv.slice(2);

	if (!isStack(stack)) {
		console.error(
			"Usage: bun scripts/compose.ts <deps|full> <...compose arguments>",
		);
		process.exit(2);
	}

	try {
		const child = await spawnCompose(stack, assertNonDestructive(rest));
		process.exit(await child.exited);
	} catch (error) {
		console.error(
			error instanceof DestructiveComposeError ? error.message : error,
		);
		process.exit(1);
	}
}

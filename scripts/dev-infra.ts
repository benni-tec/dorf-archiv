#!/usr/bin/env bun
/**
 * Brings up Postgres and SeaweedFS in the foreground and tears them down when you stop it —
 * `bun run dev:infra` (PLAN.md §4.1).
 *
 * Foreground with automatic teardown, so there is no separate stop script to forget. Plain
 * `docker compose up` stops the containers on Ctrl+C but leaves them lying around, and
 * chaining `; docker compose down` after it does not survive an interrupt on Windows —
 * hence a wrapper that owns the signal handling.
 *
 * Teardown is `down`, never `down -v`: the volumes are named and the local database has to
 * survive being stopped. `scripts/compose.ts` enforces that.
 */
import { spawnCompose } from "./compose";

const child = await spawnCompose("dev", ["up"]);

let interrupts = 0;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	// Registering a handler suppresses the default "die immediately" behaviour, which is
	// the whole point: Docker Compose receives the same interrupt and begins stopping the
	// containers, and we want to still be alive afterwards to run `down`.
	process.on(signal, () => {
		interrupts += 1;
		if (interrupts === 1) {
			console.log(
				"\nStopping dependencies… (Ctrl+C again to leave them running)",
			);
			return;
		}
		console.log(
			"\nLeaving containers up. `bun run dev:infra:down` when you're done.",
		);
		process.exit(130);
	});
}

const upExitCode = await child.exited;

console.log("\nTearing down dependencies (named volumes are kept)…");
const down = await spawnCompose("dev", ["down"]);
const downExitCode = await down.exited;

process.exit(upExitCode || downExitCode);

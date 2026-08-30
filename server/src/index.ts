import { createApp } from "./app";
import { EnvError, loadEnv } from "./config/env";
import { createDatabase } from "./db/client";
import { createStorage } from "./storage/client";

/**
 * The composition root — the only place that reads the environment or opens a connection.
 * Everything below it takes what it needs as an argument, which is what keeps the app
 * testable without a database and what stops a silent `process.env` default appearing in
 * the middle of the domain later.
 */

function readEnvironmentOrExit() {
	try {
		return loadEnv(process.env);
	} catch (error) {
		if (error instanceof EnvError) {
			// The message names every offending variable and none of their values.
			console.error(error.message);
			console.error("\nSee .env.example for what each variable is for.");
			process.exit(1);
		}
		throw error;
	}
}

const env = readEnvironmentOrExit();

const database = createDatabase(env);
const storage = createStorage(env);

const app = createApp({
	probes: {
		database: database.probe,
		storage: storage.probe,
	},
});

let shuttingDown = false;

async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;

	await Promise.allSettled([database.close(), storage.close()]);
	process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, shutdown);
}

export default {
	port: env.port,
	fetch: app.fetch,
};

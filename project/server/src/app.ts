import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	assertEveryRouteDeclared,
	type GuardDependencies,
} from "./controllers/guard";
import { createHealthController } from "./controllers/health";
import type { Probe, ProbeName } from "./domain/health";

/**
 * The HTTP app, assembled from injected dependencies.
 *
 * A factory rather than a module-level const so that the composition root (`index.ts`) is
 * the only place that reads the environment or opens a connection, and so tests can drive
 * the real routes without a database. `index.ts` builds the one instance the process serves.
 */

export type AppDependencies = {
	probes: Record<ProbeName, Probe>;
	/** How a request becomes an actor — see `controllers/guard.ts`. */
	guards: GuardDependencies;
};

export function createApp(dependencies: AppDependencies) {
	// One chained expression, and each mounted controller likewise: this is what Hono
	// derives `AppType` from, and assigning routes as separate statements erases them from
	// the client's types without any error (PLAN.md §5.1).
	const app = new Hono()
		// TODO(auth, PLAN.md §8 step 3): narrow this to the client's origin once there are
		// sessions to protect. Wide-open CORS is harmless while nothing is authenticated
		// and a hole the moment something is.
		.use(cors())
		.use(async (c, next) => {
			await next();
			// PLAN.md §4.4: nothing is HTTP-cached yet, and §4.6 #10 makes the permissive
			// default the hazard — caching stays opt-in per route, `no-store` stays here.
			c.header("Cache-Control", "no-store");
		})
		.route("/health", createHealthController(dependencies.probes));

	// PLAN.md §4.4: a route declaring no permission is refused at startup rather than served
	// unguarded. Checked here, where the whole app exists, so no route can be mounted after.
	assertEveryRouteDeclared(app);

	return app;
}

export type App = ReturnType<typeof createApp>;

import { Hono } from "hono";
import { checkHealth, type Probe, type ProbeName } from "../domain/health";
import { exempt } from "./guard";

/**
 * The health endpoint.
 *
 * Deliberately outside the permission system: it reports reachability and nothing about
 * archive content, and an orchestrator has to be able to call it before anything is
 * configured — including while the database holding the permissions is down. So it is
 * explicitly `exempt`, which the fail-closed startup check (PLAN.md §4.4) accepts and a
 * route that simply forgot would not.
 *
 * One chained expression, as Hono's RPC types require (PLAN.md §5.1) — splitting these into
 * separate `controller.get(...)` statements silently erases the route from the client.
 */
export function createHealthController(probes: Record<ProbeName, Probe>) {
	return new Hono().get(
		"/",
		exempt(
			"reports reachability only, and must answer while the database is down",
		),
		async (c) => {
			const report = await checkHealth(probes);

			// Degraded is served as unavailable too: an archive that cannot reach its object
			// storage cannot serve a single photograph, so there is nothing useful to route to.
			//
			// Two branches rather than a ternary status, because a computed status widens to
			// `number` and Hono then infers the response type as `never` on the client side.
			return report.status === "ok" ? c.json(report, 200) : c.json(report, 503);
		},
	);
}

import { Hono } from "hono";
import { checkHealth, type Probe, type ProbeName } from "../domain/health";

/**
 * The health endpoint.
 *
 * Deliberately outside the permission system: it reports reachability and nothing about
 * archive content, and an orchestrator has to be able to call it before anything is
 * configured. When the fail-closed route declaration lands (PLAN.md §4.4 — a route naming
 * no permission is rejected at startup), this route needs an explicit exemption rather than
 * being allowed to slip through as one that simply forgot.
 *
 * One chained expression, as Hono's RPC types require (PLAN.md §5.1) — splitting these into
 * separate `controller.get(...)` statements silently erases the route from the client.
 */
export function createHealthController(probes: Record<ProbeName, Probe>) {
	return new Hono().get("/", async (c) => {
		const report = await checkHealth(probes);

		// Degraded is served as unavailable too: an archive that cannot reach its object
		// storage cannot serve a single photograph, so there is nothing useful to route to.
		//
		// Two branches rather than a ternary status, because a computed status widens to
		// `number` and Hono then infers the response type as `never` on the client side.
		return report.status === "ok" ? c.json(report, 200) : c.json(report, 503);
	});
}

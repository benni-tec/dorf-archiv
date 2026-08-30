/**
 * Dependency health, framework-free (PLAN.md §5.1) — no Hono types here, so the same
 * check is callable from a startup gate or a background job, not only from a request.
 *
 * The probes are injected rather than imported, which is what lets every branch below be
 * tested without a running Postgres or object store.
 */

/**
 * The dependencies worth reporting on, in the order they are reported. Declared as a tuple
 * rather than derived from the caller's object, so iteration keeps its type instead of
 * widening through `Object.keys` and needing casts back.
 */
export const PROBE_NAMES = ["database", "storage"] as const;

export type ProbeName = (typeof PROBE_NAMES)[number];

/** A probe resolves if the dependency answered, and rejects otherwise. */
export type Probe = () => Promise<unknown>;

export type CheckResult =
	| { status: "ok" }
	| { status: "error"; detail: string };

export type HealthReport = {
	/** `ok` — everything answered · `degraded` — some did · `down` — none did. */
	status: "ok" | "degraded" | "down";
	checks: Record<ProbeName, CheckResult>;
};

export type HealthOptions = {
	/** A dependency that has not answered within this budget counts as unreachable. */
	timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * A connection failure typically names the endpoint it failed to reach, and our endpoints
 * carry credentials. The health report is served over HTTP, so strip userinfo out of
 * anything URL-shaped before it leaves this module.
 */
function redactCredentials(text: string): string {
	return text.replace(
		/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi,
		(_match, scheme: string) => `${scheme}***@`,
	);
}

function describe(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	return message ? redactCredentials(message) : "unknown error";
}

async function runProbe(probe: Probe, timeoutMs: number): Promise<CheckResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;

	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});

	try {
		await Promise.race([probe(), timeout]);
		return { status: "ok" };
	} catch (error) {
		return { status: "error", detail: describe(error) };
	} finally {
		// Leaving the timer armed would reject `timeout` long after the race settled,
		// with nothing listening by then — an unhandled rejection, and a pending timer
		// holding the process open.
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Runs every probe concurrently and folds the results into one report. */
export async function checkHealth(
	probes: Record<ProbeName, Probe>,
	options: HealthOptions = {},
): Promise<HealthReport> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const results = await Promise.all(
		PROBE_NAMES.map(
			async (name) => [name, await runProbe(probes[name], timeoutMs)] as const,
		),
	);

	const healthy = results.filter(([, result]) => result.status === "ok").length;

	return {
		status:
			healthy === results.length ? "ok" : healthy === 0 ? "down" : "degraded",
		// `Object.fromEntries` widens the key back to `string`; the tuple above is what
		// makes narrowing it again honest rather than a guess.
		checks: Object.fromEntries(results) as Record<ProbeName, CheckResult>,
	};
}

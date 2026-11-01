import type { Context, Hono, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import {
	type Actor,
	type ActorResolution,
	can,
	type Permission,
	PermissionResolutionError,
	resolveActor,
} from "../domain/actor";

/**
 * Route permissions, declared per route and **failing closed** — PLAN.md §4.4, §5.1.
 *
 * Forgetting the check on a new endpoint is the realistic failure mode, so it is made
 * impossible rather than discouraged: every route either `requires(permission)` or is
 * explicitly `exempt(reason)`, and {@link assertEveryRouteDeclared} refuses to build an app
 * containing a route that does neither. A route that simply forgot is rejected at startup
 * rather than served unguarded.
 *
 * Authorization lives here, in the HTTP layer, and not in the services: services are also
 * called by background jobs acting as the system rather than as a user (§5.1).
 */

/** What a guarded handler can read: the resolved caller, never absent. */
export type GuardedEnv = { Variables: { actor: Actor } };

export type GuardDependencies = {
	resolution: ActorResolution;
	/**
	 * The signed-in account behind a request, or null for an anonymous one.
	 *
	 * Until sessions exist (PLAN.md §8 step 3) this answers null for everyone, which is the
	 * honest answer rather than a placeholder: every caller *is* anonymous, and anonymous is
	 * an actor holding the public role set, not the absence of one.
	 */
	identify: (c: Context) => Promise<string | null>;
};

const DECLARATION = Symbol("route permission declaration");

/**
 * Where Hono keeps the original handler when `.route()` wraps one — it does so for a mounted
 * app that has its own error handler. Without unwrapping, a controller gaining an `onError`
 * would make every one of its declarations invisible, and the startup check would refuse
 * routes that are in fact guarded. (`hono/utils/constants`, not part of the public API.)
 */
const COMPOSED_HANDLER = "__COMPOSED_HANDLER";

type Declared = MiddlewareHandler & {
	[DECLARATION]?: { permission: Permission } | { exempt: string };
};

export function createGuards(dependencies: GuardDependencies) {
	/**
	 * Admits the request only if the caller holds `permission`, and makes the caller
	 * available to the handler as `c.var.actor`.
	 *
	 * The actor is resolved here rather than by an app-wide middleware so that an exempt
	 * route never depends on the permission tables — the health check has to answer while
	 * the database is down, which is exactly when it matters.
	 */
	function requires(permission: Permission) {
		const middleware = createMiddleware<GuardedEnv>(async (c, next) => {
			let actor: Actor;
			try {
				actor = await resolveActor(
					dependencies.resolution,
					await dependencies.identify(c),
				);
			} catch (error) {
				// §4.6 #9: deny on error, explicitly. Unavailable rather than forbidden, since
				// nothing is known about whether this caller may proceed.
				if (error instanceof PermissionResolutionError) {
					return c.json({ error: "permissions unavailable" }, 503);
				}
				throw error;
			}

			// One status for "not allowed", whoever is asking: an anonymous caller is an
			// actor without the permission, not a special case (§4.4).
			if (!can(actor, permission)) {
				return c.json({ error: "forbidden", permission }, 403);
			}

			c.set("actor", actor);
			await next();
		}) as Declared;

		middleware[DECLARATION] = { permission };
		return middleware as MiddlewareHandler<GuardedEnv>;
	}

	return { requires };
}

/**
 * Declares that a route deliberately takes no permission, and why.
 *
 * Rare by design. The health check is the case it exists for: it reports reachability and
 * nothing about archive content, and an orchestrator must be able to call it before anything
 * is configured. A reason is required so that every exemption explains itself to a reviewer.
 */
export function exempt(reason: string): MiddlewareHandler {
	if (reason.trim().length === 0) {
		throw new Error("An exempt route has to say why it is exempt.");
	}

	const middleware: Declared = async (_c, next) => {
		await next();
	};
	middleware[DECLARATION] = { exempt: reason };
	return middleware;
}

export class UndeclaredRouteError extends Error {
	readonly routes: string[];

	constructor(routes: string[]) {
		super(
			`These routes declare no permission: ${routes.join(", ")}. Every route must ` +
				"`requires(permission)` or be `exempt(reason)` — an undeclared route is refused " +
				"rather than served unguarded (PLAN.md §4.4).",
		);
		this.name = "UndeclaredRouteError";
		this.routes = routes;
	}
}

/**
 * Throws unless every route in the app carries a declaration ahead of its handler.
 *
 * Hono records each handler in a route's chain as its own entry, and `.use()` middleware as
 * method `ALL`; routes mounted with `.route()` are flattened in with their full paths. So a
 * route is the group of non-`ALL` entries sharing a method and path, and it is declared when
 * one of its entries — not the last, which is the handler itself — is a declaration.
 *
 * @throws {UndeclaredRouteError}
 */
// biome-ignore lint/suspicious/noExplicitAny: any app, whatever its environment and schema.
export function assertEveryRouteDeclared(app: Hono<any, any, any>): void {
	const chains = new Map<string, Declared[]>();

	for (const route of app.routes) {
		if (route.method === "ALL") continue;
		const key = `${route.method} ${route.path}`;
		const chain = chains.get(key) ?? [];
		const handler = route.handler as Declared & {
			[COMPOSED_HANDLER]?: Declared;
		};
		chain.push(handler[COMPOSED_HANDLER] ?? handler);
		chains.set(key, chain);
	}

	const undeclared = [...chains]
		.filter(([, chain]) =>
			chain.slice(0, -1).every((handler) => handler[DECLARATION] === undefined),
		)
		.map(([key]) => key);

	if (undeclared.length > 0) throw new UndeclaredRouteError(undeclared);
}

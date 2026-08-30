import { hc } from "hono/client";
import type { App } from "./app";

/**
 * The typed RPC client. Request and response shapes are inferred from the route handlers,
 * so nothing is duplicated across the boundary (PLAN.md §5.1).
 *
 * The type comes from `./app` rather than `./index`, because `index.ts` is the composition
 * root: importing it would drag connection setup into the client's type resolution.
 */

export type AppType = App;
export type Client = ReturnType<typeof hc<AppType>>;

export const hcWithType = (...args: Parameters<typeof hc>): Client =>
	hc<AppType>(...args);

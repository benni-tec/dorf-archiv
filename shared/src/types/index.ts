/**
 * Cross-boundary types.
 *
 * Empty for now, and deliberately so: response shapes reach the client through Hono RPC
 * inference and need no duplication here (PLAN.md §5.1). What belongs in `shared` is what
 * both sides must *construct* rather than merely receive — request shapes, the content
 * module, rough-date construction and formatting, and the permission definitions (§3).
 */

export {};

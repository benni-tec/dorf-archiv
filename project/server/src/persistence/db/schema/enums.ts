import { pgEnum } from "drizzle-orm/pg-core";

/**
 * The discriminator, on the entity table only (PLAN.md §2.1).
 *
 * The four conceptual layers — Entity, VersionedEntity, LocalizedEntity, HistoricEntity —
 * are *not* values here. They express which capabilities a type has, which the registry
 * knows; materialising them as rows or as joins is what §5.2 explicitly rejects.
 */
export const entityType = pgEnum("entity_type", [
	// Descend from Entity directly: identity and audit, no versions.
	"user",
	"thread",
	"comment",
	// LocalizedEntity, but not archival.
	"tag",
	"terms",
	// HistoricEntity: the archival apparatus — links, sources, comments.
	"person",
	"place",
	"media",
	"story",
	"relationship",
	"source",
]);

/**
 * How precisely a date is known (PLAN.md §2.5).
 *
 * "Specific" is not a member: it is `day`. One concept rather than two with a flag between
 * them.
 */
export const dateGranularity = pgEnum("date_granularity", [
	"day",
	"month",
	"year",
	"decade",
]);

/**
 * Proposals are **never deleted** — a rejected one persists with its reason and the
 * moderator who rejected it (PLAN.md §2.2).
 */
export const proposalStatus = pgEnum("proposal_status", [
	"pending",
	"accepted",
	"rejected",
]);

/**
 * The role a file plays in a Media entity (PLAN.md §5.2).
 *
 * `original` is the untouched upload and is never regenerated; the others are derivatives
 * that can be rebuilt from it, which is what makes a format migration possible without
 * asking contributors for their photographs again.
 */
export const mediaFileRole = pgEnum("media_file_role", [
	"original",
	"web",
	"thumb",
]);

/**
 * Whether a comment is visible. Per comment rather than per thread (PLAN.md §2.8) — one bad
 * reply should not hide a useful conversation.
 */
export const moderationStatus = pgEnum("moderation_status", [
	"pending",
	"approved",
	"rejected",
]);

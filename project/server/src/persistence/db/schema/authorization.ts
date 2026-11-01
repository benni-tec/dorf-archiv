import { sql } from "drizzle-orm";
import {
	check,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { primaryKeyColumn } from "./columns";
import { auditColumns, entity, user } from "./entity";

/**
 * Roles and permissions — PLAN.md §4.4, §5.3.
 *
 * Three tables, keeping roles and permissions distinct: `role`, `role_permission` (role →
 * permission) and `user_role` (user → role). A caller's effective permissions are the public
 * rows plus the permissions of every role they currently hold — one query, no event replay.
 *
 * **Both mapping tables are temporal and never deleted from.** A grant is a row with
 * `granted_at`/`granted_by`; revoking it sets `revoked_at`/`revoked_by` on that same row, and
 * re-granting is a new row. So the history *is* the table rather than a parallel audit log
 * that can drift from it, and "what could this account do on 2027-03-14" is a join of the two
 * filtered at one instant — the difference, for a site whose KUG posture rests on who was
 * permitted to see what, between an audit trail and a plausible story.
 *
 * The audit quartet is carried as well (§2.2a: every mutable row, role grants explicitly
 * included). On a grant row `created_*` and `granted_*` agree; `updated_*` is what moves when
 * it is revoked.
 */

/** A role — admin, moderator, member, the public ones. Which exist is data, not code. */
export const role = pgTable("role", {
	id: primaryKeyColumn(),

	name: text().notNull().unique(),

	...auditColumns(),
});

/** The two columns that make a row temporal, plus the rule that they move together. */
function grantColumns() {
	return {
		grantedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
		grantedBy: uuid()
			.notNull()
			.references(() => entity.id),
		/** Null while the grant is active. Set, never deleted, to revoke it. */
		revokedAt: timestamp({ withTimezone: true }),
		revokedBy: uuid().references(() => entity.id),
	};
}

/**
 * Role → permission.
 *
 * **`role_id IS NULL` marks a public permission**, held by everyone with no role required —
 * which is how an anonymous visitor comes to hold `<entity>:preview` without there being any
 * auth-free code path. What the public may see is an operational decision recorded here, and
 * audited, rather than a constant in the code.
 *
 * That null **fails open**: forgetting the union under-grants and is safe, but an accidental
 * null grants a permission to the entire internet (§4.6 #8). The table cannot tell a
 * deliberate null from an accidental one, so the guard is in the service, which grants public
 * permissions through their own explicitly named function and never accepts a nullable role
 * id from request input.
 */
export const rolePermission = pgTable(
	"role_permission",
	{
		id: primaryKeyColumn(),

		roleId: uuid().references(() => role.id),

		/** `entity type : action`, e.g. `person:view`. */
		permission: text().notNull(),

		...grantColumns(),
		...auditColumns(),
	},
	(table) => [
		// The hot lookup: the permissions of the roles a caller holds, active ones only.
		index("role_permission_active_role_idx")
			.on(table.roleId)
			.where(sql`${table.revokedAt} IS NULL`),
		// Partial, so something revoked can be granted again (§5.3) — a plain unique
		// constraint would refuse the new row because the revoked one is still there.
		uniqueIndex("role_permission_active_unique")
			.on(table.roleId, table.permission)
			.where(sql`${table.revokedAt} IS NULL AND ${table.roleId} IS NOT NULL`),
		// The same rule for public grants needs its own index: a unique index treats nulls
		// as distinct, so the one above would happily hold the same public grant twice.
		uniqueIndex("role_permission_active_public_unique")
			.on(table.permission)
			.where(sql`${table.revokedAt} IS NULL AND ${table.roleId} IS NULL`),
		check(
			"role_permission_revocation_paired",
			sql`(${table.revokedAt} IS NULL) = (${table.revokedBy} IS NULL)`,
		),
		check(
			"role_permission_revoked_after_granted",
			sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.grantedAt}`,
		),
		// Shape only — `type:action`. Which permissions exist is the module's business; this
		// just stops a typo'd or blank string being stored as a grant nothing ever matches.
		check(
			"role_permission_shape",
			sql`${table.permission} ~ '^[a-z][a-z_]*:[a-z][a-z_]*$'`,
		),
	],
);

/**
 * User → role. **Both columns non-nullable** — there is no nullable identity here, so a
 * controller cannot turn a logged-out `session?.user?.id` into a universal grant (§4.4).
 */
export const userRole = pgTable(
	"user_role",
	{
		id: primaryKeyColumn(),

		userId: uuid()
			.notNull()
			.references(() => user.entityId),
		roleId: uuid()
			.notNull()
			.references(() => role.id),

		...grantColumns(),
		...auditColumns(),
	},
	(table) => [
		index("user_role_active_user_idx")
			.on(table.userId)
			.where(sql`${table.revokedAt} IS NULL`),
		uniqueIndex("user_role_active_unique")
			.on(table.userId, table.roleId)
			.where(sql`${table.revokedAt} IS NULL`),
		check(
			"user_role_revocation_paired",
			sql`(${table.revokedAt} IS NULL) = (${table.revokedBy} IS NULL)`,
		),
		check(
			"user_role_revoked_after_granted",
			sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.grantedAt}`,
		),
	],
);

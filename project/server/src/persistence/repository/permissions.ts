import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
	type Actor,
	type Permission,
	requireAccountId,
} from "../../domain/actor";
import { role, rolePermission, userRole } from "../db/schema";

/**
 * Roles, grants and the effective permission set — PLAN.md §4.4.
 *
 * Everything here is temporal: a grant is a row, revoking it stamps `revoked_at`/`revoked_by`
 * on that row, and nothing is ever deleted. Active means `revoked_at IS NULL`.
 *
 * **Public and role-bound grants are separate functions**, and neither takes a nullable role
 * id. `role_id IS NULL` is how the table spells "everyone, including the internet" (§4.6 #8);
 * a single `grant(roleId | null, …)` would let a missing value from request input become a
 * universal grant, so the null is only ever written by the function whose name says so.
 */

type Database = PostgresJsDatabase<Record<string, unknown>>;

const PERMISSION_SHAPE = /^[a-z][a-z_]*:[a-z][a-z_]*$/;

export class InvalidPermissionError extends Error {
	constructor(permission: string) {
		super(
			`"${permission}" is not a permission. Permissions are \`entity:action\`, lower case — ` +
				"`person:view`, `media:propose`.",
		);
		this.name = "InvalidPermissionError";
	}
}

export class GrantNotFoundError extends Error {
	constructor(what: string) {
		super(`There is no active ${what} to revoke.`);
		this.name = "GrantNotFoundError";
	}
}

/** The database refuses a malformed permission too; this says why in words. */
function assertPermission(permission: string): Permission {
	if (!PERMISSION_SHAPE.test(permission)) {
		throw new InvalidPermissionError(permission);
	}
	return permission as Permission;
}

/**
 * The permissions held by everyone — what an anonymous visitor's actor carries.
 *
 * Kept apart from {@link permissionsOfUser} because a signed-in caller's effective set is the
 * *union* of the two (§4.4); a signed-in visitor must never see less than a stranger.
 */
export async function publicPermissions(db: Database): Promise<Permission[]> {
	const rows = await db
		.select({ permission: rolePermission.permission })
		.from(rolePermission)
		.where(
			and(isNull(rolePermission.roleId), isNull(rolePermission.revokedAt)),
		);

	return rows.map((row) => row.permission as Permission);
}

/** The permissions of every role the user currently holds — their own, not the public ones. */
export async function permissionsOfUser(
	db: Database,
	userId: string,
): Promise<Permission[]> {
	const heldRoles = db
		.select({ roleId: userRole.roleId })
		.from(userRole)
		.where(and(eq(userRole.userId, userId), isNull(userRole.revokedAt)));

	const rows = await db
		.selectDistinct({ permission: rolePermission.permission })
		.from(rolePermission)
		.where(
			and(
				isNull(rolePermission.revokedAt),
				inArray(rolePermission.roleId, heldRoles),
			),
		);

	return rows.map((row) => row.permission as Permission);
}

/**
 * The effective set as one query, exactly as §4.4 writes it: the public rows, plus the
 * permissions of every role the user currently holds.
 *
 * {@link publicPermissions} and {@link permissionsOfUser} are the two halves, kept because
 * the actor is built from them separately; this is the same answer in one round trip.
 */
export async function effectivePermissions(
	db: Database,
	userId: string,
): Promise<Permission[]> {
	const heldRoles = db
		.select({ roleId: userRole.roleId })
		.from(userRole)
		.where(and(eq(userRole.userId, userId), isNull(userRole.revokedAt)));

	const rows = await db
		.selectDistinct({ permission: rolePermission.permission })
		.from(rolePermission)
		.where(
			and(
				isNull(rolePermission.revokedAt),
				or(
					isNull(rolePermission.roleId),
					inArray(rolePermission.roleId, heldRoles),
				),
			),
		);

	return rows.map((row) => row.permission as Permission);
}

/** Creates a role. Which roles exist is data rather than code (§4.4). */
export async function createRole(
	db: Database,
	name: string,
	actor: Actor,
): Promise<string> {
	const by = requireAccountId(actor, "create a role");

	const [created] = await db
		.insert(role)
		.values({ name, createdBy: by, updatedBy: by })
		.returning({ id: role.id });

	return (created as { id: string }).id;
}

/**
 * Grants a permission to **everyone**, signed in or not.
 *
 * Its own function, named for what it does, because this is the one write in the system that
 * widens access to the entire internet (§4.6 #8). Nothing reaches it by passing an empty
 * value to something more general.
 */
export async function grantPublicPermission(
	db: Database,
	permission: string,
	actor: Actor,
): Promise<string> {
	const by = requireAccountId(actor, "grant a public permission");

	const [created] = await db
		.insert(rolePermission)
		.values({
			roleId: null,
			permission: assertPermission(permission),
			grantedBy: by,
			createdBy: by,
			updatedBy: by,
		})
		.returning({ id: rolePermission.id });

	return (created as { id: string }).id;
}

/** Grants a permission to the holders of one role. The role id is required, never null. */
export async function grantRolePermission(
	db: Database,
	roleId: string,
	permission: string,
	actor: Actor,
): Promise<string> {
	const by = requireAccountId(actor, "grant a permission");

	const [created] = await db
		.insert(rolePermission)
		.values({
			roleId,
			permission: assertPermission(permission),
			grantedBy: by,
			createdBy: by,
			updatedBy: by,
		})
		.returning({ id: rolePermission.id });

	return (created as { id: string }).id;
}

/**
 * Stamps a revocation onto the active row matching `where`. Never a `DELETE` — the revoked
 * row is the record that the grant existed, who made it and who ended it.
 */
async function revokeWhere(
	db: Database,
	table: typeof rolePermission | typeof userRole,
	where: ReturnType<typeof and>,
	actor: Actor,
	what: string,
): Promise<void> {
	const by = requireAccountId(actor, `revoke a ${what}`);

	const revoked = await db
		.update(table)
		.set({
			revokedAt: sql`now()`,
			revokedBy: by,
			updatedAt: sql`now()`,
			updatedBy: by,
		})
		.where(and(where, isNull(table.revokedAt)))
		.returning({ id: table.id });

	if (revoked.length === 0) throw new GrantNotFoundError(what);
}

export async function revokePublicPermission(
	db: Database,
	permission: string,
	actor: Actor,
): Promise<void> {
	await revokeWhere(
		db,
		rolePermission,
		and(
			isNull(rolePermission.roleId),
			eq(rolePermission.permission, assertPermission(permission)),
		),
		actor,
		`public grant of ${permission}`,
	);
}

export async function revokeRolePermission(
	db: Database,
	roleId: string,
	permission: string,
	actor: Actor,
): Promise<void> {
	await revokeWhere(
		db,
		rolePermission,
		and(
			eq(rolePermission.roleId, roleId),
			eq(rolePermission.permission, assertPermission(permission)),
		),
		actor,
		`grant of ${permission}`,
	);
}

/** Gives a user a role. Both ids required — `user_role` has no nullable identity. */
export async function assignRole(
	db: Database,
	userId: string,
	roleId: string,
	actor: Actor,
): Promise<string> {
	const by = requireAccountId(actor, "assign a role");

	const [created] = await db
		.insert(userRole)
		.values({ userId, roleId, grantedBy: by, createdBy: by, updatedBy: by })
		.returning({ id: userRole.id });

	return (created as { id: string }).id;
}

export async function revokeRole(
	db: Database,
	userId: string,
	roleId: string,
	actor: Actor,
): Promise<void> {
	await revokeWhere(
		db,
		userRole,
		and(eq(userRole.userId, userId), eq(userRole.roleId, roleId)),
		actor,
		"role assignment",
	);
}

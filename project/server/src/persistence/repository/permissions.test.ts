import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
	AnonymousActorError,
	accountActor,
	anonymousActor,
	resolveActor,
} from "../../domain/actor";
import { rolePermission, userRole } from "../db/schema";
import {
	connectForTests,
	NO_DATABASE_REASON,
	type TestDatabase,
} from "../db/testing";
import {
	assignRole,
	createRole,
	effectivePermissions,
	GrantNotFoundError,
	grantPublicPermission,
	grantRolePermission,
	InvalidPermissionError,
	permissionsOfUser,
	publicPermissions,
	revokePublicPermission,
	revokeRole,
	revokeRolePermission,
} from "./permissions";

/**
 * Roles and grants against a real database — PLAN.md §4.4, §5.3.
 *
 * The partial unique indexes and the temporal shape are claims only SQL can check: that a
 * revoked grant stops counting, that it can be granted again, and that the same grant cannot
 * be active twice — for public grants too, where a null role id would otherwise slip past a
 * plain unique index.
 */

const connection = await connectForTests();

describe.skipIf(connection === null)(
	`permissions (${connection === null ? NO_DATABASE_REASON : "live database"})`,
	() => {
		const active = connection as TestDatabase;
		const db = active?.db;
		let admin = accountActor("", [], []);
		let member = "";
		let roleId = "";
		// Unique per case, so cases do not collide on the partial unique indexes.
		let suffix = "";

		const newAccount = async () => {
			const [account] = await active.sql<{ id: string }[]>`
				WITH seed AS (SELECT uuidv7() AS id)
				INSERT INTO entity (id, type, created_by, updated_by)
				SELECT id, 'user', id, id FROM seed RETURNING id
			`;
			const id = account?.id ?? "";
			await active.sql`
				INSERT INTO "user" (entity_id, email, alias, created_by, updated_by)
				VALUES (${id}, ${`${id}@example.test`}, ${id}, ${id}, ${id})
			`;
			return id;
		};

		beforeEach(async () => {
			admin = accountActor(await newAccount(), [], []);
			member = await newAccount();
			suffix = crypto.randomUUID().replaceAll("-", "").replace(/\d/g, "x");
			roleId = await createRole(db, `moderator-${suffix}`, admin);
		});

		afterAll(async () => {
			await active.sql`TRUNCATE entity CASCADE`;
			await active.close();
		});

		const perm = (action: string) => `test_${suffix}:${action}`;

		test("a role's permissions reach its holder, and only while held", async () => {
			await grantRolePermission(db, roleId, perm("publish"), admin);
			expect(await permissionsOfUser(db, member)).not.toContain(
				perm("publish"),
			);

			await assignRole(db, member, roleId, admin);
			expect(await permissionsOfUser(db, member)).toContain(perm("publish"));

			await revokeRole(db, member, roleId, admin);
			expect(await permissionsOfUser(db, member)).not.toContain(
				perm("publish"),
			);
		});

		test("the effective set is the public grants plus the user's own", async () => {
			await grantPublicPermission(db, perm("preview"), admin);
			await grantRolePermission(db, roleId, perm("view"), admin);
			await assignRole(db, member, roleId, admin);

			const effective = await effectivePermissions(db, member);
			expect(effective).toContain(perm("preview"));
			expect(effective).toContain(perm("view"));

			// The same answer as building the actor from the two halves.
			const actor = await resolveActor(
				{
					publicPermissions: () => publicPermissions(db),
					permissionsOfUser: (id) => permissionsOfUser(db, id),
				},
				member,
			);
			expect([...actor.permissions].sort()).toEqual([...effective].sort());

			// And a stranger holds the public half only.
			const stranger = await effectivePermissions(db, await newAccount());
			expect(stranger).toContain(perm("preview"));
			expect(stranger).not.toContain(perm("view"));
		});

		test("revoking stamps the row rather than deleting it", async () => {
			await grantRolePermission(db, roleId, perm("view"), admin);
			await revokeRolePermission(db, roleId, perm("view"), admin);

			const rows = await db
				.select()
				.from(rolePermission)
				.where(
					and(
						eq(rolePermission.roleId, roleId),
						eq(rolePermission.permission, perm("view")),
					),
				);

			expect(rows).toHaveLength(1);
			expect(rows[0]?.revokedAt).not.toBeNull();
			expect(rows[0]?.revokedBy).toBe(admin.id as string);
		});

		// §5.3: a plain unique constraint would block exactly this.
		test("something revoked can be granted again", async () => {
			await assignRole(db, member, roleId, admin);
			await revokeRole(db, member, roleId, admin);
			await assignRole(db, member, roleId, admin);

			const rows = await db
				.select()
				.from(userRole)
				.where(and(eq(userRole.userId, member), eq(userRole.roleId, roleId)));
			expect(rows).toHaveLength(2);
			expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
		});

		test("the same grant cannot be active twice — role-bound or public", async () => {
			await grantRolePermission(db, roleId, perm("view"), admin);
			const roleDuplicate = await grantRolePermission(
				db,
				roleId,
				perm("view"),
				admin,
			).catch((caught) => caught as Error);
			expect(roleDuplicate).toBeInstanceOf(Error);

			// A unique index treats nulls as distinct, so public grants need their own.
			await grantPublicPermission(db, perm("preview"), admin);
			const publicDuplicate = await grantPublicPermission(
				db,
				perm("preview"),
				admin,
			).catch((caught) => caught as Error);
			expect(publicDuplicate).toBeInstanceOf(Error);
		});

		test("revoking a public grant ends it for everyone", async () => {
			await grantPublicPermission(db, perm("preview"), admin);
			expect(await publicPermissions(db)).toContain(perm("preview"));

			await revokePublicPermission(db, perm("preview"), admin);
			expect(await publicPermissions(db)).not.toContain(perm("preview"));
		});

		test("revoking what is not active says so", async () => {
			const error = await revokeRole(db, member, roleId, admin).catch(
				(caught) => caught as Error,
			);
			expect(error).toBeInstanceOf(GrantNotFoundError);
		});

		test("a malformed permission is refused before it is stored", async () => {
			for (const bad of [
				"",
				"view",
				"Person:view",
				"person:",
				"person:view:x",
			]) {
				const error = await grantRolePermission(db, roleId, bad, admin).catch(
					(caught) => caught as Error,
				);
				expect(error).toBeInstanceOf(InvalidPermissionError);
			}
		});

		// Every grant names who made it (§2.2a), so there is no anonymous administrator.
		test("an anonymous actor cannot grant anything", async () => {
			const error = await grantPublicPermission(
				db,
				perm("preview"),
				anonymousActor([]),
			).catch((caught) => caught as Error);
			expect(error).toBeInstanceOf(AnonymousActorError);
		});
	},
);

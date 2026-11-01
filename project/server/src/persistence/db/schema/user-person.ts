import { boolean, pgTable, uuid } from "drizzle-orm/pg-core";
import { auditColumns, entity, user } from "./entity";

/**
 * "This account *is* that Person" — PLAN.md §2.9.
 *
 * One account, at most one Person; one Person, at most one account; both sides optional,
 * since most people in the archive are long dead and plenty of contributors will not appear
 * in it. Hence a row per link with both ends unique, rather than a nullable column on either.
 *
 * **Confirmed by a moderator, never self-asserted** — claiming to be someone in the archive is
 * otherwise a route to gated data about them and to influence over their record. The row is
 * created by the confirming moderator, so `created_by` is who confirmed it.
 *
 * It grants **no** edit rights over the Person: that is an archival record about someone, not
 * a profile they own, and corrections go through propose/publish like everything else.
 */
export const userPerson = pgTable("user_person", {
	userId: uuid()
		.primaryKey()
		.references(() => user.entityId),

	personEntityId: uuid()
		.notNull()
		.unique()
		.references(() => entity.id),

	/**
	 * Whether the link is shown publicly. **Off by default**: an account shows a chosen alias
	 * (§4.4), and linking that alias to a named Person undoes the pseudonymity, so publishing
	 * the link is a separate, opt-in decision from making it.
	 */
	isPublic: boolean().notNull().default(false),

	...auditColumns(),
});

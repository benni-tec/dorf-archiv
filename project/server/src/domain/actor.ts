/**
 * Who is asking — PLAN.md §4.4, §5.1.
 *
 * **Anonymous is an actor holding the public role set, never the absence of one.** That is
 * the whole point of the type: there is always something to pass, so scoping stops being a
 * step anyone can forget, and there is no auth-free code path to accidentally take. A read
 * function that takes an `Actor` cannot be called without deciding whose view it is.
 *
 * It follows that `<entity>:preview` is a permission like any other, which merely *happens*
 * to be granted to the public role by default. What an anonymous visitor may see is an
 * operational decision recorded in the database, not a constant in the code.
 */

/**
 * `entity type : action` — `person:view`, `media:propose`, `place:moderate`.
 *
 * A small in-house vocabulary rather than a library: §4.4 sizes the whole permission module
 * at about fifty lines, and nothing here needs conditions.
 */
export type Permission = `${string}:${string}`;

export type Actor = {
	/** The account acting, or null for an anonymous visitor. */
	readonly id: string | null;
	/**
	 * The **effective** set: the union of the public roles and whatever roles the caller
	 * holds. Never just the caller's own, or a signed-in visitor would somehow see less than
	 * a stranger.
	 *
	 * A frozen array rather than a Set, because `Object.freeze` does not stop `Set.add` —
	 * it guards own properties, not internal slots, so a "frozen" Set is still widenable and
	 * the immutability would have been a comment rather than a fact. The set is small enough
	 * that a linear `includes` costs nothing.
	 */
	readonly permissions: readonly Permission[];
};

/** A visitor with no account, holding whatever the public roles grant. */
export function anonymousActor(publicPermissions: Iterable<Permission>): Actor {
	return {
		id: null,
		// Frozen because widening an actor after it has been resolved is how a check that
		// looked correct at the top of a request stops being correct further down.
		permissions: Object.freeze([...new Set(publicPermissions)]),
	};
}

/** A signed-in caller. */
export function accountActor(
	id: string,
	publicPermissions: Iterable<Permission>,
	ownPermissions: Iterable<Permission>,
): Actor {
	return {
		id,
		permissions: Object.freeze([
			...new Set([...publicPermissions, ...ownPermissions]),
		]),
	};
}

export function isAnonymous(actor: Actor): boolean {
	return actor.id === null;
}

export class AnonymousActorError extends Error {
	constructor(action: string) {
		super(`An anonymous actor cannot ${action}.`);
		this.name = "AnonymousActorError";
	}
}

/**
 * The acting account's id, for an action that must record who took it.
 *
 * Moderating is not something the public role set can do, and §2.2a's audit quartet has
 * nobody to name if it were — so this refuses rather than writing a null and letting the
 * database decide.
 *
 * @throws {AnonymousActorError}
 */
export function requireAccountId(actor: Actor, action: string): string {
	if (actor.id === null) throw new AnonymousActorError(action);
	return actor.id;
}

/**
 * Whether the actor holds a permission.
 *
 * Exact membership, with no prefixes or wildcards: a permission the set does not contain is
 * denied, which is what makes an unrecognised or misspelled one fail closed (§4.6 #9).
 */
export function can(actor: Actor, permission: Permission): boolean {
	return actor.permissions.includes(permission);
}

/**
 * Permission resolution failed, so the request has no actor at all.
 *
 * §4.6 #9: an error while resolving permissions must never be read as "no restrictions".
 * The opposite mistake — quietly resolving to the public set — is safer but still wrong for
 * a signed-in moderator, who would find their queue empty and no reason why. So resolution
 * does not guess in either direction; it fails, and the request is refused.
 */
export class PermissionResolutionError extends Error {
	constructor(cause: unknown) {
		super(
			"Could not resolve the caller's permissions; refusing rather than guessing.",
			{
				cause,
			},
		);
		this.name = "PermissionResolutionError";
	}
}

export type ActorResolution = {
	/** What every caller holds — the grants with no role. */
	publicPermissions: () => Promise<Iterable<Permission>>;
	/** What one account's active roles add. */
	permissionsOfUser: (userId: string) => Promise<Iterable<Permission>>;
};

/**
 * Builds the actor for a request: the public set, plus the account's own when there is one.
 *
 * @throws {PermissionResolutionError} on any failure to read either half.
 */
export async function resolveActor(
	resolution: ActorResolution,
	userId: string | null,
): Promise<Actor> {
	try {
		const shared = await resolution.publicPermissions();
		if (userId === null) return anonymousActor(shared);

		return accountActor(
			userId,
			shared,
			await resolution.permissionsOfUser(userId),
		);
	} catch (error) {
		throw new PermissionResolutionError(error);
	}
}

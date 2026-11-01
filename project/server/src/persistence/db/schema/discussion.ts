import { index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { auditColumns, entity } from "./entity";
import { moderationStatus } from "./enums";

/**
 * Threads and comments — PLAN.md §2.8.
 *
 * Discussion attaches to a `HistoricEntity` as **threads, not a flat comment list**, so
 * several conversations can run on one photograph — "who is second from the left" and "this
 * is the old school, not the Rathaus" — without collapsing into one undifferentiated pile.
 *
 * Both descend from `Entity` directly: identity and an audit trail, no versions. An utterance
 * is not a revision, and commenting never bumps the entity's version.
 */

export const thread = pgTable(
	"thread",
	{
		entityId: uuid()
			.primaryKey()
			.references(() => entity.id),

		/** The record this conversation is about. */
		targetEntityId: uuid()
			.notNull()
			.references(() => entity.id),

		/**
		 * **The version anchor lives here, not on each comment.** A conversation has a
		 * subject: if the entity is corrected afterwards, the whole discussion may be talking
		 * about something that no longer says what it said. The UI flags the thread rather
		 * than each reply, which is both less noisy and more accurate.
		 */
		onVersion: integer().notNull(),

		...auditColumns(),
	},
	(table) => [
		index("thread_target_idx").on(table.targetEntityId, table.onVersion),
	],
);

export const comment = pgTable(
	"comment",
	{
		entityId: uuid()
			.primaryKey()
			.references(() => entity.id),

		threadId: uuid()
			.notNull()
			.references(() => thread.entityId),

		body: text().notNull(),

		/**
		 * **Moderation is per comment, not per thread** — one bad reply should not hide a
		 * useful conversation.
		 */
		status: moderationStatus().notNull().default("pending"),

		...auditColumns(),
	},
	(table) => [
		/**
		 * **Ordering is by id, not by a timestamp.** Ids are UUIDv7 and therefore already
		 * time-ordered, so creation order *is* id order: no sort column to maintain, no
		 * tie-break when two replies land in the same millisecond, and an order that cannot
		 * drift if a timestamp is ever corrected. This index is what makes reading a thread
		 * in that order cheap.
		 */
		index("comment_thread_idx").on(table.threadId, table.entityId),
		index("comment_status_idx").on(table.status),
	],
);

import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { primaryKeyColumn } from "./columns";
import { auditColumns, entity } from "./entity";

/**
 * Machine translations, cached persistently — PLAN.md §2.4.
 *
 * Keyed by `(entity, field, target language, hash of the original text)`. **Hashing rather
 * than version-counting** means an edit to the original silently retires everything derived
 * from it, with no bookkeeping: the next read hashes different text, misses, and translates
 * afresh. A stale entry is never *wrong*, only unreachable.
 *
 * Machine output is labelled wherever it is shown and never enters the moderation queue as
 * though a human wrote it — in an archive people cite, an unreviewed MT artefact becomes a
 * "fact". `provider` is what the label names.
 *
 * Reads of this table go through the same scoping as every other derived path (§4.6 #7): a
 * cached translation of gated text is gated text.
 */
export const translationCache = pgTable(
	"translation_cache",
	{
		id: primaryKeyColumn(),

		entityId: uuid()
			.notNull()
			.references(() => entity.id),
		/** The content field translated — `name`, `abstract`, `body`, … */
		field: text().notNull(),
		/** BCP-47, like every language column. */
		targetLanguage: text().notNull(),
		/** Hash of the original text this was translated from. */
		sourceHash: text().notNull(),

		text: text().notNull(),
		provider: text().notNull(),

		...auditColumns(),
	},
	(table) => [
		uniqueIndex("translation_cache_key_unique").on(
			table.entityId,
			table.field,
			table.targetLanguage,
			table.sourceHash,
		),
		index("translation_cache_entity_idx").on(table.entityId),
	],
);

#!/usr/bin/env bash
# Registers the `german_hunspell` text search configuration built from the dictionary the
# image carries (see ../Dockerfile). Runs once, on first initialisation of the data volume.
#
# Applied to template1 as well as the initial database, so that databases created later —
# a test database, a scratch restore — inherit it instead of silently falling back.
set -euo pipefail

for database in template1 "${POSTGRES_DB:-postgres}"; do
	psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$database" <<-'SQL'
		CREATE TEXT SEARCH DICTIONARY german_hunspell (
			TEMPLATE  = ispell,
			DictFile  = de_de,
			AffFile   = de_de,
			StopWords = german
		);

		CREATE TEXT SEARCH CONFIGURATION german_hunspell (COPY = german);

		-- Hunspell first: it splits compounds and returns every part. `german_stem` stays
		-- behind it as the fallback for words the dictionary does not know, which is what
		-- keeps names and dialect spellings searchable.
		ALTER TEXT SEARCH CONFIGURATION german_hunspell
			ALTER MAPPING FOR asciiword, asciihword, hword_asciipart, word, hword, hword_part
			WITH german_hunspell, german_stem;
	SQL
done

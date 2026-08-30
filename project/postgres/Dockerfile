# Postgres for local development, carrying the Hunspell de_DE dictionary.
#
# PLAN.md §4.3: Snowball's `german` configuration stems but does not split compounds, so
# `Kirche` never matches `Dorfkirche` — most searches, on a German corpus. Layering a
# Hunspell dictionary ahead of the stemmer fixes that, but it needs write access to
# `$SHAREDIR/tsearch_data/`, which many managed hosts cannot grant.
#
# So this image exists to make *development* behave like a good production rather than
# silently better or worse. It is not a deployment requirement: the search configuration
# name is a setting (`TEXT_SEARCH_CONFIG`), and the application runs against a stock
# Postgres with reduced recall.
#
# Postgres 18 is the floor for the whole project — `uuidv7()` is built in there (PLAN.md §5.2).
FROM postgres:18-trixie

# Postgres insists on the .affix/.dict extensions and on the dictionary's encoding matching
# the database's, so the declared encoding is read out of the affix file rather than assumed,
# and transcoded when it is not already UTF-8.
RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends hunspell-de-de; \
	rm -rf /var/lib/apt/lists/*; \
	sharedir="$(pg_config --sharedir)"; \
	mkdir -p "$sharedir/tsearch_data"; \
	encoding="$(sed -n 's/^SET[[:space:]]\+//p' /usr/share/hunspell/de_DE.aff | head -n1 | tr -d '\r')"; \
	if [ "$encoding" = "UTF-8" ]; then \
		cp /usr/share/hunspell/de_DE.aff "$sharedir/tsearch_data/de_de.affix"; \
		cp /usr/share/hunspell/de_DE.dic /tmp/de_de.dict; \
	else \
		iconv -f "$encoding" -t UTF-8 /usr/share/hunspell/de_DE.aff \
			| sed 's/^SET .*/SET UTF-8/' > "$sharedir/tsearch_data/de_de.affix"; \
		iconv -f "$encoding" -t UTF-8 /usr/share/hunspell/de_DE.dic > /tmp/de_de.dict; \
	fi; \
	test -s "$sharedir/tsearch_data/de_de.affix"; \
	test -s /tmp/de_de.dict

# Materialise the COMPOUNDBEGIN flag onto the words that earn it.
#
# Without this the image is pointless, and silently so. igerman98 marks nouns as able to
# *start* a compound indirectly: the dictionary entry carries an ordinary flag (`Dorf/ETSmij`),
# and an affix rule that strips and appends nothing grants COMPOUNDBEGIN to the result
# (`SFX j 0 0/xoc .`). Hunspell itself follows that hop; PostgreSQL's ispell reader does not
# propagate compound flags from an affix rule onto the form it generates, so *no* word ends
# up flagged COMPOUNDBEGIN and nothing ever splits — `to_tsvector` quietly returns
# `dorfkirch`, exactly what stock `german` gives, and the dictionary looks installed and fine.
#
# So the hop is applied here instead: find the flags that a *pure* flag-granting rule (strip
# nothing, append nothing, no condition) maps to COMPOUNDBEGIN, then add COMPOUNDBEGIN
# directly to every entry carrying one of them. Only zero-change rules qualify — a rule like
# `SFX g 0 innen/xyoc [^n]` grants the flag to a *derived* form ("Bürgerinnen"), and copying
# it onto the base would be a different claim.
#
# ONLYINCOMPOUND is deliberately not copied along with it: that flag belongs to the derived
# compound-only form, and putting it on the base entry would stop `Dorf` being a word.
RUN set -eux; \
	sharedir="$(pg_config --sharedir)"; \
	affix="$sharedir/tsearch_data/de_de.affix"; \
	begin="$(awk '$1 == "COMPOUNDBEGIN" { print $2; exit }' "$affix")"; \
	test -n "$begin"; \
	granting="$(awk -v begin="$begin" \
		'$1 == "SFX" && $3 == "0" && $5 == "." && $4 ~ "^0/" && index($4, begin) { print $2 }' \
		"$affix" | sort -u | tr -d '\n')"; \
	test -n "$granting"; \
	awk -v granting="$granting" -v begin="$begin" -F/ '\
		NF == 2 { \
			for (i = 1; i <= length(granting); i++) \
				if (index($2, substr(granting, i, 1))) { print $1 "/" $2 begin; next } \
		} \
		{ print }' /tmp/de_de.dict > "$sharedir/tsearch_data/de_de.dict"; \
	rm -f /tmp/de_de.dict; \
	flagged="$(grep -cE "^[^/]+/[^ ]*${begin}" "$sharedir/tsearch_data/de_de.dict" || true)"; \
	echo "compound-begin entries: $flagged"; \
	test "$flagged" -gt 1000

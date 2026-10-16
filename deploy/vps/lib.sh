# Shared helpers for the scripts in deploy/vps. Postgres tools run in a container of the right version,
# so nothing has to be installed on the server. For tests, LOCAL_TARGET_URL makes them use the local tools.
PG_IMAGE_MAJOR="${PG_IMAGE_MAJOR:-16}"

# psql/pg_dump/pg_restore against the server's own database (the "db" service).
target_psql()    { if [ -n "${LOCAL_TARGET_URL:-}" ]; then psql "$LOCAL_TARGET_URL" -v ON_ERROR_STOP=1 "$@"; else docker compose exec -T db psql -U ironid -d ironid -v ON_ERROR_STOP=1 "$@"; fi; }
target_dump()    { if [ -n "${LOCAL_TARGET_URL:-}" ]; then pg_dump --format=custom --no-owner --no-privileges -d "$LOCAL_TARGET_URL"; else docker compose exec -T db pg_dump --format=custom --no-owner --no-privileges -U ironid -d ironid; fi; }
target_restore() { if [ -n "${LOCAL_TARGET_URL:-}" ]; then pg_restore --no-owner --no-privileges --exit-on-error -d "${1:-$LOCAL_TARGET_URL}"; else docker compose exec -T db pg_restore --no-owner --no-privileges --exit-on-error -U ironid -d "${1:-ironid}"; fi; }

# The same, against another database given by URL (Railway's), with a client of a given major version.
url_psql() { local url="$1"; shift; if [ -n "${LOCAL_TARGET_URL:-}" ]; then psql "$url" -v ON_ERROR_STOP=1 "$@"; else docker run --rm -i -e PGURL="$url" "postgres:${PG_CLIENT_MAJOR:-$PG_IMAGE_MAJOR}-bookworm" sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1 "$@"' sh "$@"; fi; }
url_dump() { local url="$1"; if [ -n "${LOCAL_TARGET_URL:-}" ]; then pg_dump --format=custom --no-owner --no-privileges -d "$url"; else docker run --rm -i -e PGURL="$url" "postgres:${PG_CLIENT_MAJOR:-$PG_IMAGE_MAJOR}-bookworm" sh -c 'pg_dump --format=custom --no-owner --no-privileges -d "$PGURL"'; fi; }

# Exact row counts of every table, one "schema.table count" per line, sorted (to compare two databases).
COUNT_SQL="SELECT format('SELECT %L || '' '' || count(*) FROM %I.%I', schemaname || '.' || tablename, schemaname, tablename)
           FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1"
table_counts() { # $1 = "target" or a URL
  local q
  if [ "$1" = target ]; then q=$(target_psql -tAc "$COUNT_SQL"); else q=$(url_psql "$1" -tAc "$COUNT_SQL"); fi
  [ -z "$q" ] && return 0
  if [ "$1" = target ]; then printf '%s\n' "$q" | sed 's/$/;/' | target_psql -tA; else printf '%s\n' "$q" | sed 's/$/;/' | url_psql "$1" -tA; fi | sort
}
die() { echo "STOP: $*" >&2; exit 1; }

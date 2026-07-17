# pgtemp — roadmap

A tiny Deno/JSR package that stands up an ephemeral, in-memory Postgres over the
real wire protocol (PGlite behind pg-gateway) so any Postgres driver can connect
for hermetic tests. Extracted from ../ding's `pglite` test wrapper.

## Core idea

- [x] `pgtemp()` → TCP listener on an OS-assigned free port, fresh `PGlite`,
      bridges `pg-gateway` `PostgresConnection` → PGlite protocol, returns
      `{ url, port, db, sql, close, [Symbol.asyncDispose] }`
- [x] Clean, idempotent teardown via `await using` / explicit `.close()`
- [x] Bundled postgres.js client + `url` escape hatch for other drivers

## Public API

- [x] `await using pg = await pgtemp(opts)` — one-liner happy path
- [x] opts: `{ extensions?, setup?: string | string[], onnotice? }`
- [x] `pg.url`, `pg.db` (raw PGlite), `pg.sql` (postgres.js, `max: 1`)

## Package hygiene

- [x] `deno.json` name `@surprisetalk/pgtemp`, exports, version, MIT license
- [x] Pin deps: `@electric-sql/pglite`, `pg-gateway`, `postgres` (npm
      specifiers)
- [x] `mod.ts` single-file implementation
- [x] `readme.md` — quickstart, why, concurrency caveat
- [x] JSR publish dry-run passes (no slow types); publish `exclude` set
- [ ] `deno publish` for real (needs JSR auth — user action)

## Tests — all green (9/9)

- [x] happy path: connect, `select 1`
- [x] concurrent instances get distinct ports, isolated data
- [x] `setup` runs before first query (string + array forms)
- [x] extensions load (citext smoke test)
- [x] teardown is clean (sanitizer-backed) and idempotent
- [x] adversarial: bad setup SQL rejects, no hang
- [x] adversarial: querying after `.close()` fails loudly
- [x] adversarial: overlapping queries don't corrupt — exposed pool-vs-single-
      session corruption; fixed with a serialize-gate + `max: 1`

## Nice-to-have (deferred past 70%)

- [ ] npm build via dnt for Node consumers
- [ ] per-test `snapshot`/`reset` helper (template-db semantics)
- [ ] CI workflow (deno test) + JSR provenance
- [ ] hstore + more contrib extensions in the smoke test

## Next steps

- Run `deno publish` (authenticate to JSR under @surprisetalk) to ship 0.1.0.
- `git init`? (repo already git) — commit the package before publishing.
- Decide if Node/npm consumers matter → add dnt build.

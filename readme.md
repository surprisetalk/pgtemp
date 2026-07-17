# pgtemp

Ephemeral, in-memory Postgres for hermetic tests. Stands up a real TCP endpoint
speaking the Postgres wire protocol — [PGlite] behind [pg-gateway] — so a real
driver connects over the wire. No Docker, no daemon, no shared state between
tests.

Extracted from the test harness in [ding](../ding).

## Usage

```ts
import { pgtemp } from "@surprisetalk/pgtemp";

Deno.test("my query", async () => {
  await using pg = await pgtemp({
    setup: `create table todo (id serial primary key, body text)`,
  });

  await pg.sql`insert into todo (body) values ('ship it')`;
  const [row] = await pg.sql`select body from todo`;
  console.log(row.body); // "ship it"
}); // `await using` disposes: driver, backend, and listener all close.
```

`pgtemp(opts)` returns:

- `sql` — a bundled [postgres.js] client, wired to the instance (`max: 1`).
- `url` — the connection string, if you'd rather bring your own driver.
- `db` — the raw `PGlite` handle (`.exec`, `.query`).
- `port` — the OS-assigned free port.
- `close()` / `[Symbol.asyncDispose]` — idempotent teardown.

### Options

```ts
await pgtemp({
  extensions: { citext, hstore }, // PGlite contrib extensions
  setup: [`create extension citext`, `create table u (name citext)`], // string | string[]
  onnotice: (n) => {}, // defaults to swallowing notices
});
```

## Concurrency

PGlite is a **single session**. Multiplexing a connection pool onto it corrupts
the protocol stream, so the bundled `sql` uses `max: 1`; postgres.js still
pipelines overlapping queries over that one connection, in order. If you connect
your own driver via `url`, use a **single connection** (e.g. `max: 1`).

## Requirements

Deno (uses `Deno.listen`). Node support via dnt is a possible future addition.

[PGlite]: https://pglite.dev
[pg-gateway]: https://github.com/supabase-community/pg-gateway
[postgres.js]: https://github.com/porsager/postgres

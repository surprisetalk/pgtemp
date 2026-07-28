# pgtemp

Ephemeral in-memory Postgres for hermetic tests.

Run `deno test --parallel` and each `Deno.test` receives an isolated DB.

Implemented using [PGlite](https://pglite.dev) and [pg-gateway](https://github.com/supabase-community/pg-gateway).

## Install

```sh
deno add jsr:@surprisetalk/pgtemp   # Deno
npx jsr add @surprisetalk/pgtemp    # Node
bunx jsr add @surprisetalk/pgtemp   # Bun
```

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

- `sql` — a bundled [postgres.js](https://github.com/porsager/postgres) client, wired to the instance (`max: 1`,
  `prepare: false`).
- `url` — the connection string, if you'd rather bring your own driver.
- `db` — the raw `PGlite` handle (`.exec`, `.query`).
- `port` — the OS-assigned free port.
- `snapshot()` / `reset()` — see below.
- `close()` / `[Symbol.asyncDispose]` — idempotent teardown.

### Options

```ts
await pgtemp({
  extensions: { citext, hstore }, // PGlite contrib extensions
  setup: [`create extension citext`, `create table u (name citext)`], // string | string[]
  snapshot, // a Blob from `pg.snapshot()` — boot from it instead of cold
  onnotice: (n) => {}, // defaults to swallowing notices
});
```

## Snapshots

```ts
const snapshot = await (async () => {
  await using pg = await pgtemp({ setup: MIGRATIONS });
  return await pg.snapshot();
})();

Deno.test("cheap isolated case", async () => {
  await using pg = await pgtemp({ snapshot }); // migrations already applied
  // ...
});
```

`setup` still runs after `snapshot`, so a shared base composes with per-test extras.

Within one instance, `reset` swaps the backend without touching the listener, so `url` and `port` stay valid:

```ts
const snap = await pg.snapshot();
await pg.reset(snap); // restore that snapshot exactly — data and DDL
await pg.reset(); // rebuild what pgtemp() first returned: opts.snapshot + opts.setup
```

Two caveats, from the backend swap:

- Read `pg.sql` and `pg.db` off the object each time. They are getters; a destructured `const { sql } = pg` still points
  at the closed pre-reset client.
- Session state does not survive a reset, so don't reset mid-transaction.

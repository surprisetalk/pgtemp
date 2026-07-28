# pgtemp

Ephemeral in-memory Postgres for hermetic tests.

Run `deno test --parallel` and each `Deno.test` receives an isolated DB.

Implemented using [PGlite](https://pglite.dev) and [pg-gateway](https://github.com/supabase-community/pg-gateway).

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

- `sql` — a bundled [postgres.js](https://github.com/porsager/postgres) client, wired to the instance (`max: 1`).
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

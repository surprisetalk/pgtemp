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
- `url` — the connection string, if you'd rather bring your own driver. Pools are fine; see [Connections](#connections).
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

Each boot without a snapshot runs initdb, which makes it slower. A second one in the same process prints a warning with
the recipe below.

To keep a snapshot across runs, cache it on disk. The file name hashes `MIGRATIONS` and `deno.lock`, so a new migration
or a pgtemp upgrade builds a new snapshot. `/tmp` clears old snapshots on its own. A stale snapshot from an older
Postgres major fails with `PGlite could not boot this snapshot`.

```ts
const key = new TextEncoder().encode(MIGRATIONS + await Deno.readTextFile("deno.lock"));
const path = `/tmp/pgtemp/${new Uint8Array(await crypto.subtle.digest("SHA-256", key)).toHex()}.tar`;
const snapshot = await Deno.readFile(path).then((b) => new Blob([b]), async (e) => {
  if (!(e instanceof Deno.errors.NotFound)) throw e;
  await using pg = await pgtemp({ setup: MIGRATIONS });
  const snap = await pg.snapshot();
  await Deno.mkdir("/tmp/pgtemp", { recursive: true });
  const tmp = `${path}.${crypto.randomUUID()}`; // rename: parallel files never read half a file
  await Deno.writeFile(tmp, snap.stream());
  await Deno.rename(tmp, path);
  return snap;
});
```

Run tests with `--allow-write=/tmp/pgtemp`.

Within one instance, `reset` swaps the backend without touching the listener, so `url` and `port` stay valid:

```ts
const snap = await pg.snapshot();
await pg.reset(snap); // restore that snapshot exactly — data and DDL
await pg.reset(); // rebuild what pgtemp() first returned: opts.snapshot + opts.setup
```

## Connections

Point a connection pool at `url` and it works — connections take the backend one transaction at a time, so nothing
interleaves. It is still a single Postgres session underneath, which means:

- Session state is shared. A `set`, a temp table, or a `listen` on one connection is visible on all of them.
- One transaction runs at a time. A connection that opens a transaction and sits on it blocks every other connection
  until it commits, rolls back, or disconnects — you cannot deadlock two transactions against each other, because the
  second one never starts.
- No named prepared statements, on any connection: use `prepare: false`.

Two caveats, from the backend swap:

- Read `pg.sql` and `pg.db` off the object each time. They are getters; a destructured `const { sql } = pg` still points
  at the closed pre-reset client.
- Session state does not survive a reset, so don't reset mid-transaction.

## Status

`deno task status` checks that JSR serves the version in `deno.json`, that CI passed on main, and that both kinds of
boot stay fast. snitch runs it every hour.

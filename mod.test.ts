import { assertEquals, assertNotEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { Extension, Extensions } from "@electric-sql/pglite";
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";
import { bloom } from "@electric-sql/pglite/contrib/bloom";
import { btree_gin } from "@electric-sql/pglite/contrib/btree_gin";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { cube } from "@electric-sql/pglite/contrib/cube";
import { dict_int } from "@electric-sql/pglite/contrib/dict_int";
import { dict_xsyn } from "@electric-sql/pglite/contrib/dict_xsyn";
import { earthdistance } from "@electric-sql/pglite/contrib/earthdistance";
import { file_fdw } from "@electric-sql/pglite/contrib/file_fdw";
import { fuzzystrmatch } from "@electric-sql/pglite/contrib/fuzzystrmatch";
import { hstore } from "@electric-sql/pglite/contrib/hstore";
import { intarray } from "@electric-sql/pglite/contrib/intarray";
import { isn } from "@electric-sql/pglite/contrib/isn";
import { lo } from "@electric-sql/pglite/contrib/lo";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { pageinspect } from "@electric-sql/pglite/contrib/pageinspect";
import { pg_buffercache } from "@electric-sql/pglite/contrib/pg_buffercache";
import { pg_freespacemap } from "@electric-sql/pglite/contrib/pg_freespacemap";
import { pg_surgery } from "@electric-sql/pglite/contrib/pg_surgery";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pg_visibility } from "@electric-sql/pglite/contrib/pg_visibility";
import { pg_walinspect } from "@electric-sql/pglite/contrib/pg_walinspect";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { seg } from "@electric-sql/pglite/contrib/seg";
import { tablefunc } from "@electric-sql/pglite/contrib/tablefunc";
import { tcn } from "@electric-sql/pglite/contrib/tcn";
import { tsm_system_rows } from "@electric-sql/pglite/contrib/tsm_system_rows";
import { tsm_system_time } from "@electric-sql/pglite/contrib/tsm_system_time";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { uuid_ossp } from "@electric-sql/pglite/contrib/uuid_ossp";
import { pgtemp } from "./mod.ts";

Deno.test("happy path: connect and select 1", async () => {
  await using pg = await pgtemp();
  const [row] = await pg.sql`select 1 as n`;
  assertEquals(row.n, 1);
});

Deno.test("setup SQL runs before first query", async () => {
  await using pg = await pgtemp({
    setup: `create table t (id int); insert into t values (42);`,
  });
  const [row] = await pg.sql`select id from t`;
  assertEquals(row.id, 42);
});

Deno.test("setup accepts an array of statements", async () => {
  await using pg = await pgtemp({
    setup: [`create table a (x int)`, `insert into a values (1), (2)`],
  });
  const [row] = await pg.sql`select count(*)::int as c from a`;
  assertEquals(row.c, 2);
});

Deno.test("concurrent instances: distinct ports, isolated data", async () => {
  await using a = await pgtemp({
    setup: `create table m (v text); insert into m values ('a')`,
  });
  await using b = await pgtemp({
    setup: `create table m (v text); insert into m values ('b')`,
  });
  assertNotEquals(a.port, b.port);
  const [ra] = await a.sql`select v from m`;
  const [rb] = await b.sql`select v from m`;
  assertEquals([ra.v, rb.v], ["a", "b"]);
});

Deno.test("extensions load (citext)", async () => {
  await using pg = await pgtemp({
    extensions: { citext },
    setup: `create extension if not exists citext; create table u (name citext); insert into u values ('Foo')`,
  });
  const [row] = await pg
    .sql`select count(*)::int as c from u where name = 'foo'`;
  assertEquals(row.c, 1);
});

// Deno's default resource/op sanitizer fails the test if close() leaks the
// listener, backend, or driver connections — so a passing test IS the leak-free
// guarantee. (Immediate port re-bind is unreliable: a client socket lingers in
// TIME_WAIT, which is OS behavior, not a leak.) close() must also be idempotent.
Deno.test("teardown is clean and idempotent", async () => {
  const pg = await pgtemp();
  await pg.close();
  await pg.close();
});

Deno.test(
  "adversarial: bad setup SQL surfaces an error, not a hang",
  async () => {
    await assertRejects(() => pgtemp({ setup: `this is not valid sql` }));
  },
);

Deno.test("adversarial: querying after close fails loudly", async () => {
  const pg = await pgtemp();
  await pg.close();
  await assertRejects(() => pg.sql`select 1`);
});

Deno.test(
  "adversarial: overlapping queries don't corrupt (single-connection PGlite)",
  async () => {
    await using pg = await pgtemp({ setup: `create table nums (n int)` });
    await Promise.all(
      Array.from(
        { length: 25 },
        (_, i) => pg.sql`insert into nums values (${i})`,
      ),
    );
    const [row] = await pg
      .sql`select count(*)::int as c, sum(n)::int as s from nums`;
    assertEquals([row.c, row.s], [25, 300]);
  },
);

Deno.test("snapshot round-trips data and DDL", async () => {
  await using pg = await pgtemp({ setup: `create table t (n int)` });
  await pg.sql`insert into t values (1)`;
  const snap = await pg.snapshot();

  await pg.sql`insert into t values (2)`;
  await pg.sql`create table extra (x int)`;
  await pg.reset(snap);

  const [row] = await pg.sql`select count(*)::int as c, sum(n)::int as s from t`;
  assertEquals([row.c, row.s], [1, 1]);
  await assertRejects(() => pg.sql`select x from extra`); // DDL rolled back too
});

Deno.test("reset() with no snapshot rebuilds setup", async () => {
  await using pg = await pgtemp({
    setup: [`create table t (n int)`, `insert into t values (7)`],
  });
  await pg.sql`drop table t`;
  await pg.reset();
  const [row] = await pg.sql`select n from t`;
  assertEquals(row.n, 7);
});

Deno.test("reset keeps the listener: url and port survive", async () => {
  await using pg = await pgtemp();
  const { url, port } = pg;
  await pg.reset();
  assertEquals([pg.url, pg.port], [url, port]);
  const [row] = await pg.sql`select 1 as n`;
  assertEquals(row.n, 1);
});

Deno.test("pgtemp({ snapshot }) boots restored, and stays isolated", async () => {
  await using seed = await pgtemp({
    setup: `create table t (v text); insert into t values ('seeded')`,
  });
  const snapshot = await seed.snapshot();

  await using a = await pgtemp({ snapshot });
  await using b = await pgtemp({ snapshot });
  await a.sql`update t set v = 'a'`;
  const [ra] = await a.sql`select v from t`;
  const [rb] = await b.sql`select v from t`;
  assertEquals([ra.v, rb.v], ["a", "seeded"]);
});

Deno.test("snapshot composes with setup: shared base, per-instance extras", async () => {
  await using seed = await pgtemp({ setup: `create table base (n int)` });
  const snapshot = await seed.snapshot();

  await using pg = await pgtemp({
    snapshot,
    setup: `create table extra (n int); insert into base values (1)`,
  });
  const [row] = await pg
    .sql`select (select count(*)::int from base) as b, (select count(*)::int from extra) as e`;
  assertEquals([row.b, row.e], [1, 0]);
});

Deno.test("snapshot round-trips an extension", async () => {
  await using seed = await pgtemp({
    extensions: { citext },
    setup: `create extension citext; create table u (name citext); insert into u values ('Foo')`,
  });
  const snapshot = await seed.snapshot();

  await using pg = await pgtemp({ extensions: { citext }, snapshot });
  const [row] = await pg
    .sql`select count(*)::int as c from u where name = 'foo'`;
  assertEquals(row.c, 1);
});

Deno.test("adversarial: snapshot() and reset() after close fail loudly", async () => {
  const pg = await pgtemp();
  await pg.close();
  await assertRejects(() => pg.snapshot(), Error, "after close()");
  await assertRejects(() => pg.reset(), Error, "after close()");
});

// PGlite hands an unrecognized data dir to Emscripten, which silently boots an
// *empty* database — the worst possible outcome for a test fixture. pgtemp must
// reject the blob before it gets there.
Deno.test("adversarial: a garbage snapshot is rejected, not booted empty", async () => {
  const e = await assertRejects(() => pgtemp({ snapshot: new Blob([new Uint8Array([1, 2, 3, 4])]) }));
  assertStringIncludes((e as Error).message, "not a snapshot");
});

// A gzip header is trivially forgeable and PGlite boots the result as an empty
// database, so the gzip must be decompressed far enough to see the tar header.
Deno.test("adversarial: a valid gzip of non-tar bytes is rejected", async () => {
  const gz = new Blob([
    await new Response(
      new Blob(["not a tar at all"]).stream().pipeThrough(
        new CompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  ]);
  const e = await assertRejects(() => pgtemp({ snapshot: gz }));
  assertStringIncludes((e as Error).message, "not a snapshot");
});

Deno.test("a gzip-compressed snapshot is still accepted", async () => {
  await using seed = await pgtemp({
    setup: `create table t (v text); insert into t values ('gz')`,
  });
  const snapshot = new Blob([
    await new Response(
      (await seed.snapshot()).stream().pipeThrough(
        new CompressionStream("gzip"),
      ),
    ).arrayBuffer(),
  ]);

  await using pg = await pgtemp({ snapshot });
  const [row] = await pg.sql`select v from t`;
  assertEquals(row.v, "gz");
});

Deno.test("adversarial: a rejected reset leaves the instance usable", async () => {
  await using pg = await pgtemp({
    setup: `create table t (n int); insert into t values (5)`,
  });
  await assertRejects(() => pg.reset(new Blob(["nonsense"])));
  const [row] = await pg.sql`select n from t`;
  assertEquals(row.n, 5);
});

Deno.test("adversarial: bad setup SQL names the offending statement", async () => {
  const e = await assertRejects(() =>
    pgtemp({
      setup: [`create table ok (n int)`, `this is not valid sql`],
    })
  );
  assertStringIncludes((e as Error).message, "this is not valid sql");
});

// Every contrib extension PGlite ships, in one boot, each probed for a real
// value rather than just a successful `create extension`. Order matters:
// earthdistance depends on cube. auto_explain is absent from this table because
// it is a shared_preload_library module with no SQL extension at all — PGlite
// reports `extension "auto_explain" is not available`.
const contribs: [string, Extension, string, string, unknown][] = [
  [
    "amcheck",
    amcheck,
    "amcheck",
    // bt_index_check returns void and raises if the index is corrupt, so an
    // empty string here means the check genuinely ran and passed.
    `select bt_index_check('tree_id_idx')::text as v`,
    "",
  ],
  [
    "bloom",
    bloom,
    "bloom",
    `select count(*)::int as v from pg_am where amname = 'bloom'`,
    1,
  ],
  [
    "btree_gin",
    btree_gin,
    "btree_gin",
    `select count(*)::int as v from pg_opclass where opcname = 'int4_ops'
       and opcmethod = (select oid from pg_am where amname = 'gin')`,
    1,
  ],
  [
    "btree_gist",
    btree_gist,
    "btree_gist",
    `select count(*)::int as v from pg_opclass where opcname = 'gist_int4_ops'`,
    1,
  ],
  ["citext", citext, "citext", `select ('Foo'::citext = 'foo') as v`, true],
  ["cube", cube, "cube", `select (cube(array[1, 2]) -> 1)::int as v`, 1],
  [
    "dict_int",
    dict_int,
    "dict_int",
    `select count(*)::int as v from pg_ts_dict where dictname = 'intdict'`,
    1,
  ],
  [
    "dict_xsyn",
    dict_xsyn,
    "dict_xsyn",
    `select count(*)::int as v from pg_ts_dict where dictname = 'xsyn'`,
    1,
  ],
  [
    "earthdistance",
    earthdistance,
    "earthdistance",
    `select (earth() > 6000000) as v`,
    true,
  ],
  [
    "file_fdw",
    file_fdw,
    "file_fdw",
    `select count(*)::int as v from pg_foreign_data_wrapper where fdwname = 'file_fdw'`,
    1,
  ],
  [
    "fuzzystrmatch",
    fuzzystrmatch,
    "fuzzystrmatch",
    `select levenshtein('kitten', 'sitting') as v`,
    3,
  ],
  ["hstore", hstore, "hstore", `select ('a=>1'::hstore -> 'a') as v`, "1"],
  [
    "intarray",
    intarray,
    "intarray",
    `select (array[1, 2, 3] & array[2, 3, 4])::text as v`,
    "{2,3}",
  ],
  [
    "isn",
    isn,
    "isn",
    `select '978-0-393-04002-9'::isbn13::text as v`,
    "978-0-393-04002-9",
  ],
  [
    "lo",
    lo,
    "lo",
    `select count(*)::int as v from pg_type where typname = 'lo'`,
    1,
  ],
  ["ltree", ltree, "ltree", `select ('a.b.c'::ltree <@ 'a'::ltree) as v`, true],
  [
    "pageinspect",
    pageinspect,
    "pageinspect",
    `select count(*)::int as v from pg_proc where proname = 'page_header'`,
    1,
  ],
  [
    "pg_buffercache",
    pg_buffercache,
    "pg_buffercache",
    `select (count(*) > 0) as v from pg_buffercache`,
    true,
  ],
  [
    "pg_freespacemap",
    pg_freespacemap,
    "pg_freespacemap",
    `select count(*)::int as v from pg_proc where proname = 'pg_freespace'`,
    2,
  ],
  [
    "pg_surgery",
    pg_surgery,
    "pg_surgery",
    `select count(*)::int as v from pg_proc where proname = 'heap_force_kill'`,
    1,
  ],
  [
    "pg_trgm",
    pg_trgm,
    "pg_trgm",
    `select (similarity('word', 'word') = 1) as v`,
    true,
  ],
  [
    "pg_visibility",
    pg_visibility,
    "pg_visibility",
    `select count(*)::int as v from pg_proc where proname = 'pg_visibility_map'`,
    2,
  ],
  [
    "pg_walinspect",
    pg_walinspect,
    "pg_walinspect",
    `select count(*)::int as v from pg_proc where proname = 'pg_get_wal_record_info'`,
    1,
  ],
  [
    "pgcrypto",
    pgcrypto,
    "pgcrypto",
    `select length(digest('x', 'sha256')) as v`,
    32,
  ],
  ["seg", seg, "seg", `select ('1 .. 2'::seg @> '1.5 .. 1.6'::seg) as v`, true],
  [
    "tablefunc",
    tablefunc,
    "tablefunc",
    `select count(*)::int as v
       from connectby('tree', 'id', 'pid', '1', 0) as c(id text, pid text, lvl int)`,
    1,
  ],
  [
    "tcn",
    tcn,
    "tcn",
    `select count(*)::int as v from pg_proc where proname = 'triggered_change_notification'`,
    1,
  ],
  [
    "tsm_system_rows",
    tsm_system_rows,
    "tsm_system_rows",
    `select count(*)::int as v from tree tablesample system_rows(1)`,
    1,
  ],
  [
    "tsm_system_time",
    tsm_system_time,
    "tsm_system_time",
    `select (count(*) >= 0) as v from tree tablesample system_time(100)`,
    true,
  ],
  ["unaccent", unaccent, "unaccent", `select unaccent('héllo') as v`, "hello"],
  [
    "uuid_ossp",
    uuid_ossp,
    `"uuid-ossp"`,
    `select (uuid_generate_v4() is not null) as v`,
    true,
  ],
];

Deno.test("contrib extensions load together and actually work", async () => {
  await using pg = await pgtemp({
    extensions: Object.fromEntries(
      contribs.map(([name, ext]) => [name, ext]),
    ) as Extensions,
    setup: [
      `create table tree (id text, pid text)`,
      `insert into tree values ('1', null)`,
      `create index tree_id_idx on tree (id)`,
      ...contribs.map(([, , create]) => `create extension ${create}`),
    ],
  });

  for (const [name, , , probe, expected] of contribs) {
    const [row] = await pg.sql.unsafe(probe);
    assertEquals(row.v, expected, name);
  }
});

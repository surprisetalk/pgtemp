import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { citext } from "@electric-sql/pglite/contrib/citext";
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
  const [row] =
    await pg.sql`select count(*)::int as c from u where name = 'foo'`;
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
    const [row] =
      await pg.sql`select count(*)::int as c, sum(n)::int as s from nums`;
    assertEquals([row.c, row.s], [25, 300]);
  },
);

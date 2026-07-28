// Runtime-compat canary, not a second test suite: mod.test.ts is the real
// coverage and runs on Deno. This only proves the node:net transport, the
// snapshot round-trip, and disposal still work off Deno, so the "runs on Node
// and Bun" claim can't rot unnoticed. Run: node smoke.ts / bun smoke.ts
import assert from "node:assert/strict";
import { pgtemp } from "./mod.ts";

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${(e as Error).message.split("\n")[0]}`);
    process.exitCode = 1;
  }
};

await run("connects and queries over node:net", async () => {
  const pg = await pgtemp({
    setup: `create table t (id int); insert into t values (42)`,
  });
  assert.ok(pg.port > 0);
  const [row] = await pg.sql`select id from t`;
  assert.equal(row.id, 42);
  await pg.close();
});

await run("concurrent instances get distinct ports", async () => {
  const a = await pgtemp();
  const b = await pgtemp();
  assert.notEqual(a.port, b.port);
  await a.close();
  await b.close();
});

await run("overlapping queries stay ordered", async () => {
  const pg = await pgtemp({ setup: `create table nums (n int)` });
  await Promise.all(
    Array.from({ length: 25 }, (_, i) => pg.sql`insert into nums values (${i})`),
  );
  const [row] = await pg
    .sql`select count(*)::int as c, sum(n)::int as s from nums`;
  assert.deepEqual([row.c, row.s], [25, 300]);
  await pg.close();
});

await run("snapshot round-trips and reset keeps the port", async () => {
  const pg = await pgtemp({ setup: `create table t (n int)` });
  await pg.sql`insert into t values (1)`;
  const snap = await pg.snapshot();
  await pg.sql`insert into t values (2)`;
  const port = pg.port;
  await pg.reset(snap);
  assert.equal(pg.port, port);
  const [row] = await pg.sql`select count(*)::int as c from t`;
  assert.equal(row.c, 1);
  await pg.close();
});

await run("a garbage snapshot is rejected", async () => {
  await assert.rejects(
    () => pgtemp({ snapshot: new Blob([new Uint8Array([1, 2, 3, 4])]) }),
    /not a snapshot/,
  );
});

await run("await using disposes", async () => {
  await using pg = await pgtemp();
  const [row] = await pg.sql`select 1 as n`;
  assert.equal(row.n, 1);
});

console.log(process.exitCode ? "\nsmoke: FAILURES" : "\nsmoke: ok");

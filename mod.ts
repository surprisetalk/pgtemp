import { PGlite } from "@electric-sql/pglite";
import type { Extensions } from "@electric-sql/pglite";
import { PostgresConnection } from "pg-gateway";
import postgres from "postgres";

export type PgtempOpts = {
  extensions?: Extensions;
  setup?: string | string[];
  onnotice?: (notice: unknown) => void;
};

export type Pgtemp = {
  url: string;
  port: number;
  db: PGlite;
  sql: ReturnType<typeof postgres>;
  close: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

export const pgtemp = async (opts: PgtempOpts = {}): Promise<Pgtemp> => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 }); // OS-assigned free port
  const port = (listener.addr as Deno.NetAddr).port;
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  const db = new PGlite({ extensions: opts.extensions });

  // PGlite is a single backend; multiplexed wire connections (e.g. a driver's
  // pool) must not interleave raw protocol bytes. Serialize every exec.
  let gate = Promise.resolve();
  const exec = (data: Uint8Array) => {
    const run = gate.then(() => db.execProtocolRaw(data));
    gate = run.then(() => {}, () => {});
    return run;
  };

  (async () => {
    try {
      for await (const conn of listener) {
        new PostgresConnection(conn, {
          async onStartup() {
            await db.waitReady;
          },
          async onMessage(
            data: Uint8Array,
            { isAuthenticated }: { isAuthenticated: boolean },
          ) {
            if (!isAuthenticated) return;
            if (data[0] === 88) return; // Terminate
            return await exec(data);
          },
        });
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.BadResource)) throw e; // listener.close() during accept
    }
  })();

  await db.waitReady;
  for (const stmt of [opts.setup ?? []].flat()) await db.exec(stmt);

  // max: 1 — PGlite is a single session; one wire connection keeps the
  // statement/portal/transaction namespace coherent. postgres.js still
  // pipelines overlapping queries over that one connection, in order.
  const sql = postgres(url, {
    max: 1,
    fetch_types: true,
    onnotice: opts.onnotice ?? (() => {}),
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await sql.end();
    listener.close();
    await db.close();
  };

  return { url, port, db, sql, close, [Symbol.asyncDispose]: close };
};

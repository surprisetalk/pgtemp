import { PGlite } from "@electric-sql/pglite";
import type { Extensions } from "@electric-sql/pglite";
import { PostgresConnection } from "pg-gateway";
import postgres from "postgres";

export type PgtempOpts = {
  extensions?: Extensions;
  setup?: string | string[];
  snapshot?: Blob;
  onnotice?: (notice: unknown) => void;
};

export type Pgtemp = {
  url: string;
  port: number;
  db: PGlite;
  sql: ReturnType<typeof postgres>;
  snapshot: () => Promise<Blob>;
  reset: (snap?: Blob) => Promise<void>;
  close: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
};

const TAR_MAGIC = 262; // "ustar" sits at offset 257 of a POSIX tar header

const head = async (stream: ReadableStream<Uint8Array>) => {
  const out = new Uint8Array(TAR_MAGIC);
  let len = 0;
  const reader = stream.getReader();
  try {
    while (len < TAR_MAGIC) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, TAR_MAGIC - len);
      out.set(value.subarray(0, take), len);
      len += take;
    }
  } finally {
    await reader.cancel();
  }
  return out.subarray(0, len);
};

// PGlite hands a bad data dir straight to Emscripten: garbage silently boots an
// *empty* database, and a truncated tar aborts the process with exit(1) — no
// exception to catch. So the shape is checked here, before PGlite ever sees it.
// Checking the gzip magic alone is not enough: a valid gzip of non-tar bytes
// still boots empty, so gzip is decompressed far enough to see the tar header.
const assertSnapshot = async (snap: Blob) => {
  const first = new Uint8Array(await snap.slice(0, 8).arrayBuffer());
  const gzip = first[0] === 0x1f && first[1] === 0x8b;
  const bytes = gzip
    // corrupt gzip reads as "not a snapshot"
    ? await head(snap.stream().pipeThrough(new DecompressionStream("gzip")))
      .catch(() => new Uint8Array())
    : new Uint8Array(await snap.slice(0, TAR_MAGIC).arrayBuffer());
  // A raw tar is whole 512-byte blocks; that catches truncation, which would
  // otherwise abort the process inside Emscripten.
  if (
    new TextDecoder().decode(bytes.slice(257, TAR_MAGIC)) === "ustar" &&
    (gzip || snap.size % 512 === 0)
  ) { return; }
  const hex = [...first]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  throw new Error(
    `pgtemp: this is not a snapshot.

  Expected a POSIX tar or gzip blob, which is what pg.snapshot() returns.
  Got ${snap.size} bytes starting with: ${hex || "(empty)"}

  Snapshots round-trip like this:

    const snap = await pg.snapshot();
    await pg.reset(snap);
`,
  );
};

export const pgtemp = async (opts: PgtempOpts = {}): Promise<Pgtemp> => {
  if (opts.snapshot) await assertSnapshot(opts.snapshot);
  const setup = [opts.setup ?? []].flat();

  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 }); // OS-assigned free port
  const port = (listener.addr as Deno.NetAddr).port;
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;

  // reset() swaps the backend; the listener and port survive it, so `url` stays
  // valid and `db`/`sql` are read through getters rather than captured.
  let db: PGlite;
  let sql: ReturnType<typeof postgres>;
  // PGlite is a single backend; multiplexed wire connections (e.g. a driver's
  // pool) must not interleave raw protocol bytes. Serialize every exec.
  let gate = Promise.resolve();

  const boot = async (snap: Blob | undefined, stmts: string[]) => {
    const next = new PGlite({
      extensions: opts.extensions,
      loadDataDir: snap,
    });
    try {
      await next.waitReady;
      for (const stmt of stmts) {
        try {
          await next.exec(stmt);
        } catch (e) {
          throw new Error(
            `pgtemp: setup failed on this statement:

    ${stmt}

  ${e instanceof Error ? e.message : String(e)}
`,
          );
        }
      }
    } catch (e) {
      // A cleanup failure here must not replace the error that caused it —
      // PGlite throws "PGlite is closed" if it never came up, which would bury
      // the actual setup error.
      await next.close().catch(() => {});
      throw e;
    }
    db = next;
    gate = Promise.resolve();
    sql = postgres(url, {
      // max: 1 — PGlite is a single session; one wire connection keeps the
      // statement/portal/transaction namespace coherent. postgres.js still
      // pipelines overlapping queries over that one connection, in order.
      max: 1,
      fetch_types: true,
      onnotice: opts.onnotice ?? (() => {}),
    });
  };

  try {
    await boot(opts.snapshot, setup);
  } catch (e) {
    listener.close();
    throw e;
  }

  const exec = (data: Uint8Array) => {
    const run = gate.then(() => db.execProtocolRaw(data));
    gate = run.then(
      () => {},
      () => {},
    );
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

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await sql.end();
    listener.close();
    await db.close();
  };

  return {
    url,
    port,
    get db() {
      return db;
    },
    get sql() {
      return sql;
    },
    snapshot: async () => {
      if (closed) throw new Error("pgtemp: snapshot() after close().");
      return await db.dumpDataDir("none"); // uncompressed: gzip costs ~500ms, and this never leaves memory
    },
    // reset(snap) restores that snapshot exactly. reset() rebuilds what pgtemp()
    // originally returned: a fresh backend seeded with opts.snapshot and opts.setup.
    reset: async (snap?: Blob) => {
      if (closed) throw new Error("pgtemp: reset() after close().");
      if (snap) await assertSnapshot(snap); // validate before tearing anything down
      await sql.end();
      await db.close();
      try {
        await boot(snap ?? opts.snapshot, snap ? [] : setup);
      } catch (e) {
        // The old backend is already gone. Retire the instance so disposal
        // doesn't double-close it and bury this error under "PGlite is closed".
        closed = true;
        listener.close();
        throw e;
      }
    },
    close,
    [Symbol.asyncDispose]: close,
  };
};

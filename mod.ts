import { PGlite } from "@electric-sql/pglite";
import type { Extensions } from "@electric-sql/pglite";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { fromNodeSocket } from "pg-gateway/node";
import postgres from "postgres";

/** The postgres.js client type returned as {@linkcode Pgtemp.sql}. */
export type Sql = ReturnType<typeof postgres>;

/** Options for {@linkcode pgtemp}. */
export type PgtempOpts = {
  /**
   * PGlite contrib extensions to compile in, keyed by name. Loading an
   * extension does not install it — run `create extension` in {@linkcode
   * PgtempOpts.setup} as well.
   */
  extensions?: Extensions;
  /** SQL run once, before the instance is returned. */
  setup?: string | string[];
  /**
   * A snapshot from {@linkcode Pgtemp.snapshot} to boot from, instead of a cold
   * start. Roughly 3x faster, and independent of how much schema it holds.
   * {@linkcode PgtempOpts.setup} still runs afterwards, so a shared base
   * composes with per-instance extras.
   */
  snapshot?: Blob;
  /** Called for every Postgres notice. Defaults to swallowing them. */
  onnotice?: (notice: unknown) => void;
};

/** A running Postgres instance. Dispose it with `await using`, or {@linkcode Pgtemp.close}. */
export type Pgtemp = {
  /** Connection string, for drivers other than the bundled {@linkcode Pgtemp.sql}. */
  url: string;
  /** The OS-assigned free port this instance listens on. */
  port: number;
  /**
   * The raw PGlite backend. Read it off the object each time: it is a getter,
   * and {@linkcode Pgtemp.reset} replaces the instance behind it.
   */
  db: PGlite;
  /**
   * A postgres.js client wired to this instance (`max: 1`). Read it off the
   * object each time — like {@linkcode Pgtemp.db}, a reset replaces it.
   */
  sql: Sql;
  /** Dump the data dir as an uncompressed tarball, for {@linkcode Pgtemp.reset} or {@linkcode PgtempOpts.snapshot}. */
  snapshot: () => Promise<Blob>;
  /**
   * Restore `snap` exactly — data and DDL. With no argument, rebuild what
   * {@linkcode pgtemp} first returned. The listener survives either way, so
   * {@linkcode Pgtemp.url} and {@linkcode Pgtemp.port} stay valid, but
   * connections you opened yourself are dropped.
   */
  reset: (snap?: Blob) => Promise<void>;
  /** Close the driver, listener, and backend. Idempotent. */
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

/**
 * Start an ephemeral in-memory Postgres and return once it is accepting queries.
 *
 * Each call gets its own backend on its own OS-assigned port, so
 * `deno test --parallel` gives every test an isolated database. Runs on Deno,
 * Node, and Bun — the listener is `node:net`.
 *
 * @example
 * ```ts
 * import { pgtemp } from "@surprisetalk/pgtemp";
 *
 * Deno.test("my query", async () => {
 *   await using pg = await pgtemp({
 *     setup: `create table todo (id serial primary key, body text)`,
 *   });
 *
 *   await pg.sql`insert into todo (body) values ('ship it')`;
 *   const [row] = await pg.sql`select body from todo`;
 *   console.log(row.body); // "ship it"
 * });
 * ```
 *
 * @throws If `opts.snapshot` is not a tar or gzip blob, or if `opts.setup` fails.
 */
export const pgtemp = async (opts: PgtempOpts = {}): Promise<Pgtemp> => {
  if (opts.snapshot) await assertSnapshot(opts.snapshot);
  const setup = [opts.setup ?? []].flat();

  // node:net rather than Deno.listen so the same file runs on Deno, Node, and
  // Bun. Sockets are tracked because server.close() only stops new accepts —
  // it waits on live ones, which would hang teardown.
  const sockets = new Set<Socket>();
  const server = createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve); // port 0 — OS-assigned free port
  });
  const port = (server.address() as AddressInfo).port;
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;

  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  // reset() swaps the backend; the listener and port survive it, so `url` stays
  // valid and `db`/`sql` are read through getters rather than captured.
  let db: PGlite;
  let sql: Sql;
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
    await stop();
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

  server.on("connection", async (socket) => {
    await fromNodeSocket(socket, {
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
  });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await sql.end();
    await stop();
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
        await stop();
        throw e;
      }
    },
    close,
    [Symbol.asyncDispose]: close,
  };
};

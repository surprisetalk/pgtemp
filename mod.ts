import { PGlite } from "@electric-sql/pglite";
import type { Extensions } from "@electric-sql/pglite";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { BackendError } from "pg-gateway";
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
   *
   * Your own driver may pool over {@linkcode Pgtemp.url}: connections take the
   * backend a transaction at a time. It is still one session, so a `set` or a
   * temp table is visible to every connection, and a transaction left open
   * blocks the rest until it ends.
   */
  sql: Sql;
  /** Dump the data dir as an uncompressed tarball, for {@linkcode Pgtemp.reset} or {@linkcode PgtempOpts.snapshot}. */
  snapshot: () => Promise<Blob>;
  /**
   * Restore `snap` exactly — data and DDL. With no argument, rebuild what
   * {@linkcode pgtemp} first returned. The listener survives either way, so
   * {@linkcode Pgtemp.url} and {@linkcode Pgtemp.port} stay valid, and so do
   * connections you opened yourself. Session state (an open transaction, a
   * `SET`) is lost.
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

// A named prepared statement lives in the backend session, and reset() throws the
// whole session away — so every name a client cached would Bind against a backend
// that never Parsed it, failing with 26000, fatally so inside a transaction the
// driver cannot re-prepare its way out of. Rather than mirror the session's
// statement table out here and replay it on every swap, named statements are
// refused at the door. The bundled client sets `prepare: false`; anything else on
// the wire is told to.
const refuseNamed = (data: Uint8Array) => {
  // pg-gateway delivers exactly one framed message per call, so this needs no
  // buffering: 'P' is Parse, and its statement name is the first cstring.
  if (data[0] !== 0x50) return;
  if (data[5] === 0) return; // the unnamed statement never outlives its own Bind
  const name = new TextDecoder().decode(data.subarray(5, data.indexOf(0, 5)));
  // FATAL, and thrown rather than returned, so pg-gateway writes the frame and
  // drops the connection. Answering in-band and staying up is worse: postgres.js
  // fetches its array types on connect and never runs the query it was opened for
  // if that fetch fails, so a live connection would hang instead of reject.
  //
  // The fix goes in `message` because that is the field that gets printed. hint
  // and detail are for drivers that surface them.
  throw BackendError.create({
    severity: "FATAL",
    code: "0A000",
    message:
      `pgtemp: prepared statements are not supported (Parse "${name}"). Set prepare: false on your driver — postgres(url, { prepare: false }).`,
    detail: "pgtemp is one Postgres session, and reset() replaces it, so a statement name cannot survive.",
    hint: "pg.sql already sets it. node-postgres only names a statement when you pass { name } to query().",
  });
};

// A simple Query frame: 'Q', length (self-inclusive, type byte excluded), SQL.
// Outside a transaction this is a no-op that warns, which is the right shape for
// a cleanup that cannot know.
const ROLLBACK = new Uint8Array([0x51, 0, 0, 0, 13, ...new TextEncoder().encode("rollback\0")]);

// True when the backend finished this batch outside a transaction — the only
// point another connection may take it. Frames are walked rather than scanned
// for 0x5a, because row data contains that byte all the time. A batch can carry
// several ReadyForQuery (one per Sync in a pipeline); the last one is the state
// the backend is actually left in. Empty output (Parse, Bind) means "still
// mid-statement", so the answer is no.
const idle = (out: Uint8Array) => {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let status = 0;
  for (let i = 0; i < out.length;) {
    // Length excludes the type byte and includes itself, so a frame is 1 + len.
    if (i + 5 > out.length) throw new Error(`pgtemp: truncated backend frame at byte ${i} of ${out.length}.`);
    const len = view.getUint32(i + 1);
    if (len < 4 || i + 1 + len > out.length) {
      throw new Error(
        `pgtemp: backend frame '${String.fromCharCode(out[i])}' at byte ${i} claims ${len} bytes, of ${
          out.length - i - 1
        } left.`,
      );
    }
    if (out[i] === 0x5a) status = out[i + 5]; // ReadyForQuery: 'I' idle, 'T' in one, 'E' failed
    i += 1 + len;
  }
  return status === 0x49;
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

  // Declared up here rather than next to close(): the listener is already
  // accepting, and a socket that opens and dies during boot reads it.
  let closed = false;
  // reset() swaps the backend; the listener and port survive it, so `url` stays
  // valid and `db`/`sql` are read through getters rather than captured.
  let db: PGlite;
  let sql: Sql;
  // A connection accepted mid-swap must wait for the new backend rather than read
  // the closed one out of `db`.
  let ready: Promise<void>;

  // PGlite is one backend session, so connections take turns holding it — for a
  // whole transaction, not a message, or a pool's two halves interleave inside
  // one. Ownership is handed straight to the next waiter (FIFO), never dropped
  // and re-contested, so a busy pool cannot starve a connection.
  const waiting: (() => void)[] = [];
  let leased = false;
  const lease = () => {
    if (leased) return new Promise<void>((resolve) => waiting.push(resolve));
    leased = true;
    return Promise.resolve();
  };
  const unlease = () => {
    const next = waiting.shift();
    if (next) next();
    else leased = false;
  };

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
    sql = postgres(url, {
      // max: 1 — a pool would work now, but buys nothing: one backend runs one
      // transaction at a time either way, and postgres.js already pipelines
      // overlapping queries over a single connection, in order.
      max: 1,
      prepare: false, // see refuseNamed
      fetch_types: true,
      onnotice: opts.onnotice ?? (() => {}),
    });
  };

  try {
    await (ready = boot(opts.snapshot, setup));
  } catch (e) {
    await stop();
    throw e;
  }

  server.on("connection", async (socket) => {
    // Held across messages, not per message: Parse/Bind/Execute answer with zero
    // bytes and settle nothing, so the backend only changes hands where the
    // backend itself says it is between transactions.
    let holds = false;
    const done = () => {
      if (!holds) return;
      holds = false;
      unlease();
    };
    // Holding the lease at close means the client vanished mid-transaction. A
    // real backend would exit and take its transaction with it; this one is a
    // shared session that just keeps going, so the next connection to be handed
    // it would find itself inside a stranger's open transaction. Roll back
    // first, still under the lease, and only then let go.
    socket.on("close", () => {
      if (!holds) return;
      if (closed) return done(); // the whole instance is going away
      db.execProtocolRaw(ROLLBACK).catch(() => {}).finally(done);
    });

    await fromNodeSocket(socket, {
      async onStartup() {
        await ready;
        await db.waitReady;
      },
      async onMessage(
        data: Uint8Array,
        { isAuthenticated }: { isAuthenticated: boolean },
      ): Promise<Uint8Array | undefined> {
        if (!isAuthenticated) return;
        if (data[0] === 88) { // Terminate
          done();
          return;
        }
        refuseNamed(data);
        if (!holds) {
          await lease();
          holds = true;
        }
        try {
          // `ready` as well as the lease: a connection that outlived a swap can
          // send the next query while the new backend is still booting, and must
          // not be handed the closed one out of `db`.
          await ready;
          // .slice() copies. execProtocolRaw returns a view straight into the
          // WASM heap, and the socket write is queued, not immediate — so the
          // next connection's exec reuses that memory and rewrites bytes already
          // promised to this one. It corrupts tail-first: a client would get a
          // 6-byte ReadyForQuery whose type byte had turned into someone else's
          // NoticeResponse, and hang forever waiting for a frame it was already
          // sent. Harmless while only one connection is ever in flight, which is
          // why it stayed hidden.
          const out = (await db.execProtocolRaw(data)).slice();
          if (idle(out)) done();
          return out;
        } catch (e) {
          done();
          throw e;
        }
      },
    });
  });

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
        // `ready` is replaced before the await so that a query arriving on a
        // surviving connection blocks on the new backend rather than the closed one.
        await (ready = boot(snap ?? opts.snapshot, snap ? [] : setup));
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

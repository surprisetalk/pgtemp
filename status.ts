// pgtemp's status for snitch (~/Developer/snitch/projects.tsv). Prints one JSON
// object of conditions and exits 1 when any scores below 1.0. Run: deno task status
import { pgtemp } from "./mod.ts";

const { version } = JSON.parse(await Deno.readTextFile(new URL("deno.json", import.meta.url)));

const get = async (url: string, fix: string) => {
  const res = await fetch(url, { headers: { "user-agent": "pgtemp-status" }, signal: AbortSignal.timeout(10_000) })
    .catch((e) => {
      throw new Error(
        `status: no answer from ${url}.\n\n  Expected: an answer within 10s.\n  Received: ${e}\n\n  ${fix}`,
      );
    });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`status: ${url} answered HTTP ${res.status}.\n\n  Received: ${text.slice(0, 200)}\n\n  ${fix}`);
  return JSON.parse(text);
};

const shape = (url: string, expected: string, received: unknown): never => {
  throw new Error(
    `status: ${url} changed shape.\n\n  Expected: ${expected}\n  Received: ${JSON.stringify(received)?.slice(0, 200)}`,
  );
};

const JSR = "https://jsr.io/@surprisetalk/pgtemp/meta.json";
const jsr = await get(JSR, "Likely fix: check https://jsr.io/@surprisetalk/pgtemp.");
const latest = typeof jsr?.latest === "string" ? jsr.latest : shape(JSR, `{ "latest": "<version>" }`, jsr);

const CI =
  "https://api.github.com/repos/surprisetalk/pgtemp/actions/workflows/ci.yml/runs?branch=main&status=completed&per_page=1";
const ci = await get(CI, "Likely fix: GitHub rate-limits 60 requests an hour per IP. Wait, or check githubstatus.com.");
const run = ci?.workflow_runs?.[0];
const conclusion = typeof run?.conclusion === "string"
  ? run.conclusion
  : shape(CI, `{ "workflow_runs": [{ "conclusion": "success" }] }`, ci);

// The fastest of 3, so that one slow run on a loaded host does not fail the check.
const fastest = async (boot: () => Promise<{ close: () => Promise<void> }>) => {
  const ms: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    await (await boot()).close();
    ms.push(performance.now() - start);
  }
  return Math.min(...ms);
};
const snapshot = await (async () => {
  await using pg = await pgtemp();
  return await pg.snapshot();
})();
const warm = await fastest(() => pgtemp({ snapshot }));
// 1000ms and 300ms are ~3x the cold and snapshot boots on an idle M-series Mac.
// Condition names stay fixed, because snitch tracks each one's streak by name.
const cold = await fastest(() => pgtemp());
console.log(
  `deno.json ${version}, JSR ${latest}, CI ${conclusion}, boot ${warm.toFixed(0)}ms warm, ${cold.toFixed(0)}ms cold`,
);
const conditions = {
  "JSR serves the version in deno.json.": { "0": latest === version ? 1 : 0 },
  "CI passed on the latest finished run on main.": { "0": conclusion === "success" ? 1 : 0 },
  "A pgtemp() from a snapshot boots in 300ms.": { "0": 300 / warm },
  "A pgtemp() with no snapshot boots in 1000ms.": { "0": 1000 / cold },
};
console.log(JSON.stringify(conditions, null, 1));
if (Object.values(conditions).some((c) => c["0"] < 1)) Deno.exit(1);

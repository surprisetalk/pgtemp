- [ ] `deno task status` on pc grades both boot times 1.0 while pc is busy. Cause: pc runs at load 21 on 16 cores
      (doorable seeding, deno server.tsx, toil). The 300 ms and 1000 ms limits in status.ts fit an idle M-series Mac,
      and pc measures 338 ms warm and 1852 ms cold. PGlite boot is CPU-bound, so load slows it.
  1. In status.ts, measure CPU time and not wall time. Record `Deno.cpuUsage()` before and after each boot. Keep the 300
     ms and 1000 ms limits and the condition names.
  2. If `Deno.cpuUsage()` is not in deno 2.9.8, run the boot timing on the Mac only, like scrap's status row in
     ~/Developer/snitch/projects.tsv. Print one line on pc that says where the boot check runs.
  3. Check that out-pc.txt's second-cluster warning stays: status.ts boots cold clusters on purpose, so the warning is
     noise and not a failure.

- [ ] Every Deno project tests against its own isolated database. Decision: bucket "maintain" in the projects strategy
      (~/Documents/tasks/todo.md, projects entry, 27 Oct).
  1. Confirm JSR version matches HEAD. Publish only if they differ.
  2. Check that doorable and qc tests use pgtemp.

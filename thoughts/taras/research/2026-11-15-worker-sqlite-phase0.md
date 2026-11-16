# Worker SQLite Phase 0, corrected evidence

**Version 2 supersedes every previous Phase 0 timing and RSS table.**
Both platforms pass vector capability and the calibrated 50 ms lag gate.
The parent accepts the observed transfer and memory costs for the default-off Phase 1 implementation.
This decision does not approve production rollout. No production memory acceptance budget exists.
Runtime, dependencies, and later phases remain unchanged at this checkpoint.

Bun 1.4.4, revision 38afee6c8, matches repository pins. Both platforms use native arm64.
Linux runs the compiled binary on Debian bookworm through OrbStack, without network or source mounts.
Compilation includes production's `--compile-exec-argv='--expose-gc'` flag. Linux x64 remains unmeasured.
Every SQL connection passes sqlite-vec v0.1.9 insert and nearest-neighbor checks.
Both macOS threads configure Homebrew SQLite before opening connections.
Embeddings remain 512 Float32 dimensions and 2,048 bytes.

Each case, driver, and round uses a fresh process with one SQL connection.
Fixture creation and local serialization experiments use separate processes.
Two rounds alternate sqlite/worker and worker/sqlite order.
Each ordinary driver records 20 samples total, with three warmups per round.
Each long-query driver records six samples total, with one warmup per round.
Both active JavaScript threads collect synchronously before each warmup and sample.
Result arrays are explicitly emptied before collection. Value hashing occurs after the memory window.

All four fixture definitions match migrated column names, order, types, defaults, nullability, and primary-key positions.
Tasks expose 92 columns, memories 27, logs 10, and KV rows nine.
Additional fields use migration defaults or null. Existing synthetic content and 16 KiB task text remain unchanged.

Durations use milliseconds. RTT excludes explicit JSON decoding. Transport and decoding lag use separate armed probes.
Worker RTT includes Bun's internal message deserialization.
Forced collection before each sample favors lower tail latency and memory use compared with sustained production work without forced collection.
These are controlled comparisons, rather than steady-state production estimates.

| Platform | Case | SQLite RTT p50 / p95 | Worker RTT p50 / p95 | Absolute overhead | Ratio |
|---|---|---:|---:|---:|---:|
| macOS | session_logs | 0.672 / 0.958 | 2.274 / 2.944 | 1.602 | 3.384x |
| macOS | agent_tasks | 1.414 / 3.164 | 2.785 / 3.441 | 1.371 | 1.970x |
| macOS | agent_memory | 0.374 / 0.460 | 0.673 / 0.864 | 0.299 | 1.799x |
| macOS | kv_entries | 16.385 / 21.225 | 46.408 / 48.264 | 30.023 | 2.832x |
| macOS | recursive_cte | 966.503 / 1028.853 | 1000.926 / 1009.098 | n/a | n/a |
| macOS | small_statements | 0.063 / 0.086 | 2.113 / 2.860 | 2.050 | 33.540x |
| Linux compiled | session_logs | 1.163 / 2.829 | 3.649 / 5.781 | 2.486 | 3.138x |
| Linux compiled | agent_tasks | 2.753 / 4.098 | 5.419 / 7.949 | 2.666 | 1.968x |
| Linux compiled | agent_memory | 0.704 / 2.144 | 1.415 / 2.630 | 0.711 | 2.010x |
| Linux compiled | kv_entries | 20.585 / 25.492 | 53.723 / 58.672 | 33.138 | 2.610x |
| Linux compiled | recursive_cte | 996.392 / 1019.676 | 993.571 / 1021.036 | n/a | n/a |
| Linux compiled | small_statements | 0.109 / 0.248 | 4.105 / 8.628 | 3.996 | 37.661x |

Session logs and repeated small statements exceed the 3x review trigger on both platforms.
The small-statement row contains 100 sequential operations.
Overhead per operation reaches 20.50 microseconds on macOS and 39.96 on Linux.
Serialized payload sizes and separate serialization, deserialization, and clone statistics remain in the JSON.

Long queries calibrate independently in every fresh thread. Their RTT differences do not measure transport savings.
MacOS selects 7.40 to 7.74 million iterations. Both threads execute about 129.8 to 130.1 ns per iteration.
Linux selects 8.80 to 9.09 million iterations. SQLite executes about 109.9 to 110.8 ns per iteration.
The Linux Worker executes about 111.5 to 112.1 ns per iteration, a 1.1% to 1.4% difference.
The earlier twofold macOS execution gap does not recur. These runs do not establish its earlier cause.
The JSON records every calibration step and sample.

Maximum Worker transport lag during the long query is **2.923 ms on macOS** and **4.060 ms on Linux**.
Worker SQL p50 is 1,000.814 ms and 993.433 ms, respectively.
Separate Linux KV decoding lag reaches 14.956 ms in Worker mode. Decoding is caller work, rather than transport cost.

Transport lag excludes explicit JSON decoding. These values show p50 / maximum lag in milliseconds.

| Platform | Case | SQLite lag | Worker lag |
|---|---|---:|---:|
| macOS | session_logs | 1.264 / 1.315 | 1.267 / 2.038 |
| macOS | agent_tasks | 1.273 / 2.813 | 1.272 / 1.831 |
| macOS | agent_memory | 1.265 / 1.287 | 1.267 / 2.448 |
| macOS | kv_entries | 14.935 / 21.960 | 7.598 / 9.803 |
| macOS | recursive_cte | 964.792 / 1026.390 | 1.306 / 2.923 |
| macOS | small_statements | 1.267 / 1.330 | 1.266 / 1.834 |
| Linux compiled | session_logs | 2.107 / 3.414 | 2.083 / 2.743 |
| Linux compiled | agent_tasks | 2.484 / 3.829 | 2.195 / 4.283 |
| Linux compiled | agent_memory | 1.963 / 4.205 | 1.929 / 3.736 |
| Linux compiled | kv_entries | 18.413 / 27.924 | 6.342 / 10.270 |
| Linux compiled | recursive_cte | 994.617 / 1017.927 | 2.891 / 4.060 |
| Linux compiled | small_statements | 2.060 / 4.041 | 2.304 / 3.790 |

External RSS sampling continues during work, including blocking main-thread SQL.
MacOS uses `ps` RSS in KiB. Linux samples `VmRSS`, `RssAnon`, and `RssFile` from `/proc/PID/status`.
The JSON records baseline RSS, idle RSS after warmup, sampled workload peaks, peak changes, and RSS after collection.
It also records thread-local JSC heap statistics at explicit boundaries.

The following differences subtract each process baseline before comparing Worker and SQLite.
Ranges cover two rounds and use MiB. Each component maximum can occur at a different instant.
The original sampler could classify a sample across a stage transition incorrectly.
This affected some macOS baselines by up to 4.6 MiB. The baseline-adjusted ranges below are provisional.
The sampler now discards samples that cross stage transitions. Gate acceptance uses absolute peaks and paired post-collection readings instead.
On macOS, the idle measurements include memory retained after warmup. They do not measure the cost of an unused Worker.

| Case | macOS extra idle | macOS extra sampled peak | Linux extra idle | Linux extra sampled peak |
|---|---:|---:|---:|---:|
| session_logs | 17.9 to 18.3 | 32.5 to 33.5 | 4.9 to 5.4 | 15.0 to 16.6 |
| agent_tasks | 14.4 to 15.5 | 25.2 to 25.7 | 4.9 to 5.2 | 11.5 to 12.0 |
| agent_memory | 1.8 to 6.0 | 3.0 to 7.3 | 5.5 to 6.0 | 6.0 to 6.5 |
| kv_entries | 100.1 to 104.4 | 99.5 to 101.8 | 6.9 to 9.0 | 89.6 to 109.6 |
| recursive_cte | 4.1 to 4.2 | 5.9 to 6.4 | 3.3 to 3.7 | 5.8 to 6.1 |
| small_statements | 5.6 to 5.6 | 5.6 to 5.8 | 4.5 to 7.0 | 4.4 to 5.4 |

KV absolute sampled peaks reach 194.3 to 195.7 MiB for SQLite and 297.7 to 298.3 MiB for Worker on macOS.
Linux reaches 175.7 to 176.6 MiB for SQLite and 266.2 to 285.2 MiB for Worker.
Linux KV `RssAnon` peaks reach 61.4 to 62.3 MiB for SQLite and 150.0 to 169.0 MiB for Worker.
Corresponding `RssFile` peaks reach about 114.2 MiB and 116.3 MiB.

After KV collection, main JSC heaps contain about 1.4 to 1.5 MiB. The Worker SQL heap contains about 0.3 MiB.
After KV collection, macOS RSS is 194.3 to 195.7 MiB for SQLite and 297.7 to 298.3 MiB for Worker.
The paired Worker increase is 102.0 to 104.0 MiB.
Linux RSS after collection is 125.9 to 126.8 MiB for SQLite and 134.4 to 141.6 MiB for Worker.
The paired Worker increase is 8.5 to 14.8 MiB. File mappings account for about 114 MiB in both Linux modes.
The collected JS heaps do not explain the remaining increase. Native allocations and allocator retention remain possible causes, rather than established diagnoses.

Sampled peaks are lower bounds. Maximum workload sampling gaps are 20.277 ms on macOS and 16.289 ms on Linux.
Sampling and explicit GC affect scheduling. Cases share a warm OS file cache.
Fixtures cover complete result keys, rather than production distributions of populated metadata.
Production retains a boot connection and adds DbClient behavior. This spike does not validate that topology or HTTP responsiveness.

Verification commands all passed:

```bash
bun run lint
bun run tsc:check:tsc
bunx --no-install biome check scripts/bench-db-worker.ts scripts/bench-db-worker-thread.ts scripts/bench-db-worker-fixture.ts scripts/bench-db-worker.tsconfig.json
bun tsc --noEmit -p scripts/bench-db-worker.tsconfig.json
bun scripts/check-bun-version.ts
bun --expose-gc scripts/bench-db-worker.ts --json
docker buildx build --builder db-worker-phase0-correction --load -f scripts/bench-db-worker.Dockerfile -t db-worker-phase0:correction .
docker run --rm --network none --name db-worker-phase0-correction-linux db-worker-phase0:correction --json
```

Repository lint reported five existing warnings and four informational messages. Direct benchmark lint and TypeScript checks reported none.
A separate check compared all four fixture tables against `runMigrations(new Database(":memory:"))` with `PRAGMA table_info`.
The benchmark TypeScript configuration supports reproducible checks despite the root exclusion of `scripts/`.

The parent also ran `bun scripts/bench-db-worker.ts --json` without the explicit GC flag. It exited 0 with all six cases.
The JSON preserves this additional run under `literalCommandVerification`. Temporary output files were removed after preservation.
Disk availability remained 16 GiB before and after this command.

Final review corrections discard RSS samples across stage transitions and strengthen the typed, ordered row signature.
They also stream UTF-8 decoding and use the reported calibration target.
The complete macOS benchmark passed again after these corrections. Direct TypeScript and repository lint also passed.
The JSON preserves this run under `finalReviewVerification`. Linux results remain the version 2 run, before these measurement-only corrections.
The parent accepts Phase 0 for default-off implementation. Production memory acceptance requires sustained measurements without forced GC.
The benchmark Dockerfile has a separate Bun pin. Future pin updates must include it, although runtime mismatch checks already reject drift.

Missing-extension checks exited 1 for macOS main, macOS Worker only, and compiled Linux Worker only.
Both Worker-only checks first passed the seed process vector check. Invalid driver selection also exited 1 before allocation.
The JSON preserves exact commands, failure details, and cleanup outcomes.
Cleanup checks SQL closure, the Worker exit callback, the close event, child-process exit, and the owned directory itself.

Cleanup removed four benchmark images, the newly acquired BuildKit image, and the private builder with its cache volume.
Original images and shared caches remain. All benchmark children, containers, database directories, and 42 owned temporary files are removed.
OrbStack returned to its original stopped state. No benchmark binary remains.

Initial free space was 17 GiB. The task ended with 16 GiB available.
Cleanup increased available space by 4.085 GiB. The complete task reduced available space by 1.148 GiB.
That net difference remains un-attributed despite verified removal of owned products. No shared cache or VM image was pruned.

```text
Before cleanup:
Filesystem        Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s1s1   460Gi    12Gi    12Gi    51%    459k  122M    0%   /

After cleanup:
Filesystem        Size    Used   Avail Capacity iused ifree %iused  Mounted on
/dev/disk3s1s1   460Gi    12Gi    16Gi    44%    459k  164M    0%   /
```

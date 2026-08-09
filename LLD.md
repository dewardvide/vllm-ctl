# vLLM Admin UI — Low-Level Design

A local-first control plane for vLLM: manage models, run them with full control
over every engine option, watch the machine in real time, and benchmark what it
can actually serve.

This document explains how it is built and, where a decision was not obvious,
why it was made that way. It is written for someone about to change the code.

---

## 1. Context and constraints

The app targets a single workstation, not a cluster:

| | |
|---|---|
| GPU | 1× RTX 3090, 24 GiB, driver 595.84, CUDA 13.2 |
| Host | 12 cores, 15 GiB RAM |
| vLLM | 0.26.0, in a uv virtualenv (not on `PATH`) |
| GuideLLM | 0.7.3, in an isolated `uv tool` environment |
| Runtime | Node 22, Next.js 16 (App Router), React 19, Tailwind v4 |

Three constraints shape everything below:

1. **24 GiB is a hard wall.** Every decision the user makes — which model, what
   context length, what quantization, what else runs alongside — is really a
   decision about that wall. The UI is built around it.
2. **This is one long-lived Node process.** Supervising child processes and
   streaming telemetry both require state that outlives a request. There are no
   serverless assumptions anywhere in the codebase.
3. **It must feel instant.** A dashboard you distrust is a dashboard you stop
   opening. Section 4 covers how that is achieved concretely.

---

## 2. Architecture

```
Browser ──SSE──▶ /api/stream/*  ──reads──▶ in-memory ring buffers
   │                                              ▲
   └──fetch──▶  /api/*  (mutations)               │ 1 Hz / 2 Hz
                                                  │
              ┌───────────────────────────────────┴─────────────┐
              │  module-scope singletons                          │
              │  sampler · supervisor · metricsPoller             │
              │  · downloads · benchmarks                         │
              └───────────────┬──────────────────────────────────┘
                              │ spawns
                              ├── vllm serve      (one per deployment)
                              ├── hf download     (one per download)
                              ├── guidellm run    (one at a time)
                              └── nvidia-smi      (one per tick)
                              │
                          SQLite (WAL)  ~/.vllm-admin/vllm-admin.db
```

Singletons are stashed on `globalThis` so Next's dev-mode module reloading
cannot produce two samplers or orphan a supervisor's process registry.

`src/instrumentation.ts` runs once per server process before the first request.
It starts the sampler and metrics poller, prunes old telemetry, and reconciles
anything left behind by an unclean shutdown.

---

## 3. Module map

Each module has one job and a narrow interface, so it can be reasoned about and
tested alone.

### Server

| Module | Responsibility |
|---|---|
| `lib/paths.ts` | Every filesystem location, resolved once. All app state lives under `~/.vllm-admin` so the install can be wiped with one `rm -rf`. |
| `lib/settings.ts` | User settings as JSON (repairable by hand when a bad path stops the app booting), plus environment auto-detection. |
| `lib/server/db.ts` | `better-sqlite3` handle, WAL mode, forward-only migrations keyed on `user_version`. |
| `lib/server/broadcast.ts` | SSE fan-out hub and the `sseResponse()` helper. |
| `lib/server/ring-buffer.ts` | Fixed-capacity circular buffer. |
| `lib/server/api.ts` | Route-handler helpers; errors come back as `{ error }` written for a human. |
| `lib/telemetry/nvidia.ts` | `nvidia-smi` CSV queries and parsing. |
| `lib/telemetry/host.ts` | CPU/RAM/disk from `/proc` and `statfs`. |
| `lib/telemetry/sampler.ts` | The single 1 Hz loop; ring buffer + batched SQLite writes. |
| `lib/vllm/parse-help.ts` | Parses `vllm serve --help=all` into a typed schema. |
| `lib/vllm/flag-schema.ts` | Runs vLLM to get that help text; caches per version. |
| `lib/vllm/argv.ts` | Builds and parses `vllm serve` command lines. |
| `lib/vllm/supervisor.ts` | Process registry and lifecycle FSM. |
| `lib/vllm/log-ring.ts` | Bounded per-process log storage and line splitting. |
| `lib/vllm/phase.ts` | Turns vLLM log lines into phase labels and fatal-error messages. |
| `lib/vllm/prometheus.ts` | Prometheus text parsing, histogram quantiles, counter rates. |
| `lib/vllm/metrics.ts` | 2 Hz scraper that turns those into displayable metrics. |
| `lib/hf/cache.ts` | Native scan/delete of the Hugging Face cache; `config.json` parsing. |
| `lib/hf/search.ts` | Hub API search and metadata. |
| `lib/hf/download.ts` | Wraps the `hf` CLI, parsing tqdm output into progress. |
| `lib/vram/estimate.ts` | The VRAM model behind the fit badge and the guard rail. |
| `lib/guidellm/argv.ts` | Builds the `guidellm run` command line. |
| `lib/guidellm/runner.ts` | Runs benchmarks, ingests results, serves history. |
| `lib/guidellm/ingest.ts` | Parses GuideLLM's report JSON; finds the saturation point. |

### Client

| Module | Responsibility |
|---|---|
| `lib/client/use-sse.ts` | One EventSource per URL, handlers read through a ref. |
| `lib/client/telemetry-store.tsx` | Shared telemetry window for the whole page. |
| `lib/client/deployments-store.tsx` | Live deployments, plus the *projection* used by the headroom rail. |
| `lib/client/use-now.ts` | A clock in state, so elapsed times don't make render impure. |
| `lib/client/api.ts` | fetch wrapper that unwraps `{ error }`. |
| `components/charts/Sparkline.tsx` | Canvas time-series for live data. |
| `components/charts/XYChart.tsx` | SVG chart for static benchmark results. |

---

## 4. How "fast" is achieved

Not aspiration — these are the specific mechanisms.

**One sampler, many viewers.** A single 1 Hz `nvidia-smi` loop and one `/metrics`
scrape per deployment, fanned out over SSE. An extra browser tab costs one more
`enqueue()` call, not another subprocess. Verified with `pgrep -fc nvidia-smi`
while three tabs are open: still one.

**One-shot `nvidia-smi`, not `-l 1`.** Loop mode looks cheaper but block-buffers
its stdout when not attached to a tty, and ignores `stdbuf`; a piped `-l 1`
emits nothing for seconds at a time. A one-shot query measures **24 ms** here,
which is a rounding error at 1 Hz.

**Ring buffers in front of SQLite.** The last ~15 minutes of telemetry lives in
memory, so a chart hydrates from one request with zero DB reads. SQLite is
written in batches of 15 samples and only read for history and benchmark
overlays.

**Canvas for live traces, SVG for static ones.** A DOM-based chart library
re-reconciles hundreds of nodes per tick; with a dozen live traces at 1 Hz that
janks. Live traces render to `<canvas>`. Benchmark results never change once a
run finishes, so they use SVG and get crisp text, hover targets and accessible
markup for free. No charting dependency is installed.

**The 274-option schema is computed once.** `vllm serve --help=all` imports
torch and takes seconds, so it is parsed once, cached on disk keyed by vLLM
version, and memoised in the process. The settings form is then a static
payload.

**Backpressure-aware log streaming.** vLLM emits hundreds of lines in bursts.
Lines are appended to a bounded 5,000-line ring and SSE frames are coalesced on
a 100 ms timer, so a CUDA-graph capture produces a handful of frames rather than
hundreds.

---

## 5. The vLLM option schema

The centrepiece of "exhaustively specify all deployment settings".

Hand-maintaining a list of vLLM's options would be wrong the day vLLM is
upgraded. Instead the app runs `vllm serve --help=all` against the *installed*
engine and parses argparse's own output. On vLLM 0.26.0 that yields **274
options across 17 config groups** (`Frontend`, `ModelConfig`, `CacheConfig`,
`ParallelConfig`, `CompilationConfig`, …).

### Output shapes handled

```
--headless                                   boolean, no negative form
--allow-credentials, --no-allow-credentials  negatable boolean pair
--gdn-prefill-backend {flashinfer,triton}    enum
--api-key API_KEY [API_KEY ...]              variadic value
--data-parallel-address ADDR, -dpa ADDR      long form plus short alias
--data-parallel-external-lb, --no-…, -dpe    negatable boolean with alias
```

### Edge cases that a naive parser gets wrong

- **Commas inside choice lists.** `--fmt {auto,openai,string}` must not be split
  on its inner commas. `splitTopLevel()` tracks `{}`/`[]` depth. This was caught
  by a test before it shipped: without it, one flag parsed as three and lost its
  enum entirely.
- **Wrapped help text.** argparse wraps at column 72 and `(default: X)` can be
  split across those lines, so help is joined before the default is extracted.
- **Negative forms.** `--no-x` is never emitted as its own option; it sets
  `negatable` on `x`.
- **Type inference.** Choices → `enum`; no value → `boolean`; `[X ...]` →
  `list`; JSON-ish help or default → `json`; otherwise the default's shape
  (integer / float / `True`/`False`), falling back to name heuristics
  (`*-size`, `*-len` → int; `*utilization*`, `*fraction*` → float).

### Tri-state values

A flag with no value set is **not passed at all**, so vLLM's own default
applies. Booleans therefore have three UI states — unset / enabled / disabled —
because "unset" and "false" mean different things and pinning a default that
changes between vLLM versions is a real hazard.

### One builder, one command

`buildServeArgv()` produces both the preview shown in the UI and the argv the
supervisor spawns. There is no second code path, so the preview cannot lie.
`parseServeCommand()` is its inverse, letting an existing shell command be
imported into the form.

**Essentials tier.** A curated list is lifted above the groups and sorted in
reach-for order, not alphabetically. Names a given vLLM build lacks are simply
not marked, so the tier degrades on upgrade rather than breaking. (0.26 dropped
`--swap-space` with the V0 engine, for instance.)

---

## 6. Deployment lifecycle

```
          spawn
            │
        ┌───▼────┐  log line implies work    ┌─────────┐
        │starting├──────────────────────────▶│ loading │
        └───┬────┘                           └────┬────┘
            │                    /health responds │
            │                        ┌────────────▼──┐
            │                        │    healthy    │
            │                        └───┬───────┬───┘
            │           user stops       │       │  process exits
            │                    ┌───────▼──┐  ┌─▼───────┐
            └───────────────────▶│ stopping │  │ crashed │
              fatal log / timeout└────┬─────┘  └─────────┘
                    │                 │
              ┌─────▼──┐        ┌─────▼───┐
              │ failed │        │ stopped │
              └────────┘        └─────────┘
```

**Why `starting` and `loading` are separate.** Weight loading, `torch.compile`
and CUDA graph capture can take minutes, during which `/health` refuses
connections. Without the distinction the UI would show an unchanging "starting"
and look hung. `lib/vllm/phase.ts` matches vLLM's own log lines to produce
labels like "loading weights", "compiling graphs", "capturing cuda graphs", so
a long start reads as progress.

**Only `/health` grants `healthy`.** A log line may promote `starting` →
`loading`, but never claims readiness; only a real HTTP 200 does.

**Fatal-error translation.** Known failure signatures are turned into an
actionable sentence rather than a Python traceback — CUDA OOM becomes "Out of
GPU memory. Lower `--gpu-memory-utilization` or `--max-model-len`, or stop
another deployment."

**Process groups.** Children are spawned `detached: true` and signalled with
`process.kill(-pid, …)`. vLLM forks engine-core workers; signalling only the
parent leaves them alive and holding VRAM. Shutdown is SIGINT (which vLLM
handles cleanly, releasing VRAM) escalating to SIGKILL after 20 s.

**Carriage returns.** Progress bars are redrawn with `\r` and carry no newline
until they finish, so the splitter normalises `\r` → `\n`. Without this the log
sits silent for the entire weight download — exactly the phase a user wants to
watch. (Found during end-to-end testing on a 13 GB download.)

**Orphan reconciliation.** A PID file records live children. On boot, any that
survived an unclean shutdown are signalled and their DB rows marked `crashed`.
Re-adopting them is not possible — their stdout is gone — so killing them is the
honest outcome; it keeps the headroom rail truthful.

---

## 7. VRAM estimation and the guard rail

```
weights  = params × bytes-per-weight(dtype or quantization) / tensor-parallel
kv/token = 2 × layers × kv_heads × head_dim × bytes(kv_dtype) / tensor-parallel
total    = weights + kv/token × max_model_len + activation overhead (~1.2 GiB)

budget    = total_vram × gpu_memory_utilization
available = budget − currently_used − safety_margin
```

Validated against ground truth for `granite-4.1-8b`, whose real figures were
documented in the machine's existing `serve.py`: 40 layers, GQA 32/8,
`head_dim` 128 → **160 KiB/token** and **~15.6 GiB** of bf16 weights. Both are
asserted in `src/lib/vram/estimate.test.ts`.

Parameter counts come from `model.safetensors.index.json` when present
(`total_parameters`, else `total_size ÷ bytes-per-weight`), then from weight
file sizes, then from a shape-derived estimate as a last resort.

**It fails closed.** If `config.json` doesn't give enough shape to size the
model, the estimate is marked `known: false` and **never** reports `fits: true`.
An early version returned "fits" for an unknown model because weights and KV
both computed as zero — precisely the launch the guard rail exists to catch. The
API returns HTTP 409 with `overridable: true`, and the UI offers "start anyway"
rather than blocking outright.

---

## 8. Engine metrics

vLLM exposes Prometheus text at `/metrics`. Neither shape is directly
displayable:

- **Counters** (`vllm:generation_tokens_total`) are differenced against the
  previous scrape to become rates. A negative delta means the server restarted,
  and yields 0 rather than a nonsense rate.
- **Histograms** (`vllm:time_to_first_token_seconds`) are interpolated the way
  Prometheus' own `histogram_quantile` does, and **differenced between scrapes
  first** — an all-time p99 would be pinned forever by the first cold request.
  When a quantile lands in the `+Inf` bucket the last finite bound is returned
  rather than a fabricated larger number.

These are estimates limited by bucket granularity, and the UI says so; a
benchmark measures latency directly.

Metrics are read into `supervisor.list()` through `globalThis.__vllmAdminMetrics`
rather than a direct import, because the poller imports the supervisor and a
static cycle would leave one singleton undefined at module-eval time.

---

## 9. Hugging Face integration

The cache layout is stable and documented:

```
<cache>/models--org--name/
  blobs/<sha>          actual content, deduplicated
  snapshots/<rev>/...  symlinks into blobs
  refs/<ref>           file containing a revision hash
```

Read in TypeScript rather than via Python: the models page becomes a filesystem
walk instead of a 1–2 second interpreter start.

**The subtlety.** Revisions share blobs, so summing per-revision sizes
double-counts. True on-disk size comes from walking `blobs/` once; per-revision
size resolves symlinks through a shared `seen` set. Deleting a single revision
then garbage-collects unreferenced blobs — otherwise "delete" would free no disk
at all, the outcome a user would least expect. Deletion paths are checked to
resolve inside the configured cache root.

**Downloads** shell out to `hf download` rather than reimplementing resumption,
xet chunk dedup and multi-worker fetching. Its tqdm output (`\r`-redrawn) is
parsed into structured percentages and byte counts.

---

## 10. GuideLLM integration

GuideLLM is the vLLM project's own load-testing tool, so it stays in lockstep
with the server.

### Command

```
guidellm run
  --backend    kind=openai_http,target=http://127.0.0.1:8000,model=<served-name>
  --profile    kind=sweep,sweep_size=10        # or synchronous | concurrent,streams=N
                                               # | throughput | constant,rate=N | poisson,rate=N
  --data       kind=synthetic_text,prompt_tokens=256,output_tokens=128
  --constraint kind=max_duration,seconds=30    # repeatable
  --output     kind=json,path=<run-dir>/benchmark.json
  --disable-console-interactive
```

Version-pinned to **0.7.3**. Releases before this used
`guidellm benchmark --rate-type`; the app asserts the installed version and
surfaces a mismatch as a settings banner rather than a broken run. As with
vLLM, one builder produces both the preview and the spawned argv.

### Two traps, both handled

1. **An unconstrained sweep never terminates.** If no constraint is configured,
   a 60-second duration limit is added rather than letting a run hang forever.
2. **Synthetic prompts need a tokenizer**, and GuideLLM resolves it from the
   *model name* — which here is a served alias like `granite-4.1-8b`, not a
   Hugging Face repo. Left alone the run dies seconds in with an opaque
   `OSError`. The API fills the tokenizer in from the real model id, and the
   form warns when it cannot. (Found by running a real benchmark against
   `guidellm mock-server`.)

### Result schema

Parsed against a real captured report, not the docs. Per benchmark:
`config.strategy.{type_,streams,rate,max_concurrency}`,
`metrics.<name>.successful.{mean,percentiles.{p50,p95,p99}}`, and
`start_time`/`end_time` as float epoch **seconds**.

**Units are mixed and the field names say which.** `*_ms` metrics are already
milliseconds; `request_latency` is in **seconds**. Getting that wrong would
misreport end-to-end latency by 1000×, so the conversion is explicit and
directly asserted in tests.

### Saturation point

The knee is the lowest load level already within 5% of peak output throughput —
past it you are buying queueing delay rather than tokens. It is the single
number most people run a sweep to find, so it gets its own panel and is marked
on both charts and in the results table.

### Telemetry overlay

Because the app samples the GPU at 1 Hz regardless, a finished run can be
replayed against `telemetry_samples` over its own window. This is the thing
GuideLLM alone cannot show: whether the later load levels were measured on a
thermally throttled card, which would invalidate the comparison.

Only one benchmark runs at a time — two load generators on one GPU would make
both results meaningless.

---

## 11. Data model

SQLite, WAL, `synchronous = NORMAL` (durable enough for telemetry, much faster).

| Table | Contents |
|---|---|
| `deployments` | Saved launch profiles; `flags` is JSON of non-default options only. |
| `deployment_runs` | One row per launch: resolved argv, pid, status, timings, exit code, log path. |
| `telemetry_samples` | `(ts, gpu_index)` primary key, `WITHOUT ROWID`. Pruned on boot past the retention window. |
| `deployment_metrics` | `(ts, run_id)`, `WITHOUT ROWID`. Derived engine metrics. |
| `benchmark_runs` | Config, argv, status, progress, timings, result path. |
| `benchmark_results` | One row per strategy within a run — the flattened chart source. |
| `downloads` | Repo, revision, status, bytes, message. |

`WITHOUT ROWID` on the two time-series tables stores rows in primary-key order,
which is exactly the order every range query reads them in.

---

## 12. HTTP surface

### Streams (SSE)

| Route | Events |
|---|---|
| `/api/stream/telemetry` | `history` once on connect (the whole in-memory window, so charts paint fully drawn), then `sample` per tick |
| `/api/stream/deployments` | `state` on every lifecycle or metric change; `exited` on process exit |
| `/api/stream/deployments/[runId]/logs` | `lines` — batched, not per line |
| `/api/stream/downloads` | `state` |
| `/api/stream/benchmarks` | `state` |
| `/api/stream/benchmarks/[id]/logs` | `lines`; a finished run's tail is read back from disk |

### Mutations

`/api/deployments` (CRUD) · `/api/deployments/{start,stop,restart,history}` ·
`/api/models/{cache,search,detail,download}` · `/api/vram` · `/api/flags` ·
`/api/benchmarks` + `/api/benchmarks/[id]{,/cancel}` · `/api/settings`

Model repo ids contain slashes, so `/api/models/detail` takes `?repo=` rather
than a path segment.

---

## 13. Design language — "Rack Instrument"

**Palette.** A cold graphite canvas (`#0b0e11`), never pure black. The chrome
accent is a deliberately desaturated arctic cyan (`#5ec8d8`) used *only* for
focus, active nav and primary actions. All other colour is a **thermal ramp**
with physical meaning — `#1f3a5f` idle → `#2e7ba6` → `#4fb3a5` nominal →
`#e8a33d` loaded → `#e05b49` saturated — used exclusively inside data marks.

Status colours are *points on that same ramp*: healthy is the same teal as a
mid-load chart series, failed the same vermilion as saturation. One vocabulary,
learned once, rather than two palettes that happen to coexist.

**Type.** Archivo for the interface and, at its wide optical width, for engraved
rack nameplates (`.plate`: 10 px, uppercase, +0.14 em tracking). IBM Plex Mono
for every number, with tabular figures so digits never shift width at 1 Hz.

**Structure.** Panels are regions delimited by hairlines, not cards with radius
and shadow. Emphasis comes from **corner registration ticks** — the marks on an
engineering drawing — reserved for live panels.

**Signature: the headroom rail.** A 24 GiB wall governs every decision in this
app, so the allocation of that wall is pinned under the nav on every screen,
segmented by which process owns which slice. When you configure a deployment its
projected footprint appears as a hatched ghost segment on that same rail, going
red when it would overcommit. The guard rail is not a separate widget; it is the
instrument you have been reading all along. This is what
`DeploymentsProvider.projection` exists for.

**Motion rule.** Movement is reserved for transitional state. A healthy, steady
system is completely still; anything that breathes or pulses is asking for
attention. `prefers-reduced-motion` disables it all.

---

## 14. Testing

104 tests over the logic that carries real risk of being subtly wrong, all
against captured real-world fixtures rather than invented ones.

| Suite | Fixture | Covers |
|---|---|---|
| `vllm/parse-help.test.ts` | verbatim 1,818-line `--help=all` from vLLM 0.26.0 | all six signature shapes, wrapped defaults, type inference, group recovery, the comma-in-choices bug, value coercion |
| `vllm/prometheus.test.ts` | vLLM-shaped exposition text | label parsing with embedded commas, histogram quantile interpolation and monotonicity, `+Inf` handling, counter-reset behaviour, windowed deltas |
| `vram/estimate.test.ts` | granite-4.1-8b ground truth | 160 KiB/token, 15.6 GiB weights, fp8 KV doubling context, quantization savings, tensor-parallel division, fail-closed on unknown models |
| `guidellm/guidellm.test.ts` | a real 0.7.3 report from `guidellm mock-server` | argv for every profile/data/constraint, seconds→ms conversion, saturation-point detection, malformed-report tolerance |

The supervisor is not unit-tested against a real 16 GiB model load; it was
verified end-to-end instead (section 15).

Run: `npm test` · `npm run typecheck` · `npm run lint`.

---

## 15. Verification performed

- `npm run build` — clean production build, 30 routes.
- `npm test` — 104 passing. `tsc --noEmit` and `eslint` both clean.
- **Telemetry:** live RTX 3090 data streaming at 1 Hz; figures cross-checked
  against `nvidia-smi`. One sampler process regardless of open tabs.
- **Environment detection:** found the vLLM venv at
  `~/granite-inference/.venv/bin` and GuideLLM at `~/.local/bin` with no
  configuration.
- **Flag schema:** 274/274 options parsed from the live engine, across 17 groups.
- **Deployment:** `granite-4.1-8b` started through the API at
  `max-model-len=16384`, `gpu-memory-utilization=0.9`. vLLM's own
  `non-default args` echo matched the previewed command exactly. The lifecycle
  reported `loading` with phase labels, downloaded 13 GB, and allocated
  17.5 GiB of VRAM.
- **GuideLLM:** a real `concurrent` benchmark run against `guidellm mock-server`
  produced the report that the ingest parser is tested against.

---

## 16. Known limitations

- **No authentication.** The app binds to loopback and assumes a single trusted
  user. It must not be exposed to a network. vLLM endpoints it starts are
  equally unauthenticated unless `--api-key` is set.
- **Latency percentiles from `/metrics` are approximations** bounded by vLLM's
  histogram buckets. Benchmarks measure directly.
- **VRAM estimates are estimates.** vLLM's allocator also holds CUDA graphs,
  activation buffers and fragmentation that no static formula predicts exactly.
- **A restart cannot re-adopt orphans.** Their stdout is unrecoverable, so they
  are stopped instead.
- **Single GPU in the UI.** Telemetry and the VRAM guard are written per-device,
  but the headroom rail and estimator currently read GPU 0.
- **GGUF models cannot be sized.** They carry no `config.json`, so the estimator
  reports "cannot verify" rather than guessing.
- **`vllm serve --help=all` costs a few seconds** on first load per vLLM
  version, because it imports torch. Thereafter it is cached on disk.

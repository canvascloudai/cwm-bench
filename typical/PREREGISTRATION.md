# cwm-bench "typical" workload: pre-registration

Status: **DRAFT for freeze.** It becomes frozen at the git commit whose SHA is passed as `app_source_git_ref` for the first typical campaign apply. That SHA is the campaign's `measurement_sha`. Any change after that commit, including to the workload, dataset, ladder or analysis, makes a new campaign version. The change and its reason must then be stated in the report.

Written 2026-09-27. Owner: Kevin Brown (Canvas Cloud AI).

Labels used in this document:
- **[FACT]**: stated in the cwm-bench repo at commit `117051b` or in the live `GET https://www.cloudworldmodel.ai/api/accuracy-benchmark` response read on 2026-09-27. Source cited inline.
- **[DECISION]**: a choice made for this campaign (by Kevin, or by us where he delegated it). Not a measurement.
- **[ASSUMPTION]**: a premise that is not verified.
- **[DERIVED]**: arithmetic from facts or decisions above it. The arithmetic is shown.

---

## 1. Purpose

The accuracy page currently carries a caveat. The owned benchmark uses a **lean** app (measured app CPU 0.479 / 1.79 / 8.63 / 13.36% at 10 / 100 / 500 / 1,000 total RPS [FACT: holdout/exports/473f1339.summary.md]), while CWM self-serve defaults to the **typical** app weight. Typical's weight `k = 11.79` comes from a documentation figure of 20% CPU (range 10–40%) at 50 RPS per m5.large. It is not a measurement [FACT: engine 1.2.3 calibration notes supplied by Kevin].

This campaign measures a **fixed, externally shaped reference workload** and publishes the result, whatever it is. It does **not** try to reproduce 20%.

## 2. Non-circularity rules (binding)

1. **No CPU or latency targets appear anywhere.** That covers this spec, the app, the seed, the k6 scripts, the Terraform variables and the adapter. The workload is defined only by what each request does.
2. Nothing in the workload, dataset or ladder may be changed after any typical measurement, including a local one, without creating a new campaign version (section 11).
3. Local runs before the campaign may check **correctness only** (routes return the specified shapes and status codes). If anyone looks at local CPU or latency, the report must say so.
4. The engine's typical CPU predictions are frozen in section 9.2 now. Engine latency and throughput predictions are to be generated and committed before the campaign (section 9.2, Kevin action).
5. **Publish regardless** (section 10).

## 3. Topology (unchanged from lean except the two flags)

| Item | Value | Label |
| --- | --- | --- |
| Region | **us-east-2** (same as the owned lean campaign) | [DECISION]; lean primary region [FACT: holdout/REPORT.md] |
| Edge | internal ALB | [FACT: terraform/alb.tf, terraform/README.md] |
| App | 2 × m5.large, Amazon Linux 2023, Node 20, gp2 30 GiB | [FACT: terraform/variables.tf] |
| DB | 1 × db.r5.large, MySQL 8.0, Single-AZ, gp2 100 GiB, `max_connections` override 500 | [FACT: terraform/variables.tf, terraform/README.md] |
| Generator | c6i.xlarge, k6 v0.54.0 | [FACT: terraform/variables.tf] |
| `app_profile` | `typical` | [DECISION] |
| `app_workers` | **2 Node worker processes per server** (Node `cluster`; the primary process does not serve requests) | [DECISION: approved by Kevin] |
| `APP_POOL_SIZE` | 250 per server, split **125 per worker** (`floor(250 / 2)`), so 2 servers × 2 workers × 125 = 500 = the declared `max_connections` | [DECISION]; 250 default [FACT: terraform/variables.tf] |
| `APP_QUEUE_LIMIT` | 50 per worker | [ASSUMPTION: keeping the existing per-pool default; lean has one pool per server] |

Why 2 workers: the engine formula scales CPU by `2 / v` (v = vCPUs), which assumes the app can use every vCPU. A single Node process uses at most one vCPU (about 50% of an m5.large). [DECISION, reasoning stated]

## 4. Workload: RealWorld ("Conduit") API subset, defined by request behavior

Shape source: the public RealWorld API spec (Conduit): articles, profiles, comments, users/login, `Authorization: Token <jwt>`. It is implemented in the same stack as lean (Express 4 + mysql2, raw SQL, no ORM) [DECISION].

### 4.1 Applies to every request (including login)

- The request carries `Authorization: Token <jwt>`. The app verifies it **before routing** as follows:
  1. Split the token into its three parts.
  2. Recompute HMAC-SHA256 over `header.payload` with `node:crypto`.
  3. Compare in constant time (`timingSafeEqual`).
  4. Parse the payload JSON.
  5. Check `exp`.

  There is no DB lookup for auth. [DECISION: stateless verify, the usual JWT pattern]
- Login requests also carry and verify a token. This is a deliberate uniformity choice so that "token verify on every request" holds literally. Real RealWorld login is unauthenticated. [DECISION, labeled deviation]
- Signing key: the fixed public benchmark key `cwm-bench-typical-hs256-key`, committed in `app-typical/src/token.js` and `load/typical.js`. It is **not a secret and not a security boundary**; only the verification cost matters. [DECISION]
- Tokens: HS256, payload `{sub, username, iat, exp}` with fixed `iat` 1767225600 (2026-01-01T00:00:00Z) and `exp` 4102444800 (2100-01-01T00:00:00Z). `sub` is the decimal user id and `username` is `user<N>`. One token per seeded user, generated deterministically by the load script. [DECISION]
- Errors keep the existing JSON contract `{"error":{"class":...}}` with the existing five classes. A token failure returns 401, class `internal`. [DECISION; classes FACT: app/README.md]

### 4.2 Request mix (frozen)

Rebalanced from the scoped 60/20/10/10 by taking the 1% login share from the list endpoint [DECISION]:

| Share | Request | Behavior per request | SQL statements (max) |
| ---: | --- | --- | ---: |
| **59%** | `GET /api/articles?limit=20&offset=O` | Page `O = 20 × U` with `U` uniform integer in [0, 49], i.e. the 1,000 most recent articles [ASSUMPTION: recent-feed pages dominate traffic]. Articles ordered by `created_at DESC, id DESC`. Each item: `slug, title, description, tagList (sorted), createdAt, updatedAt, favorited (always false), favoritesCount, author {username, bio, image, following}`. `following` is computed for the token's user. | 3 (articles ⋈ authors; tags for the 20 ids; follows for those authors) |
| **20%** | `GET /api/articles/:slug` (article page) | Slug uniform over all 10,000 articles. Returns the article with full `body`, author with `following`, `tagList`, and the **5 oldest comments** (`ORDER BY id ASC LIMIT 5`) with their authors. Deviation: RealWorld serves comments from a separate endpoint; they are combined here so there are five request types, and the limit keeps payload constant as comments are inserted during the campaign. [DECISION, labeled] | 3 (article ⋈ author + following; tags; comments ⋈ authors) |
| **10%** | `GET /api/profiles/:username` | Username uniform over all 1,000 users. Returns `{profile: {username, bio, image, following}}`. | 2 |
| **10%** | `POST /api/articles/:slug/comments` | Slug uniform over all 10,000. Body `{"comment":{"body": <fixed 200-character string>}}`. Validate the body (present, string, 1–1,000 chars). Transaction: look up the article id by slug, then `INSERT` the comment with the token's user as author. Return the created comment with its author. | 2 inside one transaction |
| **1%** | `POST /api/users/login` | User uniform over all 1,000. Body `{"user":{"email","password"}}`. Look up the user by email, run **bcrypt compare at cost 10**, sign a new HS256 token, and return `{user: {email, token, username, bio, image}}`. | 1 |

Total: 59 + 20 + 10 + 10 + 1 = **100%**.

- bcrypt implementation [DECISION]: pure-JavaScript `bcryptjs` 2.4.3, the exact version pinned in `app-typical/package.json`. Reason: the existing bootstrap runs `npm ci --ignore-scripts` [FACT: terraform/userdata/app.sh.tftpl], which skips native addon builds, so native `bcrypt` would not install. Consequence, recorded as a known limitation: `bcryptjs` runs on the worker's event loop, while native bcrypt would use the libuv thread pool. Login cost therefore adds directly to that worker's CPU and to the queueing of the requests behind it.
- Only responses listed above are sent. There is no templating, no per-request logging, and no response compression (lean has none either [FACT: app/src/server.js]). [DECISION]

## 5. Dataset (frozen, deterministic)

Seed file: `app-typical/seed/seed-typical.sql`. The typical app lives in its own `app-typical/` directory with its own `package.json` and lockfile, so the lean `app/` directory (including `app/seed/seed.sql`) stays byte-for-byte unchanged. It is generated **in SQL with no `RAND()`, `NOW()`, `UUID()` or other non-deterministic functions**. Row numbers come from cross-joins of a 0-9 digit table, not a recursive CTE. Every value is a pure function of the row id, and all timestamps come from a fixed epoch `2026-01-01 00:00:00` plus id-based offsets. Re-seeding is idempotent (DROP/CREATE), the same as lean. [DECISION]

| Table | Rows at seed | Definition | Label |
| --- | ---: | --- | --- |
| `users` | **1,000** | `user<N>` / `user<N>@example.test`; bio 100 characters; image a fixed URL string; `password_hash` = one fixed bcrypt cost-10 hash of the public benchmark password `cwm-bench-password`, identical for all users (so every login does equal work) | [DECISION] |
| `tags` | **50** | `tag01` … `tag50` | [DECISION] |
| `articles` | **10,000** | slug `article-<N>`; title 60 characters; description 200 characters; body 1,000 characters; author `((N − 1) mod 1,000) + 1`; `favorites_count = (N × 13) mod 100`; `created_at` = epoch + N minutes | [DECISION] |
| `article_tags` | **30,000** | 3 distinct tags per article, from a fixed formula of N | [DECISION] |
| `comments` | **50,000** | 5 per article, `article_id = ((N − 1) mod 10,000) + 1`; body 200 characters; author `((N × 7) mod 1,000) + 1`; indexed on `(article_id, id)` | [DECISION] |
| `follows` | **10,000** | each user follows 10 others, from a fixed formula | [DECISION] |

Text fields are fixed filler strings cut to the stated lengths. JSON serialization cost depends on length, not content. [ASSUMPTION]

Memory fit [DERIVED, estimate]: articles about 1.3 KB × 10,000 is about 13 MB. Comments about 0.2 KB × 50,000 is about 10 MB, growing to about 23 MB after campaign inserts (section 7.3). Everything else is under 1 MB. With indexes, the total is well under 200 MB. db.r5.large has 16 GiB RAM [FACT: live accuracy API]. The RDS MySQL default InnoDB buffer pool is 3/4 of instance-class memory [ASSUMPTION: AWS default parameter, not verified on the instance]. The dataset fits in memory, so the numbers above needed no adjustment.

## 6. Load ladder and protocol

Protocol is the same as lean: **5 min ramping warmup, then 15 min constant-arrival steady**, k6 open model [FACT: load/lib/common.js, README.md]. RPS below is **total through the ALB**, split across 2 servers.

| Scenario key | Total RPS | Per server r | Split | Required |
| --- | ---: | ---: | --- | --- |
| `typical-fit-20` | 20 | 10 | fit | yes |
| `typical-fit-100` | 100 | 50 (the documentation point) | fit | yes |
| `typical-fit-200` | 200 | 100 | fit | yes |
| `typical-holdout-300` | 300 | 150 | holdout | yes |
| `typical-saturation-500` | 500 | 250 | holdout (diagnostic) | **optional** |

- Run order is ascending, in one apply, one campaign. The optional saturation rung runs last so that a failure there cannot affect the required rungs. [DECISION]
- If generator CPU exceeds about 70% in the steady window, the run is discarded and re-run. This is the existing lean rule [FACT: README.md].

## 7. Metrics recorded (same collector as lean)

### 7.1 Primary (per rung, from the existing `collect`)
[FACT: scripts/README.md]
- App CPU per host and the mean of the 2 hosts (CloudWatch).
- DB CPU and DatabaseConnections avg/max.
- k6 P50 / P95 / P99 over all requests.
- ALB TargetResponseTime p50 / p95 / p99.
- Goodput, and error rate by class.
- RDS and app EBS BurstBalance minimum.
- Generator CPU.

### 7.2 Secondary (reporting only)
- Per-endpoint k6 latency percentiles. If they are exposed through k6 threshold submetrics, the thresholds must be always-true expressions and are **not targets**.
- Bytes received per request (k6 `data_received` ÷ `http_reqs`).
- `/api/meta` on each host, recording `profile`, `workers`, pool per worker and git SHA.

### 7.3 Known dataset drift
Comment inserts grow the `comments` table during the campaign. Estimate of rows written [DERIVED]: 10% of requests over about 1,050 s of equivalent full-rate time per rung (900 s steady plus about 150 s from the linear 300 s ramp).

| Rung (total RPS) | Rows written |
| ---: | ---: |
| 20 | about 2,100 |
| 100 | about 10,500 |
| 200 | about 21,000 |
| 300 | about 31,500 |
| 500 (optional) | about 52,500 |

That is about 65,100 rows across the required rungs, taking `comments` from 50,000 to about 115,100. Reads are bounded (5 oldest comments), so read payloads stay constant. Insert and index cost may drift slightly upward. This is disclosed as a known effect; there is no re-seed between rungs [DECISION, to save runner time].

## 8. Known gaps (disclosed up front)

- **No later-day and no second-region typical repeats.** Lean's later-day and us-west-2 deltas at 100 RPS were small: app CPU −0.22 / −0.33 points, P99 +0.86 / +1.79 ms [FACT: holdout/REPORT.md]. We do **not** assume the same holds for typical.
- **One repetition per rung.** Variance is not estimated.
- **One reference workload.** "Typical" here means *this documented workload*, not "the average customer app".
- **Other process models are not measured.** `bcryptjs` on the event loop (section 4.2); a single-process variant is not measured.
- **Dataset drift** from comment inserts (section 7.3).
- **Cost** is list price, not a bill (as on the accuracy page [FACT: live accuracy API]).

## 9. Analysis plan (fixed now)

Notation: `CPU` = mean app-host CPU % over the run window that `collect` reports (the same definition the accuracy page scores [FACT: live accuracy API `cpuBasis`]). `r` = target total RPS ÷ 2. `v = 2`, so `2 / v = 1`.

### 9.1 Measured k per rung (primary)

`k_measured = (CPU − 0.22333) / (0.033548 × r)`

This inverts the engine formula `CPU = (0.22333 + k × 0.033548 × r) × 2 / v` [FACT: engine 1.2.3 formula supplied by Kevin]. Report `k_measured` for every rung, alongside the engine's `k = 11.79`. As a secondary, also report k computed from steady-window measured per-server RPS, if available.

Documentation band check, at the `typical-fit-100` rung (r = 50):
- Is measured CPU inside **10–40%**?
- Equivalently [DERIVED], is `k_measured` inside **5.83–23.71**, where 5.83 = (10 − 0.22333) / 1.6774 and 23.71 = (40 − 0.22333) / 1.6774?
- The doc point estimate of 20% corresponds to k = 11.79.

Outcomes, pre-declared:
- **Inside the band.** The doc figure is corroborated by an independent measured workload. Report the implied k and its distance from 11.79.
- **Outside the band.** Report the miss as-is. Whether the engine's typical default changes is a separate decision, made under the repo's rule "no coefficient change without a new measurement id" [FACT: holdout/REPORT.md].

Linearity: fit the 3 fit rungs with the repo's existing per-metric OLS form `intercept + slope × target_rps` [FACT: calibrate/README.md]. Report the slope, intercept and residuals, and the implied k from the slope (`slope × 2 / 0.033548`).

### 9.2 Engine predictions to compare against

- **CPU, frozen now** [DERIVED from the formula at k = 11.79, v = 2]:

  | Total RPS | Predicted app CPU |
  | ---: | ---: |
  | 20 | 4.1786% |
  | 100 | 19.9999% |
  | 200 | 39.7764% |
  | 300 | 59.5530% |
  | 500 | 99.1061% |

  Cross-check: this formula at k = 1 gives 1.9007% at 100 total RPS, which matches the live page's simulated lean CPU of 1.901 [FACT: live accuracy API].
- **Latency (P50/P95), throughput, error rate, cost.** Generate with CWM engine 1.2.3, app weight `typical`, seed 20240601 (the page's seed [FACT: live accuracy API]), canonical AWS topology, at 20 / 100 / 200 / 300 / 500 total RPS. Commit them as `typical/PREDICTIONS.md` **before the campaign apply**. **[Kevin action]** If they are generated after measurement, the report must label them "post-measurement predictions".

### 9.3 Latency vs load
- Report P50 / P95 / P99 at each rung, and whether each is monotonic non-decreasing with RPS. This directly tests the known engine issue that typical latency falls as load rises.
- Compare against the committed engine predictions.

### 9.4 Holdout scoring (same method as the accuracy page)
For `typical-holdout-300` (and the optional 500), score each metric the way the live page does [FACT: live accuracy API `metrics[]`]: `deltaPct = |simulated − reference| / |reference| × 100` and `accuracyPct = 100 − deltaPct`. Example: normal P50 simulated 2.4 vs reference 2.1882 gives deltaPct 9.7 and accuracyPct 90.3.

| Metric | Scored on the page? | Notes |
| --- | --- | --- |
| P50, P95 | yes | |
| App CPU | yes | |
| Throughput (goodput) | yes | |
| Error rate | yes | Tolerance 0.01 percentage points, with the page's `max_inverse_tolerance_or_relative_accuracy` rule outside tolerance [FACT: live accuracy API `errorRateScoring`]. The exact formula is not public in the API response, so use the page's own implementation. |
| Cost/hour | yes | |
| P99 | no | Reported, but unscored on the page [FACT: `simulatedP99Ms` shown separately]. |

- A floor of 0 for `accuracyPct` is an [ASSUMPTION] to confirm against the page code.
- The fit rungs get the same table, labeled "fit".
- **No composite score** is optimized or used as a pass/fail criterion. The page may display one; it has no bearing on the result [FACT: CONTRIBUTING.md rule 1].

### 9.5 Saturation (optional rung only)
Report goodput, error rate by class, CPU per host, and P99. Say plainly whether CPU plateaued below 100% and at what level. Error classes are reported as collected; "unclassified" is not reinterpreted.

## 10. Publish-regardless commitment

The results of every required rung are published in cwm-bench, **whatever they show**, as `holdout/exports/<campaign>.summary.md` and `typical/REPORT.md`. That includes a miss against the doc band, non-monotonic latency, errors, or a failed or discarded run (with its reason). Nothing is dropped, re-run to get a different number, or retuned. Re-runs are allowed only under the existing generator-CPU discard rule or for a documented infrastructure failure (for example SSM loss, or a collect marked incomplete), and every attempt is listed.

## 11. Change control

- **Before freeze:** edits to this file are normal PR edits.
- **After freeze:** any change to sections 3–9 means a new version (`typical-v2`), a new measurement SHA and a new campaign. The report lists what changed and why.
- The lean workload (`app/src/server.js`, `app/seed/seed.sql`, `load/scenarios.js`, `load/diagnostics.js`, lean scenario keys, and Terraform defaults) must keep reproducing the lean campaign unchanged.

## 12. Amendment: day and region holdouts for the fitted typical-v1 reference

Status: amendment to the gap disclosed in section 8. Section 8 is unchanged. This section does not change the typical app, request mix, seed, fit ladder, coefficients, or calibration id. It is not a new fit and not `typical-v2`. The worker adapter that accepts these keys reports `adapterVersion` `1.4.0`. The `typical-v1-20260927c` artifacts stay at `1.3.0`, the version that campaign ran.

### 12.1 Purpose

Validate day-stability and region-stability of the already-fitted `typical-v1-20260927c` reference at 100 total RPS and at 300 total RPS. The fit UTC date of that campaign is 2026-09-27 [FACT: campaign id `typical-v1-20260927c`; collect and run JSON under `typical/campaign/typical-v1-20260927c/` record `calendarDateUtc` `2026-09-27`].

Passing at 100 RPS establishes repeatability at 100 RPS only. Passing at 300 RPS tests whether the published after-fit holdout score at 300 RPS holds on a later day and in a second region. That published score is **84.2** on the page cost basis and **82.4** without cost [FACT: `typical/REPORT.md`; `typical/scores-after-fit.json` `300_pageCostBasis`]. The connector-cost total in the same file is **74.8**.

### 12.2 Keys

Each apply runs both rates, 100 then 300, on one stack, then destroys. Protocol is the existing 5 min warmup, then 15 min steady [FACT: section 6]. The `load/typical.js` mix is unchanged. Expected profile `typical`, 2 workers, pool 250. Topology matches section 3 (2 × m5.large, db.r5.large, internal ALB, c6i.xlarge generator).

| Scenario key | Region | Total RPS | What changes vs the same-rate typical-v1 key |
| --- | --- | ---: | --- |
| `typical-later-day` | **us-east-2** | 100 | UTC calendar day strictly after 2026-09-27. Set `CWM_FIT_CAMPAIGN_DATE=2026-09-27` (adapter state is accepted too). Compare with `typical-fit-100`. |
| `typical-later-day-300` | **us-east-2** | 300 | Same day constraint and the same apply as `typical-later-day`. Compare with `typical-holdout-300`. |
| `typical-second-region` | **us-west-2** | 100 | Region only. Separate apply. Compare with `typical-fit-100`. |
| `typical-second-region-300` | **us-west-2** | 300 | Same region and the same apply as `typical-second-region`. Compare with `typical-holdout-300`. |

Lean `later-day` and `second-region` stay on the lean script and the lean profile. A typical stack rejects them with `PROFILE_MISMATCH`. Running those lean keys is not this measurement.

`typical-later-day` and `typical-later-day-300` in any region other than us-east-2 fail with `TYPICAL_REGION_CONSTRAINT`. `typical-second-region` and `typical-second-region-300` outside us-west-2 fail with `SECOND_REGION_CONSTRAINT`. Every other `typical-*` key, including `typical-holdout-300`, still rejects us-west-2.

### 12.3 Attempts

Suggested ids: parent `typical-holdouts-v1-YYYYMMDD`; separate applies `typical-later-day-YYYYMMDD` (both later-day keys) and `typical-second-region-YYYYMMDD` (both second-region keys). One attempt per key. Rerun only when generator CPU in the steady window exceeds about 70% [FACT: README.md and section 6] or for a documented infrastructure failure. Keep every attempt [FACT: section 10].

### 12.4 Comparison, fixed before the runs

Do not refit. Report each rate on its own. A pass at one rate is not a pass at the other.

**100 RPS** (`typical-later-day`, `typical-second-region`). Primary: measured value minus the measured `typical-fit-100` row from `typical-v1-20260927c` in `holdout/exports/typical-v1-20260927c.summary.md` (goodput 87.62279003099846, p50 4.684795, p95 8.354502, p99 83.1684065, app CPU 5.238137291849269, db CPU 11.492307692307692). Secondary: score the way section 9.4 scores a holdout, against the after-fit predictions at 100 RPS in `typical/scores-after-fit.json` (`100.pred`: cpu 5.215, p50 4.879573, p95 9.234496, p99 81.72693, thr 87.619644, err 0, cost 0.6). Report the page score with cost and without cost. The fit-rung scores already in that file at 100 RPS are total 93.3 and noCost 96.1. Those numbers are the fit rung, not a prediction of this holdout score. Passing here establishes repeatability at 100 RPS only.

**300 RPS** (`typical-later-day-300`, `typical-second-region-300`). Primary: measured value minus the measured `typical-holdout-300` row from that same export (goodput 262.60872607647724, p50 4.621661, p95 26.917676599999997, p99 97.54310300000054, app CPU 15.303205128205128, db CPU 26.709615384615383). Secondary: score the same way against the after-fit predictions at 300 RPS in `typical/scores-after-fit.json` (`300.pred`: cpu 14.74, p50 4.1652207, p95 12.783974, p99 92.47731, thr 262.604, err 0, cost 0.88). Report the page score with cost and without cost. The published after-fit scores for this reference are 84.2 on the page cost basis and 82.4 without cost (`300_pageCostBasis`; `typical/REPORT.md`). The connector-cost total in the same file is 74.8. Say which basis is used. Passing here tests whether that 84.2 / 82.4 score holds on a later UTC day and in us-west-2.

### 12.5 Out of scope

- Changing the app-server count (section 3 stays at 2). A 1-server or 3-server run is a different topology.
- Burst, the 1000 RPS diagnostics, and `typical-saturation-500`.
- Any coefficient change, calibration-id change, or retune.
- Assuming the lean later-day / us-west-2 deltas transfer. Those deltas at 100 RPS were app CPU −0.22 / −0.33 points and P99 +0.86 / +1.79 ms [FACT: section 8, holdout/REPORT.md]. They are context only.
- The known P95 miss at 300 RPS (predicted 12.78 ms, measured 26.92 ms, score 47.5 [FACT: `typical/REPORT.md`]). A later-day or second-region result at 300 RPS does not resolve it.
- The 500 RPS false-saturation gap. On engine 1.2.5 the owned fit does not apply above 300 RPS: predicted 99.107% CPU and 9.954% errors against measured 26.34% CPU and 0.0103% errors, scored 25.6, or 28.5 without cost [FACT: `typical/REPORT.md`]. That stays out of scope for a later `typical-v2` densification.

## 13. Pointer: app-server count campaign

Changing the app-server count is a different topology (section 12.5). That campaign is `typical/scale-v1/PREREGISTRATION.md` (`typical-scale-v1`). Sections 3–9 and 12 of this file are unchanged.

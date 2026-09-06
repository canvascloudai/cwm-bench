# Holdout report

**Status: v1 owned campaign present. Per-metric OLS fitted on idle/normal/peak.**

Export campaign `473f1339-f712-4096-96d6-3d4fc07cb427` (`cwm-bench-campaign` schemaVersion 1.0.0) completed on `2026-09-06T03:44:51.130Z` with `ownedMeasurement: true` and `cleanupStatus: confirmed`. Adapter `1.2.5`. Every run below is `complete: true`, `knownGap: false`, `invented: false`. Cost is null in the export.

Fit split (trusted, designation `fit`): idle, normal, peak. Holdouts (trusted false by design, valid true): burst, pool-bound, app-bound, cpu-only, later-day, second-region.

`calibrate/coefficients.yaml` is a **per-metric OLS fit** of those three rungs. `measurement_sha` is `7416cb63ace3a7ab2e3486bb6f132a2dcb574c34` (same campaign; first fit of these measurements). Each metric is `affine_in_target_rps`: `intercept + slope * target_rps`. Loss is the per-metric sum of squared residuals. There is no composite score. Holdouts were not in the fit; `holdout_deltas.*.fit_prediction` and `delta` (`measured − prediction`) are reported after the fit.

A later coefficients change is allowed only when all of the following are true:

1. `calibrate/coefficients.yaml` carries a new `measurement_sha` (new measurements, not a retune to raise a score).
2. `fit_split` is declared and **Burst was not in the fit set**.
3. This report's holdout-delta tables stay populated from schema-valid holdout runs.
4. CI `--check-provenance` passes.

Otherwise the change is rejected. The accuracy page does not get a vote.

Topology of this campaign: **2 × m5.large** + **db.r5.large** MySQL 8.0, internal ALB. Primary region **us-east-2** (not the documented us-east-1 pin). Second-region holdout **us-west-2**.

goodput / target ≈ **0.875** on successful rungs is the **5m warmup + 15m steady** window average (`(0.5×5 + 15) / 20`), not a steady-state undershoot.

The public CWM Burst cell (reference error 2.00% vs simulated 9.55%, throughput 980 vs 905, as of 2026-08-29) is **not** copied here and is **not** owned data.

---

## Burst holdout

Canonical 1000 RPS rung plus the three diagnostics. Burst must not appear in `fit_split`.

Merged export run ids use `473f1339-f712-4096-96d6-3d4fc07cb427:<scenario>`. Fit/CRUD-Burst/pool-bound/app-bound originated in `165c494e-2fa8-4d9a-addd-ddd5f94cdcde` at `7416cb63ace3a7ab2e3486bb6f132a2dcb574c34`. cpu-only originated in `1c120d29-67a5-441c-8760-b16839a5f073` (origin run `83320489-4325-44a1-8a75-9a5acfb6e1f1`) at `1fdfe97572ef91a270c9d39142fb28f7a10061eb`.

| campaign_id | run_id | diagnostic | goodput RPS | error % | dominant class | BurstBalance min (RDS) | BurstBalance min (app EBS) | notes |
| --- | --- | --- | ---: | ---: | --- | ---: | --- | --- |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:burst | canonical | 875.1162528375527 | ≈ 0 (`fail_rate` 9.522521716110773e-07) | unclassified (1) | 99 | not in export | pool 250; 2026-09-05T17:35:55–17:50:55Z; origin `165c494e…:burst` |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:pool-bound | pool-bound | ~875.12 | 0 | none | never 0 | not in export | pool 250; 17:57:28–18:12:28Z; origin campaign `165c494e` |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:app-bound | app-bound | ~875.12 | 0 | none | never 0 | not in export | pool 40; 18:20:51–18:35:51Z; origin campaign `165c494e` |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:cpu-only | cpu-only | 176.92973011451465 | 79.78069486304142 | unclassified (837805) | never 0 | not in export | `/api/cpu-spin`; 20:01:34–20:16:34Z; origin run `83320489-4325-44a1-8a75-9a5acfb6e1f1`; `errorClassEvidence` unclassified-http-failures |

Canonical / pool-bound / app-bound Burst-class CRUD runs are ≈ **0% errors** on this workload. That is not the public 2% RDS connection-timeout literature cell and it is not 9.55%.

The three diagnostics **classify** saturation. They do not assert a root cause of that published gap.

---

## Later-day holdout

Same topology shape, later UTC day than the fit set (fit rungs on 2026-09-05; this run on 2026-09-06). Worker key `later-day` at 100 RPS. Origin campaign is this export (`473f1339…`); origin run `1259e7aa-65c7-4eda-8d42-ffd5ade498e8`. Region **us-east-2**.

`fit_prediction` and `delta` come from the idle/normal/peak OLS (`target_rps` 100). Exact floats are in `calibrate/coefficients.yaml`. Measured cells are the published export values (not invented).

| campaign_id | run_id | date (UTC) | scenario | metric | fit prediction | held-out measured | delta | notes |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:later-day | 2026-09-06 | later-day | goodput | 87.6242661085967 | ~87.62 | -0.004266108596695517 | target 100; 00:32:08–00:47:08Z; errs 0 |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:later-day | 2026-09-06 | later-day | p50 | 2.3786839660705539 | ~2.31 | -0.068683966070553826 | ms |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:later-day | 2026-09-06 | later-day | p95 | 4.2400055191450274 | ~4.27 | 0.029994480854972139 | ms |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:later-day | 2026-09-06 | later-day | p99 | 7.0489330189612955 | ~7.91 | 0.8610669810387046 | ms |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:later-day | 2026-09-06 | later-day | app_cpu_avg | 1.9007264424312253 | ~1.68 | -0.22072644243122541 | % |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:later-day | 2026-09-06 | later-day | db_cpu | 4.3164102084054212 | ~5.16 | 0.84358979159457892 | % |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:later-day | 2026-09-06 | later-day | error_rate | 0 | 0 | 0 | fit rungs were all zero |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:later-day | 2026-09-06 | later-day | db_conn_max | 8.9002939735423805 | 10 | 1.0997060264576195 | |

---

## Second-region holdout

Same topology shape in **us-west-2**. Worker key `second-region` at 100 RPS. Origin run `ea6a3a45-1f2e-4f7e-810e-764f922935a5`. This apply is a holdout, not a silent default change.

`fit_prediction` and `delta` come from the same idle/normal/peak OLS (`target_rps` 100). Exact floats are in `calibrate/coefficients.yaml`. Measured cells are the published export values (not invented).

| campaign_id | run_id | region | scenario | metric | fit prediction | held-out measured | delta | notes |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:second-region | us-west-2 | second-region | goodput | 87.6242661085967 | ~87.62 | -0.004266108596695517 | target 100; 2026-09-06T00:53:33–01:08:33Z; errs 0 |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:second-region | us-west-2 | second-region | p50 | 2.3786839660705539 | ~2.00 | -0.37868396607055388 | ms |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:second-region | us-west-2 | second-region | p95 | 4.2400055191450274 | ~3.84 | -0.40000551914502758 | ms |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:second-region | us-west-2 | second-region | p99 | 7.0489330189612955 | ~8.84 | 1.7910669810387043 | ms |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:second-region | us-west-2 | second-region | app_cpu_avg | 1.9007264424312253 | ~1.57 | -0.33072644243122529 | % |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:second-region | us-west-2 | second-region | db_cpu | 4.3164102084054212 | ~4.63 | 0.31358979159457867 | % |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:second-region | us-west-2 | second-region | error_rate | 0 | 0 | 0 | fit rungs were all zero |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:second-region | us-west-2 | second-region | db_conn_max | 8.9002939735423805 | 8 | -0.9002939735423805 | |

---

## CPU-vs-DB split

Compare the four 1000 RPS shapes from the owned export.

| shape | APP_POOL_SIZE | path | app CPU | RDS CPU | RDS DatabaseConnections max | error classes (counts) | notes |
| --- | ---: | --- | ---: | ---: | ---: | --- | --- |
| canonical | 250 | 70/20/10 mix | ~13.36 | ~10.91 | 55 | unclassified 1; others 0 | fail_rate 9.522521716110773e-07; conn avg 54.61538461538461 below_cap |
| pool-bound | 250 | 70/20/10 mix | ~11.46 | ~9.90 | 56 | all 0 | p50 ~1.93; p95 ~3.72; p99 ~7.12 |
| app-bound | 40 | 70/20/10 mix | ~11.67 | ~9.83 | 43 | all 0 | p50 ~1.94; p95 ~3.73; p99 ~6.83 |
| cpu-only | n/a | `/api/cpu-spin` | ~51.38 | ~3.14 | 0 | unclassified 837805 | fail_rate 0.7978069486304142; db conn 0 |

### Verdict

Canonical, pool-bound, and app-bound Burst-class CRUD runs are ≈ **0% errors**. The public 2% RDS connection-timeout literature does **not** match this workload. Do **not** add a CPU-error term for CRUD Burst. cpu-only shows CPU **can** fail when forced (`/api/cpu-spin`, ~51% app CPU, ~80% fail, unclassified-http-failures). IOPS never hit BurstBalance 0.

How to read the classification (not a verdict on the public score):

- Errors on pool-bound and canonical, quiet on cpu-only → look at sessions / `max_connections` / `too_many_connections` / `db_timeout`.
- Errors on app-bound, quieter on pool-bound → look at `APP_POOL_SIZE` / `queue_full`.
- Errors on cpu-only → look at app CPU / `cpu_overload`.
- `BurstBalance` min = 0 on RDS or app volumes → **iops_throttle**, a third bucket. Do not fold it into the rows above.

This campaign's CRUD Burst-class rows are quiet. The cpu-only row is the CPU-failure cell. No IOPS-zero row.

---

## IOPS / BurstBalance bucket

gp2 BurstBalance hitting 0 is a **third** error bucket, distinct from CPU failures and DB connection failures.

| campaign_id | run_id | resource | BurstBalance min | coincident errors | labeled iops_throttle | folded into CPU or DB? |
| --- | --- | --- | --- | --- | --- | --- |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:burst | RDS gp2 | 99 (idle/normal/peak/burst reported 99; never 0 on any run) | none from IOPS | no | **no** |
| 473f1339-f712-4096-96d6-3d4fc07cb427 | 473f1339-f712-4096-96d6-3d4fc07cb427:burst | app root gp2 | not in export; never 0 | none from IOPS | no | **no** |

---

## Fit rungs (not holdout; recorded so the split is auditable)

| run_id | target | goodput | p50 | p95 | p99 | app CPUs | db CPU | db conn max | window (UTC) |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | --- |
| 473f1339-f712-4096-96d6-3d4fc07cb427:idle | 10 | 8.874155959479843 | 2.62841 | 4.529567800000001 | 7.238151520000008 | 0.51602637839263 / 0.441025641025641 | 3.337818548370722 | 2 | 2026-09-05T16:32:30.342Z–16:47:30.342Z |
| 473f1339-f712-4096-96d6-3d4fc07cb427:normal | 100 | 87.62477401512365 | 2.1881595 | 4.0283214 | 6.787357539999996 | 2.059615384615385 / 1.5275641025641027 | 4.433338557944269 | 8 | 16:53:31–17:08:31Z |
| 473f1339-f712-4096-96d6-3d4fc07cb427:peak | 500 | 437.62281962650434 | 1.99503 | 3.7599577499999994 | 7.205033059999991 | app_cpu_avg ~8.63 | ~8.22 | 43 | 17:14:51–17:29:51Z |

Idle/normal/peak: BurstBalance RDS 99, errs 0, fail_rate 0, pool 250, us-east-2. Generator CPU idle 0.5647435897435897 / normal 2.3680769230769227. These run ids are the only `fit_split.run_ids`.

---

## Pass / fail for a coefficients PR

| Check | This fitted PR | Later change |
| --- | --- | --- |
| `measurement_sha` | present (`7416cb63ace3a7ab2e3486bb6f132a2dcb574c34`; first fit of this campaign) | new SHA required if measurements change |
| Burst in `fit_split` | **pass** (idle / normal / peak only) | **fail** if present |
| Holdout deltas reported (this file + `coefficients.yaml`) | measured + `fit_prediction` + `delta` | required |
| `metrics.*` fitted | per-metric OLS `affine_in_target_rps` | per-metric only |
| Composite accuracy score optimized or cited as the loss | **fail** | **fail** |
| Public 2% / 9.55% Burst cell copied as owned | **fail** (not copied) | **fail** |
| Invented CloudWatch or customers | **fail** | **fail** |

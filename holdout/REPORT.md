# Holdout report

**Status: awaiting v1 campaign.** Every table below is empty on purpose. Do not fill these cells with CWM public figures, AWS documentation citations, or invented CloudWatch.

A coefficient change is allowed only when all of the following are true:

1. `calibrate/coefficients.yaml` carries a new `measurement_sha`.
2. `fit_split` is declared and **Burst was not in the fit set**.
3. This report's holdout-delta tables are populated from schema-valid runs (`split=holdout`).
4. CI `--check-provenance` passes.

Otherwise the change is rejected. The accuracy page does not get a vote.

Until v1 measurements exist: keep the Burst error visible as a known gap, or leave the floor failing. Do not label latency / CPU / throughput / error as "measured".

---

## Burst holdout

Canonical 1000 RPS rung plus the three diagnostics. Burst must not appear in `fit_split`.

| campaign_id | run_id | diagnostic | goodput RPS | error % | dominant class | BurstBalance min (RDS) | BurstBalance min (app EBS) | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| awaiting v1 campaign | — | canonical | — | — | — | — | — | — |
| awaiting v1 campaign | — | pool-bound | — | — | — | — | — | — |
| awaiting v1 campaign | — | app-bound | — | — | — | — | — | — |
| awaiting v1 campaign | — | cpu-only | — | — | — | — | — | — |

The public CWM Burst cell (reference error 2.00% vs simulated 9.55%, throughput 980 vs 905, as of 2026-08-29) is **not** copied here. Those numbers are not a company-owned measurement. The 2% reference is cited as RDS connection timeout (~500 max connections) from AWS documentation. This table is where an owned measurement will land.

The three diagnostics **classify** saturation. They do not assert a root cause of that published gap.

---

## Later-day holdout

Same topology, same git SHA if possible, a later UTC day than the fit set.

The worker adapter scenario key is `later-day` (`SCENARIO=later-day` at 100 RPS). It is not a rename of `normal` and it will not run on the same UTC day as the fit campaign. This table stays empty until a real later-day run exists.

| campaign_id | run_id | date (UTC) | scenario | metric | fit prediction | held-out measured | delta | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| awaiting v1 campaign | — | — | — | — | — | — | — | — |

---

## Second-region holdout

Same topology shape in **us-west-2**. That apply is a holdout, not a silent default change.

The worker adapter scenario key is `second-region` (`SCENARIO=second-region` at 100 RPS). It is not a rename of the us-east-1 run and it will not execute against a primary-region apply. This table stays empty until a real second-region run exists.

| campaign_id | run_id | region | scenario | metric | fit prediction | held-out measured | delta | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| awaiting v1 campaign | — | — | — | — | — | — | — | — |

---

## CPU-vs-DB split

Compare the four 1000 RPS shapes. Empty until v1.

| shape | APP_POOL_SIZE | path | app CPU | RDS CPU | RDS DatabaseConnections max | error classes (counts) | awaiting |
| --- | --- | --- | --- | --- | --- | --- | --- |
| canonical | 250 | 70/20/10 mix | — | — | — | — | v1 campaign |
| pool-bound | 250 | 70/20/10 mix | — | — | — | — | v1 campaign |
| app-bound | 40 | 70/20/10 mix | — | — | — | — | v1 campaign |
| cpu-only | n/a | `/api/cpu-spin` | — | — | — | — | v1 campaign |

How to read a future filled table (classification, not a verdict on the public score):

- Errors on pool-bound and canonical, quiet on cpu-only → look at sessions / `max_connections` / `too_many_connections` / `db_timeout`.
- Errors on app-bound, quieter on pool-bound → look at `APP_POOL_SIZE` / `queue_full`.
- Errors on cpu-only → look at app CPU / `cpu_overload`.
- `BurstBalance` min = 0 on RDS or app volumes → **iops_throttle**, a third bucket. Do not fold it into the rows above.

---

## IOPS / BurstBalance bucket

gp2 BurstBalance hitting 0 is a **third** error bucket, distinct from CPU failures and DB connection failures.

| campaign_id | run_id | resource | BurstBalance min | coincident errors | labeled iops_throttle | folded into CPU or DB? |
| --- | --- | --- | --- | --- | --- | --- |
| awaiting v1 campaign | — | RDS gp2 | — | — | — | must be **no** |
| awaiting v1 campaign | — | app root gp2 | — | — | — | must be **no** |

---

## Pass / fail for a coefficients PR

| Check | Pass |
| --- | --- |
| New `measurement_sha` | required |
| Burst in `fit_split` | **fail** |
| Holdout deltas reported (this file + `coefficients.yaml`) | required |
| Composite accuracy score optimized or cited as the loss | **fail** |
| Latency / CPU / throughput / error labeled "measured" before v1 | **fail** |
| Invented CloudWatch or customers | **fail** |

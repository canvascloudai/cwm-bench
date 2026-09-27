# cwm-bench typical campaign: CWM engine predictions (pre-measurement)

Generated **2026-09-27, 09:57:15 to 09:58:53 ET** (13:57:15 to 13:58:53 UTC). This is before any typical AWS run: none has been started, and PR #11 (commit `f107b65`) is unmerged.

- Source: authenticated `user-cwm` MCP connector, tools `simulation.create` then one `simulation.step` per rung.
- Every value below is copied from the engine response, not computed, except where a row is marked **[DERIVED]**.
- All simulations were deleted afterwards (section 5).

## 1. Engine and request parameters

| Item | Value (as returned or as sent) |
| --- | --- |
| `engineVersion` (returned) | `1.2.3` |
| `seed` (sent, echoed back) | `20240601`; `rngAlgorithm` returned `mulberry32` |
| `appWeight` (sent) | `typical`; `appWeightDefaulted` returned `false` |
| Topology (sent) | `alb` (network, `serviceFamily: alb`, name "ALB (Application Load Balancer)"); `app-1`, `app-2` (compute, `size: m5.large`, `serviceFamily: ec2`, `autoscaling: false`); `db` (database, `size: db.r5.large`, `serviceFamily: rds`, `workloadDatabaseEngine: mysql`, `maxConnections: 500`) |
| Connections (sent) | alb to app-1, alb to app-2, app-1 to db, app-2 to db |
| Fleet bounds (sent) | `minInstances: 2`, `maxInstances: 2` |
| `traffic` (sent) | 20 / 100 / 200 / 300 / 500 total RPS, one simulation per rung |
| Region | **The create API has no region input**, so us-east-2 could not be set. The engine reported `rateProvenance.region: us-east-1` with `resolvedHourlyRate` 0.096 (m5.large) and 0.24 (db.r5.large). Those are the same rates the accuracy page cites for us-east-2. |
| Steps | Create applies a 5-step warm-up (`creationPolicy.warmup.steps: 5`). Values below are from the first explicit step (`currentStep: 6`). |
| `scenarioHash` (same for all rungs) | `61714b2410d3c64bc2d60d078442729d35288a0f0f460d65984c4d5f70fd3901` |
| `calibrationEvidence.kind` | `modeled`. Note: "AWS owned CRUD fit not applied: appWeight: expected lean, actual typical" |
| `latencyP99Basis` | "uncalibrated (generic P99, no owned in-VPC fit)" |
| `predictionEvidence.sourceIds` | includes `cwm-industry-guidance-placeholder-v1` and `cwm-generic-p99-unverified` |

## 2. Predictions per rung (step 6, as returned)

| Rung | Sim id | App CPU % (each host) | P50 ms | P95 ms | P99 ms | throughput / goodputRps | errorRate (as returned) | costPerHour | DB CPU % |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `typical-fit-20` (20 RPS) | `6cbf24c5-884f-4041-80af-1e46644c573a` | 4.179 | 19 | 46 | 117 | 20 | 0.124 | 0.49 | 1 |
| `typical-fit-100` (100 RPS) | `880239b3-6334-4a1c-a6f3-7b774c0033f8` | 20 | 18 | 45 | 148 | 100 | 0.2 | 0.62 | 1 |
| `typical-fit-200` (200 RPS) | `b4e17900-16f3-40f5-accf-70b8d1ac8cd1` | 39.777 | 18 | 44 | 190 | 200 | 0.247 | 0.78 | 3.7 |
| `typical-holdout-300` (300 RPS) | `9af325af-b8a8-4c1c-9e09-3bb67779ba50` | 59.553 | 17 | 42 | 236 | 299 | 0.284 | 0.94 | 7.1 |
| `typical-saturation-500` (500 RPS, optional) | `a7711d34-04ba-4ee5-94ea-f9922e587411` | 99.107 (status `critical`, `degraded`) | 15 | 39 | 341 | 450 | 9.954 | 1.18 | 14.3 |

Notes on how to read the table:
- **errorRate:** the response does not state a unit. The accuracy page labels its error metric `errorRatePct`. `errorBreakdown` attributed the error to `poolSaturation`: 0.12, 0.2, 0.25 and 0.28 on the four required rungs. On the 500 RPS rung it was `cpuOverload` 9.55 plus `poolSaturation` 0.4.
- **Throughput:** `goodputSemantics` is `post_step_point_rate`, and `goodputWindow` returned `unavailable`. This is **not** the whole-run (warm-up plus steady) goodput the accuracy page scores. For lean, the page shows simulated throughput 87.62 at 100 RPS.
- **Cost:** `costPerHour` includes an "Egress & Data Transfer" line that grows with traffic. At 20 RPS it was 0.0324, next to ALB 0.0225, 2 × 0.096 and 0.24. The page's lean reference cost is the $0.4545 list price with no egress, and its lean simulated cost is 0.458049 [FACT: live accuracy API].
- **P99:** uncalibrated (see section 1).
- **Assumption ranges:** `predictionEvidence` also returned low/central/high ranges. They are assumption intervals, not confidence intervals.

  | Rung | App CPU low–high | P50 low–high | P95 low–high | P99 low–high |
  | --- | --- | --- | --- | --- |
  | 20 | 2.0895–8.358 | 9.5–38 | 23–92 | 58.5–234 |
  | 100 | 10–40 | 9–36 | 22.5–90 | 74–296 |
  | 200 | 19.8885–79.554 | 9–36 | 22–88 | 95–380 |
  | 300 | 29.7765–100 | 8.5–34 | 21–84 | 118–472 |
  | 500 | 49.5535–100 | 7.5–30 | 19.5–78 | 170.5–682 |

## 3. Check against the pre-registration's frozen CPU values

| Total RPS | Pre-registration (formula, section 9.2) | Engine `cpuPercent` | Match |
| ---: | ---: | ---: | --- |
| 20 | 4.1786 | 4.179 | yes (engine rounds to 3 decimals) |
| 100 | 19.9999 | 20 | yes (rounding) |
| 200 | 39.7764 | 39.777 | yes (rounding) |
| 300 | 59.5530 | 59.553 | yes |
| 500 | 99.1061 | 99.107 | yes (rounding) |

Every rung agrees within 0.001 percentage points. The differences are rounding only, so there is no mismatch.

## 4. Observations recorded before measurement (not results)

- **Typical latency falls as load rises** in the engine's own output: P50 19, 18, 18, 17, 15 and P95 46, 45, 44, 42, 39 from 20 to 500 RPS. This is the known issue. The campaign's latency-vs-load analysis (pre-registration section 9.3) tests it directly.
- **Non-zero error rate at low load:** the engine predicts pool-saturation error at every rung, including 20 RPS, where `connectionPressure` was 0.008.
- **[DERIVED], illustration only:** if the campaign measures 0% error, the page's hybrid error rule would score these rungs about 8.1 / 5.0 / 4.0 / 3.5. That is `max(100 × 0.01 / |sim − ref|, relative accuracy)`, and relative accuracy is 0 when the reference is 0.
- **Scoring comparability gaps to settle before the holdout is scored:**
  - The throughput here is a point rate, while the page scores whole-run goodput.
  - The cost here includes modeled egress, while the page's reference is the list price without egress.
  - The engine was not told the region (no API field).

  The page's own prediction pipeline (`SimulationEngine.simulateStep`, "whole-run goodput and billed hourly cost") may transform these. The page, not these raw values, should produce the scored holdout comparison.

## 5. Cleanup

All five simulations above were deleted with `simulation.delete`. A following `simulation.list` returned none of them (none named `typical-prereg-*`). Other simulations already on the account were left untouched.

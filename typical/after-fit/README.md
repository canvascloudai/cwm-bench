# Provenance export: after-fit typical holdout (84.2), 2026-09-27

This folder freezes the inputs and outputs behind the after-fit score for the owned typical Node CRUD graph. Everything was produced through the `user-cwm` MCP connector on engine 1.2.5, 2026-09-27, about 23:25 to 23:45 ET.

## What is pinned

- Engine version: 1.2.5 (reported in every response).
- Calibration id: `aws-crud/typical:typical-v1-20260927c:6aa574d7ff9d3080b88b221bcd59f7d218ae37f0` (calibrationEvidence.kind "owned" at 20, 100, 200 and 300 RPS).
- Fit rungs: typical-fit-20, typical-fit-100, typical-fit-200 only. 300 RPS is the independent holdout. 500 RPS is diagnostic only.
- Seed: `seed: 20240601`, set explicitly in every create payload. simulation.create exposes a `seed` parameter.
- Graph: internal ALB, 2 x m5.large (serviceFamily ec2, crud-typical, node, 2 workers, pool 250, autoscaling off), db.r5.large (serviceFamily rds, MySQL 8.0, maxConnections 500). All four nodes use regionKey us-east-2. minInstances = maxInstances = 2.

## Determinism

- Two independent runs (A and B) per rung, same payload and seed. The saved metrics responses are identical in every field except the simulation id and metric ids. That includes the full 7-entry metrics history and the unscored ALB CPU.
- An extra 300 RPS run with seed 7 gave identical scored outputs. Only the unscored ALB CPU changed (3.3 vs 3.8). The seed only drives ALB CPU jitter. It has no effect on any scored metric.
- Result: deterministic. Variance across repeated runs is 0 for every scored metric.

## Files

| File | What it is |
|---|---|
| `create-payload-<RPS>.json` | Exact simulation.create arguments for 20/100/200/300/500. The `name` field used on each run is listed in call-log.json. It does not affect the prediction. |
| `call-log.json` | Every call in order with its arguments, simulation ids, engine version, calibration id, config hash and key outputs, for run A and run B. It also records the two extra checks (seed 7, and missing serviceFamily). |
| `raw/rung<RPS>-run<A|B>-metrics.json` | simulation.metrics responses, saved verbatim (compact mode). |
| `raw/rung300-run<A|B>-cost-breakdown.json` | simulation.cost_breakdown at 300 RPS (total 0.879919, egress 0.425419). |
| `measured-values.json` | Measured values used for scoring, taken from the cwm-bench campaign typical-v1-20260927c. |
| `cost-references.json` | Both cost bases: the 0.4545 USD/hour list-price reference with no egress, and the connector's 0.88 USD/hour, which includes modeled egress. |
| `score_export.py` | Scoring script. The rules are copied unchanged from `results-2026-09-27/score.py`. It reads only the files above. |
| `scores-reproduced.json` | Output of score_export.py. |

## How to reproduce

1. Scores from the frozen files: `python3 score_export.py`. It checks that runs A and B match, prints every rung, and exits 0 when the 300 RPS holdout gives:
   - 84.2 total with the cost prediction on the no-egress basis (0.4545 = 0.879919 minus 0.425419 egress);
   - 74.8 total with the connector's costPerHour of 0.88;
   - 82.4 without cost (the same on either basis).
2. New predictions: call `simulation.create` with `create-payload-<RPS>.json`, then `simulation.step {simulationId}` once (currentStep becomes 6), then `simulation.metrics {simulationId}`. Compare with the raw files. No `simulation.inject_traffic` calls are needed, because traffic is set at create.

## Per-metric scores at the 300 RPS holdout

P50 90.1, P95 47.5, app CPU 96.3, throughput 100.0, error rate 100.0. Cost is 100.0 on the no-egress basis and 6.4 on the connector basis. Before fit (engine 1.2.3) the holdout scored 24.3 (27.0 without cost).

## Caveats

- The accuracy page shows a cost prediction of 0.454581 USD/hour. The connector never returns that number: its breakdown without egress adds up to 0.4545. Both give a cost score of 100.0, so the 84.2 total is the same (BL-82).
- If `serviceFamily` ec2/rds is left out, the owned fit still applies and performance outputs are unchanged. But the database is then priced at 0.12 instead of 0.24 USD/hour, so costPerHour at 300 RPS is 0.76 instead of 0.88. The payloads pin serviceFamily for that reason.
- At 500 RPS the owned fit is not applied (gate is 20 to 300 RPS). The engine falls back to generic typical: 99.1% app CPU, critical, 9.954% errors. It still labels loadScope "within measured load" (BL-86).
- Throughput is compared with whole-run goodput (warmup plus steady); the prediction is a point rate. Measured cost is missing, and both cost values are references, not bills.
- No account ids, API keys or ARNs are included.

# typical-scale-v1 prediction freeze

**These predictions are FROZEN against engine 1.2.14 for typical-scale-v1.**

Score this campaign from `predictions.json` only. A later live-engine re-query is not a scored prediction.

- Freeze timestamp: **2026-10-06 12:41:17 EDT** (America/New_York)
- Protocol: create (traffic at create, seed 20240601) → one step (currentStep=6) → harvest → delete
- Topology: internal ALB, m5.large apps (1/2/3), pool 250/node, db.r5.large MySQL 8.0 single-AZ, us-east-2, typical-v1 workload
- CalibrationId: `aws-crud/typical:typical-v1-20260927c:6aa574d7ff9d3080b88b221bcd59f7d218ae37f0`
- Live engineVersion on every cell: **1.2.14**
- Kind: **owned** for all 2× cells; **owned-scaled** for all 1× and 3× cells. The MCP connector schema still only allows `owned|modeled`, so 1×/3× step/get bodies were recovered via `simulation.list` full + snapshot + `cost_breakdown`. Kind is the live field, proven by the MCP validation error text. `effectiveConfigHash` is therefore present for 2× and null for 1×/3× in this package.

## Summary verdicts

1. All-match vs Replit task #4870 scored table: **YES**
2. 2× vs typical-v1 after-fit call-log scored fields: **YES** (engine 1.2.5 → 1.2.14; no scored-field drift)
3. engineVersion=1.2.14 on all 9: **YES**; kinds owned (2×) / owned-scaled (1×/3×): **YES**
4. 2×-300 cost_breakdown sum = **0.879919** (displayed costPerHour 0.88): **YES**
5. errorRate = **0** on all 9 cells. Pool-capacity warnings are present on every 1× and 3× cell and do not add errors.

`predictions.json` is the canonical full-precision record. The table below is the freeze display. Throughput last digits that differ from the #4870 display were accepted as rounding (see the match notes in the freeze package). 1×-200 and 1×-300 are unvalidated extrapolations: the derived equivalent two-server fit load is 400 RPS and 600 RPS, past the 300 RPS independent holdout. P50 on those cells stays capped at its 300 RPS projection.

## 9-cell freeze table

| Cell | engine | kind | app CPU %/host | DB CPU % | P50 | P95 | P99 | thr | err | cost/hr (display) | cost Σ | step | #4870 |
|------|--------|------|----------------|----------|-----|-----|-----|-----|-----|-------------------|--------|------|-------|
| 1x-100 | 1.2.14 | owned-scaled | 9.978 | 11.4 | 4.522397 | 11.009235 | 87.102120 | 87.555916 | 0 | 0.5 | 0.500341 | 6 | MATCH |
| 1x-200 | 1.2.14 | owned-scaled | 19.502 | 18.6 | 4.165221 | 14.558712 | 97.852498 | 175.0481 | 0 | 0.64 | 0.642078 | 6 | MATCH |
| 1x-300 | 1.2.14 | owned-scaled | 29.027 | 25.8 | 4.165221 | 18.108190 | 108.602875 | 262.54028 | 0 | 0.78 | 0.783815 | 6 | MATCH |
| 2x-100 | 1.2.14 | owned | 5.215 | 11.4 | 4.879573 | 9.234496 | 81.726931 | 87.619644 | 0 | 0.6 | 0.596444 | 6 | MATCH |
| 2x-200 | 1.2.14 | owned | 9.978 | 18.6 | 4.522397 | 11.009235 | 87.102120 | 175.11183 | 0 | 0.74 | 0.738181 | 6 | MATCH |
| 2x-300 | 1.2.14 | owned | 14.74 | 25.8 | 4.165221 | 12.783974 | 92.477309 | 262.604 | 0 | 0.88 | 0.879919 | 6 | MATCH |
| 3x-100 | 1.2.14 | owned-scaled | 3.628 | 11.4 | 4.998632 | 8.642917 | 79.935201 | 87.68337 | 0 | 0.69 | 0.692547 | 6 | MATCH |
| 3x-200 | 1.2.14 | owned-scaled | 6.803 | 18.6 | 4.760514 | 9.826076 | 83.518661 | 175.17555 | 0 | 0.83 | 0.834284 | 6 | MATCH |
| 3x-300 | 1.2.14 | owned-scaled | 9.978 | 25.8 | 4.522397 | 11.009235 | 87.102120 | 262.66776 | 0 | 0.98 | 0.976022 | 6 | MATCH |

### effectiveConfigHash

| Cell | effectiveConfigHash |
|------|---------------------|
| 1x-100 | null (owned-scaled body blocked by the connector enum) |
| 1x-200 | null (owned-scaled body blocked by the connector enum) |
| 1x-300 | null (owned-scaled body blocked by the connector enum) |
| 2x-100 | `9e06dff7f8ba0e38eb6ca44f602faca656c6b27e9ac07c7925bd1d90bb50cfe3` |
| 2x-200 | `e61502617c70d57c8a0e9be50ca0a3a616882c1833f72cd7b2c9ea137eb94292` |
| 2x-300 | `2e2adbbb02797ef60893e892d2043dcfe1a07b19fca9e1a89c1ac0afe7e75858` |
| 3x-100 | null (owned-scaled body blocked by the connector enum) |
| 3x-200 | null (owned-scaled body blocked by the connector enum) |
| 3x-300 | null (owned-scaled body blocked by the connector enum) |

## Warnings

Every 1× cell warns that the one-server pool ceiling is 250 connections against MySQL `max_connections` 500, and that the cell is scaled from the two-server fit (equivalent fit load 200 / 400 / 600 RPS). 1×-200 and 1×-300 add an extrapolation note: that equivalent load is beyond the 300 RPS independent holdout.

Every 3× cell warns that three pools total 750 connections against `max_connections` 500, and that the cell is scaled from the two-server fit (equivalent fit load 66.66666666666667 / 133.33333333333334 / 200 RPS).

2× cells carry the owned-fit provenance note and no extra warning. No cell predicts a connection-class error. `errorRate` is 0 everywhere.

## Simulation IDs (deleted after freeze)

- 1x-100: `d1c3b3ef-a271-4167-a16d-c011368b409d`
- 1x-200: `5124aeba-fe13-4260-a01e-bdc22fb61d1a`
- 1x-300: `414226cd-0f13-4d87-8dcd-50f15058ec48`
- 2x-100: `f320ee04-11d6-41d3-afb4-59f089b746f0`
- 2x-200: `35c4baac-5ef0-4134-8a71-175ea45de0d6`
- 2x-300: `9342c481-b5bf-4369-8980-63dffa2ef8a0`
- 3x-100: `63c05f1a-7381-4434-82b6-673a28cf6b07`
- 3x-200: `f495a13a-5182-4c6a-a6ba-441e74ff7fd8`
- 3x-300: `c3b069b0-2286-419e-9645-5989e2ae458e`

## Files

- `predictions.json` — canonical machine-readable freeze (full precision)
- `call-log.json` — one harvested call per cell, taken from `predictions.json`
- `create-payload-<N>x-<RPS>.json` — graphs from `typical/after-fit/create-payload-<RPS>.json` with only the app-tier count changed (§5.1). 2× matches the after-fit payload apart from `name`. The live create bodies were not attached as a separate directory.
- Full `simulation.metrics` bodies were not part of the committed package. Do not invent them, and do not re-query the engine to fill them in for scoring.

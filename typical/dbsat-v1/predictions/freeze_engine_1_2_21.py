#!/usr/bin/env python3
"""Freeze engine 1.2.21 predictions for the 21 typical-dbsat-v1 cells (§5).

Descriptive only: never scored, never used to pick steps.

Protocol (same as the p95-v1 engine baseline): for each cell, user-cwm MCP
simulation.create with the payload below (typical, seed 20240601, us-east-2,
alb + app-1..N + db, minInstances = maxInstances = N) -> simulation.step once
-> simulation.delete. The MCP calls are made by the operator/agent; this
script only writes the payloads and assembles the saved raw responses.

  freeze_engine_1_2_21.py payloads <dir>     write create-payload-<N>x-<RPS>.json
  freeze_engine_1_2_21.py assemble <raw dir> <out dir>
      raw dir holds <N>x-<RPS>.create.json / .step.json / .delete.json (tool
      output; the JSON object is located between the first '{' and last '}').
"""

import csv
import json
import sys
from pathlib import Path

SERVERS = (2, 3, 4)
LADDER = (300, 500, 700, 900, 1100, 1300, 1500)
SEED = 20240601
ENGINE = "1.2.21"


def payload(n, rps):
    region = {"regionKey": "us-east-2"}
    apps = [{
        "id": f"app-{i}", "type": "compute", "name": f"app-{i}", "provider": "aws", "location": region,
        "characteristics": {"size": "m5.large", "serviceFamily": "ec2", "autoscaling": False,
                            "workload": "crud-typical", "appRuntime": "node", "appWorkerCount": 2,
                            "appDbPoolSize": 250},
    } for i in range(1, n + 1)]
    return {
        "name": f"typical-dbsat-v1 engine-1.2.21 freeze {n}x {rps}",
        "appWeight": "typical",
        "seed": SEED,
        "traffic": rps,
        "minInstances": n,
        "maxInstances": n,
        "resources": [
            {"id": "alb", "type": "network", "name": "ALB (Application Load Balancer)", "provider": "aws",
             "location": region, "characteristics": {"serviceFamily": "alb", "loadBalancerScheme": "internal"}},
            *apps,
            {"id": "db", "type": "database", "name": "db", "provider": "aws", "location": region,
             "characteristics": {"size": "db.r5.large", "serviceFamily": "rds", "workloadDatabaseEngine": "mysql",
                                 "workloadDatabaseVersion": "8.0", "maxConnections": 500}},
        ],
        "connections": [{"sourceId": "alb", "targetId": f"app-{i}"} for i in range(1, n + 1)]
        + [{"sourceId": f"app-{i}", "targetId": "db"} for i in range(1, n + 1)],
    }


def cells():
    return [(n, rps) for n in SERVERS for rps in LADDER]


def in_scope(n, rps):
    # §5 wording: 2–3 servers at <= 300 RPS are inside engine 1.2.21's
    # validated typical P95 scope; 4 servers and every cell above 300 RPS are not.
    return n in (2, 3) and rps <= 300


def load(path):
    text = Path(path).read_text()
    return json.loads(text[text.index("{"):text.rindex("}") + 1])


def resource_cpu(step):
    out = {}
    def walk(obj):
        if isinstance(obj, dict):
            rid = obj.get("id") or obj.get("resourceId")
            if "cpuPercent" in obj and rid:
                out.setdefault(rid, obj["cpuPercent"])
            for value in obj.values():
                walk(value)
        elif isinstance(obj, list):
            for value in obj:
                walk(value)
    walk(step.get("resources") or step)
    return out


def assemble(raw_dir, out_dir):
    raw_dir, out_dir = Path(raw_dir), Path(out_dir)
    rows, problems = [], []
    for n, rps in cells():
        key = f"{n}x-{rps}"
        create, step = load(raw_dir / f"{key}.create.json"), load(raw_dir / f"{key}.step.json")
        deleted = (raw_dir / f"{key}.delete.json").exists()
        pe = create.get("predictionEvidence") or {}
        cpu = resource_cpu(step)
        apps = [cpu[k] for k in sorted(cpu) if k.startswith("app-")]
        row = {
            "cell": key, "servers": n, "total_rps": rps,
            "engineVersion": create.get("engineVersion"), "stepEngineVersion": step.get("engineVersion"),
            "kind": (create.get("calibrationEvidence") or {}).get("kind"),
            "calibrationId": (create.get("calibrationEvidence") or {}).get("calibrationId"),
            "p95_central_ms": (pe.get("latencyP95") or {}).get("central"),
            "p95_low_ms": (pe.get("latencyP95") or {}).get("low"),
            "p95_high_ms": (pe.get("latencyP95") or {}).get("high"),
            "p50_central_ms": (pe.get("latencyP50") or {}).get("central"),
            "step_p95_ms": step.get("latencyP95"), "step_p50_ms": step.get("latencyP50"),
            "app_cpu_step_pct": apps, "db_cpu_step_pct": cpu.get("db"),
            "error_rate": step.get("errorRate"), "throughput": step.get("throughput"),
            "in_validated_scope": in_scope(n, rps),
            "simulationId": create.get("id"), "deleted": deleted,
        }
        if row["engineVersion"] != ENGINE or row["stepEngineVersion"] != ENGINE:
            problems.append(f"{key}: engine {row['engineVersion']}/{row['stepEngineVersion']}")
        if not deleted:
            problems.append(f"{key}: no delete record")
        rows.append(row)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "predictions.json").write_text(json.dumps({
        "campaign": "typical-dbsat-v1", "engineVersion": ENGINE, "seed": SEED,
        "use": "descriptive only; never scored, never used to pick steps (prereg §5, §7.6)",
        "problems": problems, "cells": rows}, indent=1) + "\n")
    with open(out_dir / "predictions.csv", "w", newline="") as handle:
        fields = [k for k in rows[0] if k != "app_cpu_step_pct"] + ["app_cpu_step_pct_mean"]
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            flat = {k: v for k, v in row.items() if k != "app_cpu_step_pct"}
            flat["app_cpu_step_pct_mean"] = sum(row["app_cpu_step_pct"]) / len(row["app_cpu_step_pct"]) if row["app_cpu_step_pct"] else None
            writer.writerow(flat)
    return problems


def main(argv):
    if len(argv) >= 2 and argv[0] == "payloads":
        target = Path(argv[1])
        target.mkdir(parents=True, exist_ok=True)
        for n, rps in cells():
            (target / f"create-payload-{n}x-{rps}.json").write_text(json.dumps(payload(n, rps), indent=1) + "\n")
        return 0
    if len(argv) >= 3 and argv[0] == "assemble":
        problems = assemble(argv[1], argv[2])
        print("\n".join(problems) or "ok: 21 cells, all engine 1.2.21, all deleted")
        return 1 if problems else 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

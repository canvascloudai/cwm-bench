import fs from "node:fs/promises";
import path from "node:path";

export function exactMysql80Version(response: any): string {
  const instances = response?.DBInstances;
  const version = instances?.[0]?.EngineVersion;
  if (!Array.isArray(instances) || instances.length !== 1 || instances[0].Engine !== "mysql" ||
      typeof version !== "string" ||
      !/^8\.0\.\d+(?:-rds\.\d{8}(?:\.r\d+(?:\.\d{8})?)?)?$/i.test(version))
    throw new Error("MySQL 8.0 minor unavailable/mismatched");
  return version; // Preserve AWS's entire identifier, including capitalization and RDS patch suffix.
}

type ExecutionJournal = {
  parent: string; revision: string; ami?: string; sessions: string[]; finishedAt?: string;
  slots: { campaign: string; rep: number; out: string; applyAttempted: boolean;
    finished?: boolean; attempts: unknown[] }[];
};

export async function scaleExecutionReadme(j: ExecutionJournal): Promise<string> {
  const rows: string[] = [];
  const baseline = new Set<string>(), finalSession = new Set<string>();
  for (const s of j.slots.filter(s => s.applyAttempted)) {
    const files = (await fs.readdir(s.out)).filter(n => /^03-rds-engine-version-\d+\.json$/.test(n)).sort();
    const started = JSON.parse(await fs.readFile(path.join(s.out, "01-apply-started.json"), "utf8")).at;
    for (const file of files) {
      const response = JSON.parse(await fs.readFile(path.join(s.out, file), "utf8"));
      const version = exactMysql80Version(response);
      (s.rep < 3 ? baseline : finalSession).add(version);
      rows.push(`| ${s.campaign} | ${started} | ${version} | ${s.finished ? "completed" : "failed/incomplete"} | ${file} |`);
    }
    if (!files.length) rows.push(`| ${s.campaign} | ${started} | not recorded | failed/incomplete | see raw evidence |`);
  }
  const quoted = (v: Set<string>) => [...v].map(x => `\`${x}\``).join(", ") || "not recorded";
  const different = [...finalSession].filter(v => !baseline.has(v));
  return `# Raw typical-scale-v1 execution

Parent: ${j.parent}
Measurement SHA: ${j.revision}
AMI: ${j.ami}
First apply starts by session (UTC, including failed applies): ${j.sessions.join(", ")}
Finished: ${j.finishedAt}

Completed cells: ${j.slots.filter(s => s.finished).length}
Total attempted applies, including preserved failures: ${j.slots.filter(s => s.applyAttempted).length}

Cells ran in Latin-square order with fresh applies and 100 → 200 → 300 ladders.
Historical holdout lock untouched. No CWM engine queries, scoring, metric commentary, retuning, or coefficient changes.
All run/collect attempts and failed preparations are retained. Generator markers supplied exact collect bounds; no trailing fallback was accepted.

## Exact RDS engine identifiers

Sessions 1–2 reported: ${quoted(baseline)}.
Session 3 reported: ${quoted(finalSession)}.
${different.length ? `Different reported build identifiers from sessions 1–2: ${different.map(v => `\`${v}\``).join(", ")}.` : "Session 3 reported the same exact build identifiers as sessions 1–2."}
These are verbatim AWS identifiers; no suffix was removed and no performance interpretation is provided.

| Apply | Actual apply start UTC | Exact EngineVersion | Outcome | Raw version evidence |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

## Execution problems and recovery

- Initial pre-apply preparation was interrupted before any apply or load; its evidence is retained.
- Read-only overnight due timers were interrupted by workspace restarts. No running measurement was interrupted by those timer restarts.
- Session 3 encountered three stopped preflight attempts due to AWS CLI read timeouts. All responses, controller logs and stopped-state snapshots are retained. Two consecutive healthy read-only rounds preceded the successful full cleanup preflight.
- The original three-app session 3 apply passed app readiness but the controller's numeric-only version validator rejected \`8.0.46-rds.20260908\`. No load ran on that apply; it was destroyed and checked immediately and after 15 minutes in both regions.
- The creator approved recognition of AWS's documented MySQL 8.0 RDS patch format and one fresh \`r3a\` replacement. The failed apply remains evidence. Terraform defaults, AMI, source SHA, profile, workers, pool size, database connection limit, workload order and timings were unchanged. RDS Extended Support charges were disclosed before approval.
- The delayed-cleanup helper's temporary console log was unavailable after the overnight pause. Its durable AWS command outputs, JSON records and successful cleanup proofs remain preserved.
- Per-apply raw attempt records document any load retry or incomplete collect. Retried outputs are separate evidence, never overwritten.

See verification/ for preparation failures, workspace interruption records, connectivity checks, creator approvals and controller logs; see each apply directory for outputs, exact versions, run/collect JSONs and cleanup proofs.
`;
}

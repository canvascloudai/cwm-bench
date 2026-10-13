import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Only an undecidable credential prefix is buffered. URLs are suppressed until
// their delimiter, so even very long URLs never spill credentials to disk.
export class HoldoutRedactor {
  private pending = "";
  private inUrl = false;
  private previous = "";
  private secrets: string[];
  private prefixes: string[];

  constructor(secrets: string[]) {
    this.secrets = [...new Set(secrets.filter(Boolean).flatMap(secret =>
      [secret, JSON.stringify(secret).slice(1, -1)]))].sort((a, b) => b.length - a.length);
    this.prefixes = ["postgres://", "postgresql://", ...this.secrets];
  }

  push(text: string, final = false): string {
    this.pending += text;
    const output: string[] = [];
    let i = 0;
    const consume = (length: number) => {
      this.previous = this.pending[i + length - 1];
      i += length;
    };
    while (i < this.pending.length) {
      const rest = this.pending.slice(i);
      if (this.inUrl) {
        if (!/[\s"'<>]/.test(rest[0])) { consume(1); continue; }
        this.inUrl = false;
      }
      // Defer ambiguous longer matches, even if a shorter secret already fits.
      if (!final && this.prefixes.some(prefix => prefix.startsWith(rest) && prefix.length > rest.length)) break;
      const url = ["postgres://", "postgresql://"].find(prefix => rest.startsWith(prefix));
      if (url) {
        output.push("[REDACTED_DATABASE_URL]");
        consume(url.length);
        this.inUrl = true;
        continue;
      }
      const secret = this.secrets.find(value => rest.startsWith(value));
      if (secret) { output.push("[REDACTED]"); consume(secret.length); continue; }
      if (!/\w/.test(this.previous) && /^(?:AKIA|ASIA)/.test(rest)) {
        if (!final && rest.length <= 20 && /^(?:AKIA|ASIA)[A-Z0-9]*$/.test(rest)) break;
        if (final && rest.length < 20 && /^(?:AKIA|ASIA)[A-Z0-9]*$/.test(rest)) {
          output.push("[REDACTED_PARTIAL]"); consume(rest.length); continue;
        }
        if (/^(?:AKIA|ASIA)[A-Z0-9]{16}(?!\w)/.test(rest)) {
          output.push("[REDACTED_AWS_KEY]"); consume(20); continue;
        }
      }
      // AKIA/ASIA may themselves be split across reads.
      if (!final && !/\w/.test(this.previous) && ["AKIA", "ASIA"].some(prefix => prefix.startsWith(rest))) break;
      // A terminal partial credential is not safe to flush on interruption.
      if (final && this.prefixes.some(prefix => prefix.startsWith(rest) && prefix.length > rest.length)) {
        output.push("[REDACTED_PARTIAL]"); consume(rest.length); continue;
      }
      if (final && !/\w/.test(this.previous) && ["AKIA", "ASIA"].some(prefix => prefix.startsWith(rest))) {
        output.push("[REDACTED_PARTIAL]"); consume(rest.length); continue;
      }
      output.push(rest[0]); consume(1);
    }
    this.pending = this.pending.slice(i);
    return output.join("");
  }
}

export class HoldoutIO {
  secrets: string[] = [];
  active: ChildProcess | null = null;
  interrupted = false;
  cleaning = false;

  constructor() {
    for (const [key, value] of Object.entries(process.env)) {
      if (value && /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL|AUTH|DATABASE_URL/i.test(key)) this.secrets.push(value);
    }
  }

  installSignals(): void {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => {
      if (this.cleaning) return;
      this.interrupted = true;
      this.active?.kill(signal);
    });
  }

  redact(text: string): string {
    return new HoldoutRedactor(this.secrets).push(text, true);
  }

  async text(file: string, text: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, this.redact(text), { flag: "wx", mode: 0o600 });
  }

  async json(file: string, value: unknown): Promise<void> {
    await this.atomic(file, this.redact(JSON.stringify(value, null, 2) + "\n"), false);
  }

  async state(file: string, value: unknown): Promise<void> {
    await this.atomic(file, this.redact(JSON.stringify(value, null, 2) + "\n"), true);
  }

  private async atomic(file: string, text: string, replace: boolean): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try { await handle.writeFile(text); await handle.sync(); }
      finally { await handle.close(); }
      // link publishes without overwriting an earlier attempt; rename is only
      // allowed for the mutable runner journal.
      if (replace) await fs.rename(temporary, file);
      else await fs.link(temporary, file);
      const directory = await fs.open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await fs.rm(temporary, { force: true }); }
  }

  async hasCommandEvidence(file: string): Promise<boolean> {
    for (const name of [file, `${file}.stdout.txt`, `${file}.stderr.txt`, `${file}.command-started.json`, `${file}.command.json`]) {
      try { await fs.stat(name); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return false;
  }

  async wait(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.interrupted && !this.cleaning) throw new Error("Interrupted; cleanup required");
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, end - Date.now())));
    }
  }

  async command(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, file: string,
    timeoutMs = 70 * 60_000): Promise<{ code: number; value: any; stdout: string }> {
    if (this.interrupted && !this.cleaning) throw new Error("Interrupted; cleanup required");
    // Reserve attempt-specific evidence before spawn: a collision must never
    // launch a second workload just to discover that its output cannot be saved.
    if (await this.hasCommandEvidence(file)) throw new Error(`Command evidence already exists: ${path.basename(file)}`);
    await this.json(`${file}.command-started.json`, {
      command: path.basename(command), args, startedAt: new Date().toISOString(),
      stdoutFile: path.basename(`${file}.stdout.txt`), stderrFile: path.basename(`${file}.stderr.txt`),
    });
    const descriptors: number[] = [];
    try {
      descriptors.push(openSync(`${file}.stdout.txt`, "wx", 0o600));
      descriptors.push(openSync(`${file}.stderr.txt`, "wx", 0o600));
      // Make the directory entries durable before the child can emit output.
      const directory = await fs.open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      if (this.interrupted && !this.cleaning) throw new Error("Interrupted; cleanup required");
      return await this.capture(command, args, cwd, env, file, timeoutMs, descriptors);
    } finally { for (const fd of descriptors) closeSync(fd); }
  }

  private async capture(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, file: string,
    timeoutMs: number, descriptors: number[]): Promise<{ code: number; value: any; stdout: string }> {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      this.active = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      const output: string[][] = [[], []];
      const redactors = [new HoldoutRedactor(this.secrets), new HoldoutRedactor(this.secrets)];
      let bytes = 0, overflow = false, timedOut = false;
      let failure: Error | undefined;
      const save = (stream: number, text: string) => {
        if (!text || failure) return;
        try {
          const buffer = Buffer.from(text);
          let offset = 0;
          while (offset < buffer.length) offset += writeSync(descriptors[stream], buffer, offset);
          fsyncSync(descriptors[stream]);
          output[stream].push(text);
        } catch {
          failure = new Error("Cannot persist command output");
          child.kill("SIGTERM");
        }
      };
      const append = (stream: number, chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 32 * 1024 * 1024) { overflow = true; child.kill("SIGTERM"); return; }
        save(stream, redactors[stream].push(chunk));
      };
      child.stdout.on("data", chunk => append(0, chunk));
      child.stderr.on("data", chunk => append(1, chunk));
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
      child.once("error", () => { failure = new Error(`Cannot start ${path.basename(command)}`); });
      child.once("close", code => {
        clearTimeout(timer); this.active = null;
        save(0, redactors[0].push("", true));
        save(1, redactors[1].push("", true) +
          (timedOut ? "\nCOMMAND_TIMEOUT\n" : "") + (overflow ? "\nOUTPUT_LIMIT_EXCEEDED\n" : ""));
        if (failure) { reject(failure); return; }
        resolve({
          code: code ?? 1,
          stdout: output[0].join(""),
          stderr: output[1].join(""),
        });
      });
    });
    // Live logs may be incomplete after a restart. The canonical response is
    // visible only after close and a fully synced, atomic publication.
    let value: any = null;
    let validJson = false;
    try { value = JSON.parse(result.stdout); validJson = true; } catch { /* Live output remains saved. */ }
    const finalResponsePublished = !file.endsWith(".json") || validJson;
    if (finalResponsePublished) await this.atomic(file, result.stdout, false);
    await this.json(`${file}.command.json`, { command: path.basename(command), args, exitCode: result.code,
      finishedAt: new Date().toISOString(), finalResponsePublished });
    return { code: result.code, value, stdout: result.stdout };
  }
}

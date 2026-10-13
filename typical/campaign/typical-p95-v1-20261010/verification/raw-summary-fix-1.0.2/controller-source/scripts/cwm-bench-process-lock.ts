import fs from "node:fs/promises";
import { spawn } from "node:child_process";

// Linux flock locks the shared open-file description, not the helper PID.
// The inherited fd acquires the lock; our fd keeps it after the helper exits.
// No helper supervises the owner, no PID reclamation, and no unlink on release:
// every contender must open the same persistent inode.
export async function withProcessLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  if (process.platform !== "linux") {
    throw new Error("Recovery requires Linux flock; lock retained");
  }
  const handle = await fs.open(file, "a+", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "75", "3"], {
        stdio: ["ignore", "ignore", "ignore", handle.fd],
      });
      child.once("error", error => reject(new Error("Cannot acquire recovery serialization lock; lock retained", { cause: error })));
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else if (code === 75) reject(new Error("Recovery claim already exists; do not overlap recovery"));
        else reject(new Error(`Cannot acquire recovery serialization lock (${signal ?? code}); lock retained`));
      });
    });
    return await work();
  } finally {
    // Closing (including OS closure on abrupt exit) releases ownership.
    await handle.close();
  }
}

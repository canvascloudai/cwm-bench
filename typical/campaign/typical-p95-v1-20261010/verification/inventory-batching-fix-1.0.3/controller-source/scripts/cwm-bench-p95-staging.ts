import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const ASSETS = ["app/src/server.js", "app/package.json", "app/seed/seed.sql",
  "load/scenarios.js", "load/diagnostics.js", "load/lib/common.js"];
const exists = async (p: string) => fs.lstat(p).then(() => true, e => {
  if (e.code === "ENOENT") return false;
  throw e;
});

/** Preserve Terraform's relative source layout without modifying the pinned checkout. */
export async function stageTerraform(repo: string, tfdir: string) {
  if (!await exists(tfdir)) await fs.cp(path.join(repo, "terraform"), tfdir, { recursive: true });
  const backend = path.join(tfdir, "zz-p95-backend.tf");
  if (!await exists(backend)) await fs.writeFile(backend, 'terraform {\n  backend "pg" {}\n}\n',
    { flag: "wx", mode: 0o600 });
  for (const sibling of ["app", "load"]) {
    const target = path.resolve(repo, sibling), link = path.join(path.dirname(tfdir), sibling);
    if (!await exists(link)) await fs.symlink(target, link, "dir");
    if (!((await fs.lstat(link)).isSymbolicLink()) || await fs.realpath(link) !== await fs.realpath(target))
      throw new Error(`External ${sibling} source path does not point to the pinned checkout`);
  }
  return Promise.all(ASSETS.map(async asset => {
    const source = await fs.readFile(path.join(repo, asset));
    const staged = await fs.readFile(path.join(tfdir, "..", asset));
    if (!source.equals(staged)) throw new Error(`Staged asset mismatch: ${asset}`);
    return { asset, sha256: createHash("sha256").update(source).digest("hex"), unchanged: true };
  }));
}

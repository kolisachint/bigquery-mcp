// Copy the shared cost-first querying agent skill into the build output so it
// ships inside the npm package. The canonical skill lives at the repo root
// (.agents/skills/...); this mirrors how the contract is bundled at build time.
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const skillRelPath = "skills/bigquery-cost-first-querying/SKILL.md";
const repoRoot = resolve(import.meta.dir, "..", "..");
const src = join(repoRoot, ".agents", skillRelPath);
const dest = join(import.meta.dir, "..", "dist", skillRelPath);

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`copied skill -> dist/${skillRelPath}`);

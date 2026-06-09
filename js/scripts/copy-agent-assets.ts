// Copy the shared agent skills and agent definitions into the build output so
// they ship inside the npm package. The canonical copies live at the repo root
// under .agents/; this mirrors how the contract is bundled at build time and
// keeps the npm package in sync with the Python (PyPI) force-include list.
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Paths are relative to the repo-root .agents/ directory.
const assets = [
  "skills/bigquery-cost-first-querying/SKILL.md",
  "skills/secure-context-reducer/SKILL.md",
  "agents/bigquery-table-analyst.md",
  "agents/cost-first-compliant-agent.md",
];

const repoRoot = resolve(import.meta.dir, "..", "..");
const distRoot = join(import.meta.dir, "..", "dist");

for (const rel of assets) {
  const src = join(repoRoot, ".agents", rel);
  const dest = join(distRoot, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`copied agent asset -> dist/${rel}`);
}

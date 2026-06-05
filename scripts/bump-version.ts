#!/usr/bin/env bun
/**
 * Bump the project version in lockstep across the Python and JS packages.
 *
 * Usage: bun scripts/bump-version.ts <major|minor|patch>
 *
 * Updates pyproject.toml, src/bigquery_mcp/__init__.py and js/package.json, then
 * prints the new version to stdout (logs go to stderr) so CI can capture it:
 *   version=$(bun scripts/bump-version.ts patch)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const level = process.argv[2];
if (level !== "major" && level !== "minor" && level !== "patch") {
  console.error("Usage: bun scripts/bump-version.ts <major|minor|patch>");
  process.exit(1);
}

const root = join(import.meta.dir, "..");
const pyprojectPath = join(root, "pyproject.toml");
const initPath = join(root, "src", "bigquery_mcp", "__init__.py");
const pkgPath = join(root, "js", "package.json");

// pyproject.toml is the source of truth for the current version.
const pyproject = readFileSync(pyprojectPath, "utf8");
const match = pyproject.match(/^version = "(\d+)\.(\d+)\.(\d+)"/m);
if (!match) {
  console.error("Could not find a semver `version = \"x.y.z\"` in pyproject.toml");
  process.exit(1);
}

let [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
if (level === "major") {
  major += 1;
  minor = 0;
  patch = 0;
} else if (level === "minor") {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}
const next = `${major}.${minor}.${patch}`;

// pyproject.toml
writeFileSync(
  pyprojectPath,
  pyproject.replace(/^version = "\d+\.\d+\.\d+"/m, `version = "${next}"`),
);

// src/bigquery_mcp/__init__.py
const init = readFileSync(initPath, "utf8");
writeFileSync(initPath, init.replace(/__version__ = "\d+\.\d+\.\d+"/, `__version__ = "${next}"`));

// js/package.json (preserve formatting: 2-space indent + trailing newline)
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

console.error(`Bumped ${match[1]}.${match[2]}.${match[3]} -> ${next} (${level})`);
console.log(next);

// Refreshes public/data/game-data.json from the upstream project's data tables
// (item/effect ids and names, vessels, recommended effects). Run after a game patch
// if the app reports "Unknown relic" / "Unknown effect".
//
//   node scripts/update-data.mjs [git-ref=main]
//
// Needs git and npm. Works in a temp directory; only writes public/data/game-data.json.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/metinc/nightreign-relic-browser.git";
const ref = process.argv[2] ?? "main";
const here = fileURLToPath(new URL(".", import.meta.url));
const target = join(here, "..", "public", "data", "game-data.json");
const work = mkdtempSync(join(tmpdir(), "relic-data-"));
const shell = process.platform === "win32";
const run = (cmd, args, cwd = work) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell });

try {
  run("git", ["clone", "--depth", "1", "--branch", ref, REPO, "upstream"]);
  const repo = join(work, "upstream");
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], repo);
  copyFileSync(join(here, "extract-upstream.ts"), join(repo, "extract.ts"));
  const out = join(work, "game-data.json");
  run("npx", ["-y", "tsx", "extract.ts", out], repo);

  const before = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : { items: {}, effects: {}, effectIdToKey: {} };
  const after = JSON.parse(readFileSync(out, "utf8"));
  const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
  after.source = `github.com/metinc/nightreign-relic-browser v${version} (MIT)`;
  const added = (a, b) => Object.keys(b).filter((k) => !(k in a)).length;
  console.log(`\nupstream v${version}: +${added(before.items, after.items)} item ids, +${added(before.effectIdToKey, after.effectIdToKey)} effect ids`);

  writeFileSync(target, JSON.stringify(after));
  console.log(`wrote ${target}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

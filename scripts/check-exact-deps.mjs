#!/usr/bin/env node
// Supply-chain guard (GHOST security sweep, 2026-10-30). Fails when:
//  - any package.json asks for a moving version. Exact = 1.2.3[-pre][+build], npm:name@1.2.3, a git URL pinned to a
//    40-char commit, or a local workspace:/file:/link:/portal:/path spec;
//  - the repo does not turn on save-exact and the 7-day release-age cooldown for npm and bun (and pnpm when used);
//  - any registry version in a committed lockfile was published less than 7 days ago.
// Publish times come from deps.dev (Google Open Source Insights, mirrors npm). A publish time never changes, so each
// one is cached forever in ~/.cache/check-exact-deps. A version whose age cannot be read fails: under doubt the
// guard blocks the merge, because a blocked run costs minutes and a poisoned release can cost the fleet.
// Runs on node or bun, no dependencies.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const ROOT = process.argv[2] ?? process.cwd();
const MIN_AGE_DAYS = 7;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", ".cache", "coverage", ".venv", "venv", "target", ".agent", ".claude", ".omp", ".rgr"]);
const SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const GIT_SHA = /#[0-9a-f]{40}$/;
const LOCAL = /^(workspace:|file:|link:|portal:|\.{0,2}\/)/;
const LOCKS = ["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];

export function isExact(spec) {
  if (typeof spec !== "string") return false;
  if (SEMVER.test(spec) || LOCAL.test(spec)) return true;
  if (spec.startsWith("npm:")) return SEMVER.test(spec.slice(spec.lastIndexOf("@") + 1));
  if (spec.startsWith("catalog:")) return true; // the catalog entries themselves are checked where they are defined
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:.*\.git)/.test(spec)) return GIT_SHA.test(spec);
  return false;
}

const SCRIPT = /^(Dockerfile.*|.*\.dockerfile|Makefile|.*\.(sh|bash|zsh|ps1|ya?ml|toml))$/;
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) yield* walk(join(dir, e.name)); }
    else if (e.name === "package.json" || LOCKS.includes(e.name) || SCRIPT.test(e.name)) yield join(dir, e.name);
  }
}

const TOOL_RUN = /\b(npx|bunx|bun x|pnpm dlx|pnpx|yarn dlx)\b|\b(npm|bun|pnpm|yarn)\s+(i|install|add)\b/;
// name@version pins on lines that run or install a named package, plus the bun installer's bun-vX.Y.Z.
export function toolPins(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/bun-v(\d+\.\d+\.\d+)\b/g)) out.push([i + 1, `bun@${m[1]}`]);
    if (!TOOL_RUN.test(line)) return;
    for (const m of line.matchAll(/(?:^|[\s"'`=])(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)@(\d+\.\d+\.\d+(?:-[\w.]+)?)(?=$|[\s"'`;,)])/gi)) out.push([i + 1, `${m[1]}@${m[2]}`]);
  });
  return out;
}

function overrideSpecs(obj, path, out) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v && typeof v === "object") overrideSpecs(v, `${path}.${k}`, out);
    else out.push([k === "." ? `${path}["."]` : `${path}.${k}`, v]);
  }
}

const fromTarball = (url) => url?.match(/^https?:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\/(.+?)\/-\/[^/]+-(\d[^/]*)\.tgz/);

function* bunLock(text) {
  const lock = JSON.parse(text.replace(/,(\s*[}\]])/g, "$1"));
  for (const v of Object.values(lock.packages ?? {})) {
    const m = typeof v?.[0] === "string" && v[0].match(/^(@?[^@]+)@(\d+\.\d+\.\d+\S*)$/);
    if (m && typeof v[3] === "string") yield `${m[1]}@${m[2]}`;
  }
}

function* npmLock(text) {
  for (const [k, v] of Object.entries(JSON.parse(text).packages ?? {})) {
    if (!k.includes("node_modules/") || v.link || !v.version) continue;
    const t = fromTarball(v.resolved);
    if (t) yield `${t[1]}@${t[2]}`;
    else if (!v.resolved || v.resolved.startsWith("https://")) yield `${v.name ?? k.slice(k.lastIndexOf("node_modules/") + 13)}@${v.version}`;
  }
}

function* pnpmLock(text) {
  const section = text.split(/^packages:\s*$/m)[1]?.split(/^\S/m)[0] ?? "";
  for (const m of section.matchAll(/^ {2}'?(@?[^@'\s(]+)@(\d+\.\d+\.\d+[^(':\s]*)/gm)) yield `${m[1]}@${m[2]}`;
}

// yarn v1 text (also what `bun bun.lockb` prints): name and version come from each resolved tarball URL.
function* yarnLock(text) {
  for (const m of text.matchAll(/^\s+resolved "([^"]+)"/gm)) {
    const t = fromTarball(m[1]);
    if (t) yield `${t[1]}@${t[2]}`;
  }
}

// Registry packages ("name@version") locked in one lockfile, or null when bun cannot print a bun.lockb.
// Workspace, file, link and git entries are skipped.
export function lockedPackages(file) {
  if (file.endsWith(".lockb")) {
    const text = spawnSync("bun", [file], { encoding: "utf8" }).stdout;
    if (!text) return null;
    return new Set(yarnLock(text));
  }
  const text = readFileSync(file, "utf8");
  if (file.endsWith("bun.lock")) return new Set(bunLock(text));
  if (file.endsWith(".json")) return new Set(npmLock(text));
  if (file.endsWith("pnpm-lock.yaml")) return new Set(pnpmLock(text));
  return new Set(yarnLock(text));
}

const CACHE_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "check-exact-deps");
const CACHE = join(CACHE_DIR, "published-v1.json");

// cache: name@version -> ISO publish time; failed: name@version -> why its age could not be read.
export async function publishTimes(ids) {
  const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  const todo = [...ids].filter((id) => !cache[id]);
  const failed = new Map();
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const id = todo[next++];
      const at = id.lastIndexOf("@");
      const url = `https://api.deps.dev/v3/systems/npm/packages/${encodeURIComponent(id.slice(0, at))}/versions/${encodeURIComponent(id.slice(at + 1))}`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) { failed.set(id, `deps.dev answered ${res.status}`); continue; }
        const { publishedAt } = await res.json();
        if (publishedAt) cache[id] = publishedAt; else failed.set(id, "deps.dev has no publish time");
      } catch (e) { failed.set(id, `deps.dev unreachable (${e.message})`); }
    }
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  if (todo.length) { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(CACHE, JSON.stringify(cache)); }
  return { cache, failed };
}

const problems = [];
const locked = new Map(); // name@version -> where it was found (lockfile, or script file:line)
const note = (id, where) => { if (!locked.has(id)) locked.set(id, where); };
const lockFiles = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (LOCKS.includes(name)) {
    lockFiles.push(rel);
    try {
      const ids = lockedPackages(file);
      if (ids) for (const id of ids) note(id, rel);
      else problems.push(`${rel}: unreadable lockfile (bun could not print it)`);
    }
    catch (e) { problems.push(`${rel}: unreadable lockfile (${e.message})`); }
    continue;
  }
  const text = readFileSync(file, "utf8");
  for (const [line, id] of toolPins(text)) note(id, `${rel}:${line}`);
  if (name !== "package.json") continue;
  let pkg;
  try { pkg = JSON.parse(text); } catch (e) { problems.push(`${rel}: unreadable (${e.message})`); continue; }
  const catalogs = { default: pkg.catalog ?? pkg.workspaces?.catalog, ...(pkg.catalogs ?? pkg.workspaces?.catalogs ?? {}) };
  const specs = [];
  for (const s of SECTIONS) for (const [n, v] of Object.entries(pkg[s] ?? {})) specs.push([`${s}.${n}`, v]);
  overrideSpecs(pkg.overrides, "overrides", specs);
  overrideSpecs(pkg.resolutions, "resolutions", specs);
  overrideSpecs(pkg.pnpm?.overrides, "pnpm.overrides", specs);
  for (const [cat, deps] of Object.entries(catalogs)) for (const [n, v] of Object.entries(deps ?? {})) specs.push([`catalog.${cat}.${n}`, v]);
  for (const [where, spec] of specs) if (!isExact(spec)) problems.push(`${rel}: ${where} = ${JSON.stringify(spec)} is not an exact version`);
}

// npm and bun read project config from the folder they install in, so the root and every lockfile folder need it.
const read = (dir, f) => (existsSync(join(ROOT, dir, f)) ? readFileSync(join(ROOT, dir, f), "utf8") : "");
for (const dir of new Set(["", ...lockFiles.map((f) => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ""))])) {
  const at = (f) => (dir ? `${dir}/${f}` : f);
  const npmrc = read(dir, ".npmrc");
  if (!/^\s*save-exact\s*=\s*true\s*$/m.test(npmrc)) problems.push(`${at(".npmrc")}: add save-exact=true`);
  if (!(Number(npmrc.match(/^\s*min-release-age\s*=\s*(\d+)\s*$/m)?.[1]) >= MIN_AGE_DAYS)) problems.push(`${at(".npmrc")}: add min-release-age=${MIN_AGE_DAYS}`);
  const bunInstall = read(dir, "bunfig.toml").match(/^\[install\][^\n]*\n((?:(?!\[)[^\n]*\n?)*)/m)?.[1] ?? "";
  if (!/^\s*exact\s*=\s*true\b/m.test(bunInstall)) problems.push(`${at("bunfig.toml")}: add exact = true under [install]`);
  if (!(Number(bunInstall.match(/^\s*minimumReleaseAge\s*=\s*(\d+)/m)?.[1]) >= MIN_AGE_DAYS * 86400)) problems.push(`${at("bunfig.toml")}: add minimumReleaseAge = ${MIN_AGE_DAYS * 86400} under [install]`);
  if (lockFiles.includes(at("pnpm-lock.yaml")) && !(Number(read(dir, "pnpm-workspace.yaml").match(/^minimumReleaseAge:\s*(\d+)/m)?.[1]) >= MIN_AGE_DAYS * 1440))
    problems.push(`${at("pnpm-workspace.yaml")}: add minimumReleaseAge: ${MIN_AGE_DAYS * 1440}`);
}

const { cache, failed } = await publishTimes(locked.keys());
const cutoff = Date.now() - MIN_AGE_DAYS * 86400_000;
for (const [id, file] of locked) {
  if (failed.has(id)) problems.push(`${file}: ${id} age unknown (${failed.get(id)})`);
  else if (Date.parse(cache[id]) > cutoff) problems.push(`${file}: ${id} was published ${cache[id].slice(0, 10)}, less than ${MIN_AGE_DAYS} days ago`);
}

if (problems.length) {
  console.error(`check-exact-deps: ${problems.length} problem(s). Pin exact versions that are at least ${MIN_AGE_DAYS} days old:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-exact-deps: every dependency is exact and at least ${MIN_AGE_DAYS} days old (${locked.size} locked versions)`);

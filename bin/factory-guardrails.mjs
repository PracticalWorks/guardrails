#!/usr/bin/env node
// Install the shop's shared git hooks into whatever repo this package is a
// dependency of, by pointing `core.hooksPath` at the hooks THIS package ships.
//
// WHY A PACKAGE AND NOT A COPIED FILE. A hook committed to one repo is wired by
// that repo alone: every other repo has none, and there is no way to update them
// centrally — a fix means one pull request per repo, so it never happens. As a
// dependency, the hooks arrive wherever the package is installed and a fix
// reaches every repo through a normal version bump.
//
// It also binds automated contributors, not just people: an agent that installs
// dependencies before it works gets exactly the hooks a human does, from the
// same version, with nothing extra to remember.
//
// WHY core.hooksPath AND NOT COPYING INTO .git/hooks. A copy is a fork the moment
// it lands: bump the package and every repo still runs the file it copied months
// ago. Pointing at the installed package means a normal dependency update moves
// the hooks, which is the entire point.
//
// The cost of that choice, stated plainly: `core.hooksPath` is a single path, so
// a repo can host only ONE hooks directory. That is why the hooks we ship
// delegate to `.guardrails/<hook>` — see hooks/commit-msg. Without delegation,
// adopting this package would silently delete every repo's own hooks.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS_DIR = resolve(fileURLToPath(new URL("../hooks", import.meta.url)));
/** Deliberately NOT under hooks/: core.hooksPath would pick it up as a git hook. */
const AGENT_HOOK = resolve(fileURLToPath(new URL("../agent-hooks/block-secret-print.sh", import.meta.url)));
/** Where the previous value is parked, so `uninstall` can put it back. */
const SAVED_KEY = "guardrails.previoushookspath";
const SETTINGS = join(".claude", "settings.json");

/** git, with the repo-location pointers git exports into hooks removed.
 *
 * A `prepare` script can itself run inside a hook (a `git commit` that triggers
 * an install), and GIT_DIR outranks cwd — so without this an install could
 * configure a DIFFERENT repository than the one it is installing into. The same
 * leak turns a test's throwaway fixture into writes against the real repo, which
 * is subtle enough to go unnoticed for days. */
function git(args, cwd) {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

function repoRoot() {
  const root = tryGit(["rev-parse", "--show-toplevel"], process.cwd());
  if (!root) {
    // Not a git repo: a tarball install, a CI cache restore, a Docker build
    // context. Exit 0 — a `prepare` script that fails takes `npm install` down
    // with it, and "no repo to install hooks into" is not an error worth that.
    console.log("guardrails: not inside a git repository — nothing to install.");
    process.exit(0);
  }
  return root;
}

function install() {
  const root = repoRoot();
  installGitHooks(root);
  installAgentHook(root);
}

function installGitHooks(root) {
  // Relative so the value survives the repo being moved or cloned to a different
  // path, and so it reads sensibly in `git config --list`.
  const target = relative(root, HOOKS_DIR) || ".";
  const current = tryGit(["config", "--local", "core.hooksPath"], root);

  if (current === target) {
    console.log(`guardrails: already installed (core.hooksPath = ${target}).`);
    return;
  }
  // Save the previous value ONCE. Re-running install must not overwrite a real
  // previous path with our own — that would make uninstall restore us to us.
  if (current && !tryGit(["config", "--local", SAVED_KEY], root)) {
    git(["config", "--local", SAVED_KEY, current], root);
  }
  git(["config", "--local", "core.hooksPath", target], root);
  console.log(`guardrails: installed (core.hooksPath = ${target}).`);
  if (current) console.log(`guardrails: previous value "${current}" saved for uninstall.`);
}

function uninstall() {
  const root = repoRoot();
  uninstallAgentHook(root);
  uninstallGitHooks(root);
}

function uninstallGitHooks(root) {
  const saved = tryGit(["config", "--local", SAVED_KEY], root);
  if (saved) {
    git(["config", "--local", "core.hooksPath", saved], root);
    git(["config", "--local", "--unset", SAVED_KEY], root);
    console.log(`guardrails: uninstalled, core.hooksPath restored to "${saved}".`);
    return;
  }
  // Nothing saved means there was nothing set before us. Unset rather than
  // leaving a dangling path — a core.hooksPath pointing at a package that is no
  // longer installed disables every hook silently.
  tryGit(["config", "--local", "--unset", "core.hooksPath"], root);
  console.log("guardrails: uninstalled, core.hooksPath unset.");
}

// THE CLAUDE SEAT HALF — the same conclusion as core.hooksPath: settings.json
// INVOKES the installed package, so a version bump moves the guard. Claude Code
// runs hooks in a plain shell without node_modules/.bin on PATH, so a local
// install is named by path (quoted: project paths can contain spaces).
function agentHookCommand(root) {
  return existsSync(join(root, "node_modules", ".bin", "factory-guardrails"))
    ? '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/factory-guardrails agent-hook'
    : "factory-guardrails agent-hook";
}

/** Ours in either form install writes — so a layout change re-points it, never doubles it. */
const isOurs = (hook) => /(^|\/)factory-guardrails agent-hook$/.test(String(hook?.command ?? ""));
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The parsed settings, `{}` when absent, or null when it is not a shape we can edit safely. */
function readSettings(root) {
  const path = join(root, SETTINGS);
  if (!existsSync(path)) return {};
  let s;
  try {
    s = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isObject(s)) return null;
  const pre = s.hooks?.PreToolUse;
  if (s.hooks !== undefined && (!isObject(s.hooks) || (pre !== undefined && !Array.isArray(pre)))) return null;
  return s;
}

const findOurs = (s) =>
  (s?.hooks?.PreToolUse ?? []).flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : [])).find(isOurs);

const writeSettings = (root, s) => {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, SETTINGS), `${JSON.stringify(s, null, 2)}\n`);
};

function installAgentHook(root) {
  const settings = readSettings(root);
  if (!settings) {
    // Never clobber a file we cannot parse, and never fail `prepare` over it.
    console.warn(`guardrails: ${SETTINGS} is not a settings object — agent hook NOT wired. Fix it and re-run install.`);
    return;
  }
  const command = agentHookCommand(root);
  const ours = findOurs(settings);
  // No write at all when nothing changes: re-running install must leave no diff.
  if (ours?.command === command) {
    console.log(`guardrails: agent hook already wired (${SETTINGS}).`);
    return;
  }
  if (ours) ours.command = command;
  else {
    settings.hooks ??= {};
    (settings.hooks.PreToolUse ??= []).push({ matcher: "Bash", hooks: [{ type: "command", command }] });
  }
  writeSettings(root, settings);
  console.log(`guardrails: agent hook wired in ${SETTINGS} (${command}).`);
}

function uninstallAgentHook(root) {
  const settings = readSettings(root);
  if (!findOurs(settings)) return;
  // Only the groups our removal emptied go; everything else stays as it was.
  const kept = [];
  for (const group of settings.hooks.PreToolUse) {
    const rest = Array.isArray(group?.hooks) ? group.hooks.filter((hook) => !isOurs(hook)) : null;
    if (rest === null || rest.length === group.hooks.length) kept.push(group);
    else if (rest.length) kept.push({ ...group, hooks: rest });
  }
  if (kept.length) settings.hooks.PreToolUse = kept;
  else delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  writeSettings(root, settings);
  console.log(`guardrails: agent hook removed from ${SETTINGS}.`);
}

/** FAIL-OPEN like the script itself: if bash cannot even start, the call is allowed. */
function agentHook() {
  const run = spawnSync("bash", [AGENT_HOOK], { stdio: ["pipe", "inherit", "inherit"], input: readFileSync(0) });
  process.exit(run.error || run.status === null ? 0 : run.status);
}

function status() {
  const root = repoRoot();
  const current = tryGit(["config", "--local", "core.hooksPath"], root);
  const target = relative(root, HOOKS_DIR) || ".";
  const agent = findOurs(readSettings(root));
  const installed = current === target && Boolean(agent);
  console.log(`guardrails: ${installed ? "INSTALLED" : "NOT installed"}`);
  console.log(`  core.hooksPath: ${current ?? "(unset)"}`);
  console.log(`  this package:   ${target}`);
  console.log(`  agent hook:     ${agent ? agent.command : `(none in ${SETTINGS})`}`);
  const local = join(root, ".guardrails");
  console.log(`  repo hooks:     ${existsSync(local) ? local : "(none — .guardrails/ absent)"}`);
  process.exit(installed ? 0 : 1);
}

// REPO DEFAULTS — the one half that is not about a clone. Settings live on GitHub,
// so this needs a token with admin rights, which a clone or a CI run does not
// have: it is run once per repo by a person, never from `prepare`.
//
// delete_branch_on_merge: GitHub retargets a stacked pull request onto the next
// base only when its base branch is DELETED on merge. With the setting off, the
// child of a merged parent merges into a dead branch instead.
const REPO_DEFAULTS = { delete_branch_on_merge: true };
const ADMIN_NEEDED =
  'needs admin rights on the repository (a fine-grained token needs "Administration: write"; a classic token needs the "repo" scope, held by an admin)';

function fail(message) {
  console.error(`guardrails: ${message}`);
  process.exit(1);
}

/** owner/repo from the argument, else from the `origin` remote of cwd. */
function targetRepo(arg) {
  const source = arg ?? tryGit(["remote", "get-url", "origin"], process.cwd());
  const m = source?.match(/^(?:.*[:/])?([^/:\s]+)\/([^/:\s]+?)(?:\.git)?\/?$/);
  if (!m) fail("repo-defaults: pass owner/repo, or run it in a clone whose origin remote is on GitHub.");
  return `${m[1]}/${m[2]}`;
}

/** GH_TOKEN / GITHUB_TOKEN as gh itself reads them, else the gh CLI's login. */
function githubToken() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

async function repoDefaults(arg) {
  const repo = targetRepo(arg);
  const token = githubToken();
  if (!token) fail("repo-defaults: no GitHub token. Set GH_TOKEN or GITHUB_TOKEN, or run `gh auth login`.");
  const url = `${process.env.GITHUB_API_URL || "https://api.github.com"}/repos/${repo}`;
  const call = async (method, body) => {
    const res = await fetch(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "factory-guardrails",
        "x-github-api-version": "2022-11-28",
        ...(body && { "content-type": "application/json" }),
      },
      body: body && JSON.stringify(body),
    }).catch((err) => fail(`repo-defaults: cannot reach ${url}: ${err.message}`));
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };

  const read = await call("GET");
  if (read.status !== 200) fail(`repo-defaults: cannot read ${repo} (${read.status} ${read.json.message ?? ""}).`);
  const wrong = [];
  for (const [key, want] of Object.entries(REPO_DEFAULTS)) {
    if (read.json[key] === want) console.log(`guardrails: ${repo}: ${key} already ${want}.`);
    else wrong.push([key, want]);
  }
  if (!wrong.length) return;

  const patch = Object.fromEntries(wrong);
  const write = await call("PATCH", patch);
  // Success is the value GitHub reads back, not the status code: a refusal
  // carries no settings, and a 200 can leave a setting alone.
  if (wrong.some(([key, want]) => write.json[key] !== want)) {
    const said = write.json.message ? ` GitHub said: ${write.status} ${write.json.message}` : ` (HTTP ${write.status})`;
    fail(`repo-defaults: could not set ${Object.keys(patch).join(", ")} on ${repo}: the token ${ADMIN_NEEDED}.${said}`);
  }
  for (const [key, want] of wrong) console.log(`guardrails: ${repo}: ${key} ${read.json[key] ?? "(unset)"} -> ${want}.`);
}

const HELP = `factory-guardrails — the shop's shared git hooks and agent guard

  install     point core.hooksPath at this package's hooks, and wire the
              agent hook into .claude/settings.json (both idempotent)
  uninstall   restore core.hooksPath; remove only the agent-hook entry
  status      report both halves (exit 1 if either is not wired)
  agent-hook  the Claude Code PreToolUse guard install wires (tool call on stdin)
  repo-defaults [owner/repo]
              turn on GitHub's "automatically delete head branches" for the
              repo (default: the origin remote); needs an admin token, so run
              it by hand once per repo, never from prepare

Adopt in a repo by adding ONE line to package.json:

  "scripts": { "prepare": "factory-guardrails install" }

Repo-specific checks live in .guardrails/<hook-name> (executable); the shared
hooks run them after the shared rule passes, so adopting this does not cost a
repo its own hooks.
`;

const cmd = process.argv[2] ?? "install";
if (cmd === "install") install();
else if (cmd === "uninstall") uninstall();
else if (cmd === "status") status();
else if (cmd === "agent-hook") agentHook();
else if (cmd === "repo-defaults") await repoDefaults(process.argv[3]);
else {
  console.log(HELP);
  process.exit(cmd === "--help" || cmd === "-h" ? 0 : 1);
}

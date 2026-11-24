// The installer, exercised as a PROCESS against real throwaway git repositories.
//
// Not a unit test of its internals: what can break here is the interaction with
// git's own config — idempotency, what "previous value" means on a second run,
// and whether uninstall genuinely puts back what was there. All of that is only
// true or false against a real `git config`.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("./bin/factory-guardrails.mjs", import.meta.url));
const HOOKS_DIR = fileURLToPath(new URL("./hooks", import.meta.url));

/**
 * The parent environment with git's repo-location pointers stripped.
 *
 * git exports GIT_DIR (and friends) into every hook it runs, and this suite can
 * itself run from a pre-push hook. Those variables outrank `cwd`, so without
 * this every git call below would act on the REAL repo rather than the temp
 * one it just created — the leak that once wrote ~85 junk commits into a real
 * repository.
 */
function gitEnv() {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  return env;
}

const made = [];
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "guardrails-"));
  made.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: gitEnv() });
  return dir;
}

const cli = (dir, ...argv) =>
  execFileSync(process.execPath, [CLI, ...argv], { cwd: dir, env: gitEnv(), encoding: "utf8" });

const hooksPath = (dir) => {
  try {
    return execFileSync("git", ["config", "--local", "core.hooksPath"], {
      cwd: dir,
      env: gitEnv(),
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
};

afterAll(() => {
  for (const dir of made) {
    try {
      execFileSync("rm", ["-rf", dir]);
    } catch {
      /* best effort */
    }
  }
});

describe("factory-guardrails install", () => {
  it("points core.hooksPath at the package's hooks", () => {
    const dir = tempRepo();
    cli(dir, "install");
    // Relative to the repo, and it really resolves to the shipped directory.
    // realpath on both sides: on macOS /tmp is a symlink to /private/tmp, so the
    // comparison is otherwise about symlink resolution rather than about the
    // installer.
    const set = hooksPath(dir);
    expect(set).toBeTruthy();
    expect(realpathSync(join(dir, set))).toBe(realpathSync(HOOKS_DIR));
  });

  it("is idempotent — a second install changes nothing and saves no bogus previous", () => {
    const dir = tempRepo();
    cli(dir, "install");
    const first = hooksPath(dir);
    const out = cli(dir, "install");
    expect(out).toMatch(/already installed/);
    expect(hooksPath(dir)).toBe(first);

    // The trap this pins: saving OUR path as the "previous" value on the second
    // run, so uninstall would restore us to ourselves and never come off.
    cli(dir, "uninstall");
    expect(hooksPath(dir)).toBeNull();
  });

  it("restores the repo's own hooksPath on uninstall", () => {
    const dir = tempRepo();
    execFileSync("git", ["config", "--local", "core.hooksPath", ".myhooks"], {
      cwd: dir,
      env: gitEnv(),
    });
    cli(dir, "install");
    expect(hooksPath(dir)).not.toBe(".myhooks");
    cli(dir, "uninstall");
    expect(hooksPath(dir)).toBe(".myhooks");
  });

  it("unsets rather than leaving a dangling path when there was nothing before", () => {
    // A core.hooksPath pointing at a package that is no longer installed disables
    // every hook SILENTLY, which is worse than having none.
    const dir = tempRepo();
    cli(dir, "install");
    cli(dir, "uninstall");
    expect(hooksPath(dir)).toBeNull();
  });

  it("exits 0 outside a git repository, so `prepare` cannot break an install", () => {
    const dir = mkdtempSync(join(tmpdir(), "guardrails-nogit-"));
    made.push(dir);
    const out = execFileSync(process.execPath, [CLI, "install"], {
      cwd: dir,
      env: { ...gitEnv(), GIT_CEILING_DIRECTORIES: tmpdir() },
      encoding: "utf8",
    });
    expect(out).toMatch(/not inside a git repository/);
  });

  it("status reports installed / not installed by exit code", () => {
    const dir = tempRepo();
    expect(() => cli(dir, "status")).toThrow(); // exit 1 before install
    cli(dir, "install");
    expect(cli(dir, "status")).toMatch(/INSTALLED/);
  });
});

describe("the shared hooks hand control back to the repo", () => {
  /** Run a shipped hook in `dir`, returning its exit code. */
  function runHook(dir, name, args = []) {
    try {
      execFileSync("/bin/sh", [join(HOOKS_DIR, name), ...args], {
        cwd: dir,
        env: gitEnv(),
        stdio: "pipe",
      });
      return 0;
    } catch (err) {
      return err.status ?? 1;
    }
  }

  /** A repo whose own hook records that it ran, then exits `code`. */
  function withLocalHook(name, code) {
    const dir = tempRepo();
    mkdirSync(join(dir, ".guardrails"), { recursive: true });
    const p = join(dir, ".guardrails", name);
    writeFileSync(p, `#!/bin/sh\ntouch "${join(dir, `${name}.ran`)}"\nexit ${code}\n`);
    chmodSync(p, 0o755);
    return dir;
  }

  // The whole reason a shared pre-push exists. core.hooksPath is a SINGLE path,
  // so adopting this package would otherwise silently delete a repo's own hooks
  // — adopting a guardrail would be a downgrade.
  it("pre-push runs the repo's own hook and returns its verdict", () => {
    expect(runHook(withLocalHook("pre-push", 0), "pre-push")).toBe(0);
    expect(runHook(withLocalHook("pre-push", 1), "pre-push")).toBe(1);
  });

  it("pre-push passes when a repo has no hook of its own", () => {
    expect(runHook(tempRepo(), "pre-push")).toBe(0);
  });

  it("commit-msg enforces the shared rule BEFORE delegating", () => {
    const dir = withLocalHook("commit-msg", 0);
    const msg = join(dir, "MSG");

    // No ref: rejected by the shared rule, and the repo's hook never gets a say.
    writeFileSync(msg, "fix: no ticket here\n");
    expect(runHook(dir, "commit-msg", [msg])).toBe(1);

    // With a ref: shared rule passes, repo hook runs.
    writeFileSync(msg, "fix: something [ABC-300]\n");
    expect(runHook(dir, "commit-msg", [msg])).toBe(0);
  });

  it("commit-msg fails when the repo's own hook fails, even with a valid ref", () => {
    const dir = withLocalHook("commit-msg", 3);
    const msg = join(dir, "MSG");
    writeFileSync(msg, "fix: something [ABC-300]\n");
    expect(runHook(dir, "commit-msg", [msg])).toBe(3);
  });
});

describe("the path guard: secrets and build output never staged or pushed", () => {
  const ZERO = "0000000000000000000000000000000000000000";
  const ALLOW = "GUARDRAILS_ALLOW_PATHS=1";
  const who = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  const g = (dir, ...args) => execFileSync("git", args, { cwd: dir, env: { ...gitEnv(), ...who }, encoding: "utf8" }).trim();

  /** Run a shipped hook in `dir` with `input` on stdin: { status, stderr }. */
  function hook(dir, name, { input = "", env = {} } = {}) {
    const run = spawnSync("/bin/sh", [join(HOOKS_DIR, name)], { cwd: dir, env: { ...gitEnv(), ...env }, input, encoding: "utf8" });
    return { status: run.status, stderr: run.stderr };
  }

  /** Create each path (a file, its parent directories made) and force-stage it past any .gitignore. */
  function stage(dir, ...paths) {
    for (const p of paths) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), `stub-value for ${p}\n`);
    }
    g(dir, "add", "-f", "--", ...paths);
  }

  const SECRETS = [
    ".env", ".env.development", "app/.env", "app/.env.production", "my-serviceAccount.json", "gcp-service-account.json",
    "firebase-adminsdk-x1.json", "certs/server.pem", "id_rsa", "id_rsa.pub", "deploy/id_rsa", "aws/credentials.json", "tls/server.key",
  ];
  const BULK = [".next/x.js", ".next-old/x.js", "node_modules/x/index.js", "dist/x.js", "build/x.js", "coverage/lcov.info", ".turbo/x"];
  // Logs are refused at any depth, like secrets, and each is named by its full path.
  const LOGS = ["npm-debug.log", "logs/app.log", "apps/web/logs/dev.log"];

  it.each([...SECRETS, ...BULK, ...LOGS])("pre-commit refuses a staged %s, naming it and the override", (path) => {
    const dir = tempRepo();
    stage(dir, path);
    const run = hook(dir, "pre-commit");
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(path.includes("/") && BULK.includes(path) ? `${path.split("/")[0]}/` : path);
    expect(run.stderr).toContain(ALLOW);
  });

  it("pre-commit lets templates and look-alike source through", () => {
    const dir = tempRepo();
    stage(dir, ".env.example", "app/.env.sample", ".env.template", "README.md", "src/dist.ts", "src/build/index.ts", "docs/keys.md", "src/log.ts", "logs/app.log.example");
    expect(hook(dir, "pre-commit")).toEqual({ status: 0, stderr: "" });
  });

  it("pre-commit lets the override through, and lets a secret be untracked", () => {
    const dir = tempRepo();
    stage(dir, ".env");
    expect(hook(dir, "pre-commit", { env: { GUARDRAILS_ALLOW_PATHS: "1" } }).status).toBe(0);
    g(dir, "commit", "-qm", "seed", "--no-verify");
    g(dir, "rm", "-q", "--cached", ".env");
    expect(hook(dir, "pre-commit").status).toBe(0);
  });

  it("pre-commit refuses BEFORE delegating, then hands a clean commit to .guardrails/pre-commit", () => {
    const dir = tempRepo();
    mkdirSync(join(dir, ".guardrails"));
    writeFileSync(join(dir, ".guardrails", "pre-commit"), `#!/bin/sh\ntouch "${join(dir, "pre-commit.ran")}"\nexit 4\n`);
    chmodSync(join(dir, ".guardrails", "pre-commit"), 0o755);
    stage(dir, ".env");
    expect(hook(dir, "pre-commit").status).toBe(1);
    expect(existsSync(join(dir, "pre-commit.ran"))).toBe(false);
    g(dir, "rm", "-q", "--cached", ".env");
    stage(dir, "src/app.js");
    expect(hook(dir, "pre-commit").status).toBe(4);
    expect(existsSync(join(dir, "pre-commit.ran"))).toBe(true);
  });

  /** A repo with one commit pushed to a bare remote: { dir, base }. */
  function pushedRepo() {
    const dir = tempRepo();
    const remote = mkdtempSync(join(tmpdir(), "guardrails-remote-"));
    made.push(remote);
    g(remote, "init", "-q", "--bare");
    stage(dir, "README.md");
    g(dir, "commit", "-qm", "seed", "--no-verify");
    g(dir, "remote", "add", "origin", remote);
    g(dir, "push", "-q", "origin", "HEAD:refs/heads/main");
    return { dir, base: g(dir, "rev-parse", "HEAD") };
  }

  /** Commit `paths` past every hook, as a hand commit or an inherited branch would. */
  function commitPast(dir, ...paths) {
    stage(dir, ...paths);
    g(dir, "commit", "-qm", "work", "--no-verify");
    return g(dir, "rev-parse", "HEAD");
  }

  it("pre-push refuses an outgoing commit that carries a secret, naming it and the override", () => {
    const { dir, base } = pushedRepo();
    const head = commitPast(dir, ".env");
    const run = hook(dir, "pre-push", { input: `refs/heads/main ${head} refs/heads/main ${base}\n` });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(".env");
    expect(run.stderr).toContain(ALLOW);
    expect(hook(dir, "pre-push", { input: `refs/heads/main ${head} refs/heads/main ${base}\n`, env: { GUARDRAILS_ALLOW_PATHS: "1" } }).status).toBe(0);
  });

  it("pre-push refuses an outgoing commit that carries a nested log", () => {
    const { dir, base } = pushedRepo();
    const head = commitPast(dir, "logs/app.log");
    const run = hook(dir, "pre-push", { input: `refs/heads/main ${head} refs/heads/main ${base}\n` });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("logs/app.log");
  });

  it("pre-push checks every outgoing commit, so a secret added then deleted still refuses", () => {
    const { dir } = pushedRepo();
    commitPast(dir, "dist/x.js");
    g(dir, "rm", "-rq", "dist");
    g(dir, "commit", "-qm", "drop", "--no-verify");
    const head = g(dir, "rev-parse", "HEAD");
    // A new branch: git sends the zero sha as the remote's.
    const run = hook(dir, "pre-push", { input: `refs/heads/topic ${head} refs/heads/topic ${ZERO}\n` });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("dist/");
  });

  it("pre-push ignores what the remote already has, an untracking commit and a branch deletion", () => {
    const { dir } = pushedRepo();
    const old = commitPast(dir, ".env.development");
    g(dir, "push", "-q", "--no-verify", "origin", "HEAD:refs/heads/main");
    g(dir, "rm", "-q", "--cached", ".env.development");
    const head = commitPast(dir, "src/app.js");
    expect(hook(dir, "pre-push", { input: `refs/heads/main ${head} refs/heads/main ${old}\n` }).status).toBe(0);
    // A new branch sends the zero sha, so what the remote has comes from the remote-tracking refs.
    expect(hook(dir, "pre-push", { input: `refs/heads/topic ${head} refs/heads/topic ${ZERO}\n` }).status).toBe(0);
    expect(hook(dir, "pre-push", { input: `(delete) ${ZERO} refs/heads/gone ${old}\n` })).toEqual({ status: 0, stderr: "" });
  });

  it("pre-push hands git's ref list to .guardrails/pre-push unchanged", () => {
    const { dir, base } = pushedRepo();
    const p = join(dir, ".guardrails", "pre-push");
    mkdirSync(join(dir, ".guardrails"));
    writeFileSync(p, `#!/bin/sh\ncat > "${join(dir, "seen")}"\nexit 5\n`);
    chmodSync(p, 0o755);
    const head = commitPast(dir, "src/app.js");
    const refs = `refs/heads/main ${head} refs/heads/main ${base}\nrefs/tags/v1 ${head} refs/tags/v1 ${ZERO}\n`;
    expect(hook(dir, "pre-push", { input: refs }).status).toBe(5);
    expect(readFileSync(join(dir, "seen"), "utf8")).toBe(refs);
  });
});

describe("the Claude seat half", () => {
  const LOCAL = '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/factory-guardrails agent-hook';
  const GLOBAL = "factory-guardrails agent-hook";
  const entry = (command) => ({ matcher: "Bash", hooks: [{ type: "command", command }] });
  const settingsPath = (dir) => join(dir, ".claude", "settings.json");
  const settings = (dir) => JSON.parse(readFileSync(settingsPath(dir), "utf8"));

  /** A repo with the package installed locally, as `npm i -D` leaves it. */
  function withLocalBin(dir) {
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "factory-guardrails"), "");
    return dir;
  }

  function seed(dir, value) {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(settingsPath(dir), JSON.stringify(value, null, 2));
  }

  /** Exit code of `cli(dir, "status")`; the CLI exits 1 for "not wired". */
  function statusCode(dir) {
    return spawnSync(process.execPath, [CLI, "status"], { cwd: dir, env: gitEnv() }).status;
  }

  it("install invokes the package from node_modules/.bin by path, copying nothing", () => {
    const dir = withLocalBin(tempRepo());
    cli(dir, "install");
    expect(settings(dir)).toEqual({ hooks: { PreToolUse: [entry(LOCAL)] } });
    expect(existsSync(join(dir, ".claude", "hooks"))).toBe(false);
  });

  it("install falls back to the bare command where the package is global", () => {
    const dir = tempRepo();
    cli(dir, "install");
    expect(settings(dir)).toEqual({ hooks: { PreToolUse: [entry(GLOBAL)] } });
  });

  it("a second install leaves the file byte-for-byte unchanged", () => {
    const dir = withLocalBin(tempRepo());
    cli(dir, "install");
    const first = readFileSync(settingsPath(dir), "utf8");
    cli(dir, "install");
    expect(readFileSync(settingsPath(dir), "utf8")).toBe(first);
  });

  it("install re-points its own entry rather than adding a second one", () => {
    const dir = tempRepo();
    cli(dir, "install");
    withLocalBin(dir);
    cli(dir, "install");
    expect(settings(dir)).toEqual({ hooks: { PreToolUse: [entry(LOCAL)] } });
  });

  const theirs = {
    model: "opus",
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: {
      PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "./lint.sh" }] }],
      PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./log.sh" }] }],
    },
  };

  it("install is additive: the repo's own hooks and keys survive", () => {
    const dir = withLocalBin(tempRepo());
    seed(dir, theirs);
    cli(dir, "install");
    expect(settings(dir)).toEqual({
      ...theirs,
      hooks: { ...theirs.hooks, PreToolUse: [...theirs.hooks.PreToolUse, entry(LOCAL)] },
    });
  });

  it("uninstall removes only the entry install added", () => {
    const dir = withLocalBin(tempRepo());
    seed(dir, theirs);
    cli(dir, "install");
    expect(settings(dir).hooks.PreToolUse).toContainEqual(entry(LOCAL)); // not vacuous
    cli(dir, "uninstall");
    expect(settings(dir)).toEqual(theirs);
  });

  it("install leaves an unparseable settings file alone rather than clobbering it", () => {
    const dir = tempRepo();
    mkdirSync(join(dir, ".claude"));
    writeFileSync(settingsPath(dir), "{ not json");
    cli(dir, "install");
    expect(readFileSync(settingsPath(dir), "utf8")).toBe("{ not json");
    expect(statusCode(dir)).toBe(1);
  });

  it("status reports both halves and exits 1 if either is unwired", () => {
    const dir = withLocalBin(tempRepo());
    cli(dir, "install");
    const out = cli(dir, "status");
    expect(out).toMatch(/core\.hooksPath: \S/);
    expect(out).toContain(`agent hook:     ${LOCAL}`);

    rmSync(settingsPath(dir));
    expect(statusCode(dir)).toBe(1);
    // The git half is already wired here, so this also proves install does not
    // stop at "already installed" before wiring the Claude half.
    cli(dir, "install");
    expect(statusCode(dir)).toBe(0);

    execFileSync("git", ["config", "--local", "--unset", "core.hooksPath"], { cwd: dir, env: gitEnv() });
    expect(statusCode(dir)).toBe(1);
  });
});

describe("factory-guardrails agent-hook", () => {
  /** Run the guard as Claude Code does: tool call as JSON on stdin. */
  function guard(dir, command, env = {}) {
    cli(dir, "install");
    const bin = mkdtempSync(join(tmpdir(), "guardrails-jq-"));
    made.push(bin);
    writeFileSync(join(bin, "jq"), '#!/usr/bin/env node\nconst input = JSON.parse(require("fs").readFileSync(0, "utf8"));\nif (process.argv.includes(".tool_input.command // empty")) console.log(input.tool_input?.command ?? "");\n');
    chmodSync(join(bin, "jq"), 0o755);
    return spawnSync(process.execPath, [CLI, "agent-hook"], {
      cwd: dir,
      env: { ...gitEnv(), PATH: env.PATH ?? `${bin}:${process.env.PATH}`, CLAUDE_PROJECT_DIR: dir, ...env },
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
      encoding: "utf8",
    });
  }

  /** A PATH holding everything the guard needs except `missing`. */
  function pathWithout(missing) {
    const bin = mkdtempSync(join(tmpdir(), "guardrails-bin-"));
    made.push(bin);
    for (const tool of ["bash", "cat", "tr", "grep", "sed", "git", "jq"]) {
      if (tool === missing) continue;
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (found) symlinkSync(found, join(bin, tool));
    }
    return bin;
  }

  /** A repo whose .guardrails/block-secret-print saves its stdin, then exits `code`. */
  function withLocalGuard(code) {
    const dir = tempRepo();
    mkdirSync(join(dir, ".guardrails"));
    const p = join(dir, ".guardrails", "block-secret-print");
    writeFileSync(p, `#!/bin/sh\ncat > "${join(dir, "seen")}"\nexit ${code}\n`);
    chmodSync(p, 0o755);
    return dir;
  }

  it("blocks printing a secret file (exit 2) and allows an ordinary command", () => {
    const dir = tempRepo();
    const blocked = guard(dir, "cat .env");
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/BLOCKED by secret-print guard/);
    expect(guard(dir, "ls -la").status).toBe(0);
  });

  it("hands the tool call to .guardrails/block-secret-print and returns its verdict", () => {
    const dir = withLocalGuard(7);
    expect(guard(dir, "ls").status).toBe(7);
    const seen = JSON.parse(readFileSync(join(dir, "seen"), "utf8"));
    expect(seen).toEqual({ tool_name: "Bash", tool_input: { command: "ls" } });
  });

  it("enforces the shared rule BEFORE the repo's own guard gets a say", () => {
    const dir = withLocalGuard(0);
    expect(guard(dir, "cat .env").status).toBe(2);
    expect(existsSync(join(dir, "seen"))).toBe(false);
  });

  // Fail-open is a design property: a guard that can brick every shell gets
  // switched off, and then it guards nothing.
  it("fails OPEN without jq", () => {
    expect(guard(tempRepo(), "cat .env", { PATH: pathWithout("jq") }).status).toBe(0);
  });

  it("fails OPEN when bash cannot be started", () => {
    expect(guard(tempRepo(), "cat .env", { PATH: pathWithout("bash") }).status).toBe(0);
  });
});

describe("factory-guardrails repo-defaults", () => {
  /**
   * A stand-in for the GitHub REST API on localhost. The CLI is pointed at it
   * through GITHUB_API_URL, so no test ever reaches GitHub. `repo` is what a
   * GET returns; `patch` answers a PATCH, by default by applying it.
   */
  async function stubGitHub({ repo, get = 200, patch }) {
    const seen = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : null;
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: parsed });
        const [status, json] =
          req.method === "PATCH" ? (patch ?? (() => [200, { ...repo, ...parsed }]))(parsed) : [get, repo];
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
  }

  /** Run the CLI WITHOUT blocking, so the in-process stub can answer it. */
  function run(dir, api, argv = [], env = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, "repo-defaults", ...argv], {
        cwd: dir,
        env: { ...gitEnv(), GITHUB_API_URL: api.url, GH_TOKEN: "stub-token", GITHUB_TOKEN: "", ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  }

  const admin = { admin: true, maintain: true, push: true, triage: true, pull: true };

  it("changes nothing when the setting is already on", async () => {
    const api = await stubGitHub({ repo: { full_name: "abc-org/example", delete_branch_on_merge: true, permissions: admin } });
    try {
      const out = await run(tempRepo(), api, ["abc-org/example"]);
      expect(out.status).toBe(0);
      expect(out.stdout).toMatch(/delete_branch_on_merge already true/);
      expect(api.seen.map((r) => r.method)).toEqual(["GET"]);
    } finally {
      api.close();
    }
  });

  it("turns the setting on with one PATCH, learning the repo from the origin remote", async () => {
    const api = await stubGitHub({ repo: { full_name: "abc-org/example", delete_branch_on_merge: false, permissions: admin } });
    const dir = tempRepo();
    execFileSync("git", ["remote", "add", "origin", "git@github.com:abc-org/example.git"], { cwd: dir, env: gitEnv() });
    try {
      const out = await run(dir, api);
      expect(out.status).toBe(0);
      expect(out.stdout).toMatch(/abc-org\/example: delete_branch_on_merge false -> true/);
      const patches = api.seen.filter((r) => r.method === "PATCH");
      expect(patches).toEqual([
        { method: "PATCH", url: "/repos/abc-org/example", auth: "Bearer stub-token", body: { delete_branch_on_merge: true } },
      ]);
    } finally {
      api.close();
    }
  });

  it("exits non-zero naming the missing permission when the token cannot write settings", async () => {
    const api = await stubGitHub({
      repo: { full_name: "abc-org/example", permissions: { ...admin, admin: false } },
      patch: () => [403, { message: "Must have admin rights to Repository." }],
    });
    try {
      const out = await run(tempRepo(), api, ["abc-org/example"]);
      expect(out.status).not.toBe(0);
      expect(out.stderr).toMatch(/admin/i);
      expect(out.stderr).toMatch(/Administration: write/);
      expect(out.stderr).toMatch(/Must have admin rights to Repository/);
    } finally {
      api.close();
    }
  });

  it("names what is missing before it writes: the repo, the token, or read access", async () => {
    const api = await stubGitHub({ get: 404, repo: { message: "Not Found" } });
    try {
      // No argument and no origin remote: nothing to act on.
      const noRepo = await run(tempRepo(), api);
      expect(noRepo.status).not.toBe(0);
      expect(noRepo.stderr).toMatch(/pass owner\/repo/);

      // No token in the environment and no gh on PATH.
      const empty = mkdtempSync(join(tmpdir(), "guardrails-nogh-"));
      made.push(empty);
      const noToken = await run(tempRepo(), api, ["abc-org/example"], { GH_TOKEN: "", PATH: empty });
      expect(noToken.status).not.toBe(0);
      expect(noToken.stderr).toMatch(/no GitHub token/);

      const unreadable = await run(tempRepo(), api, ["abc-org/example"]);
      expect(unreadable.status).not.toBe(0);
      expect(unreadable.stderr).toMatch(/cannot read abc-org\/example \(404 Not Found\)/);
      expect(api.seen.map((r) => r.method)).toEqual(["GET"]);
    } finally {
      api.close();
    }
  });

  it("fails, rather than claiming success, when GitHub accepts the PATCH but ignores the setting", async () => {
    const api = await stubGitHub({
      repo: { full_name: "abc-org/example", delete_branch_on_merge: false, permissions: admin },
      patch: () => [200, { full_name: "abc-org/example", delete_branch_on_merge: false }],
    });
    try {
      const out = await run(tempRepo(), api, ["abc-org/example"]);
      expect(out.status).not.toBe(0);
      expect(out.stderr).toMatch(/Administration: write/);
    } finally {
      api.close();
    }
  });
});

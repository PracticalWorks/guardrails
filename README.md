# @practicalworks/guardrails

**Shared git hooks, and a guard for your AI coding agent, installed as one dev dependency.** A rule you agree on holds in every repo, for every contributor, human or agent, and a fix reaches all of them through a version bump instead of one pull request per repo.

[![npm](https://img.shields.io/npm/v/@practicalworks/guardrails)](https://www.npmjs.com/package/@practicalworks/guardrails)
[![ci](https://github.com/PracticalWorks/guardrails/actions/workflows/ci.yml/badge.svg)](https://github.com/PracticalWorks/guardrails/actions/workflows/ci.yml)
[![MIT licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)

What you get:

- **A ticket reference on every commit** (`[ABC-123]` or a `Refs:` trailer), any project key.
- **No secret or build directory committed.** A staged `.env`, private key or credentials file, or a `dist/` or `node_modules/`, is refused at commit and again at push.
- **Your own hooks kept.** Most shared-hooks setups silently replace a repo's existing hooks. This one hands control back to yours in `.guardrails/`.
- **An AI agent that can't print your secrets.** A [Claude Code](https://docs.claude.com/en/docs/claude-code) `PreToolUse` hook blocks environment dumps and printing a dotenv or credentials file, while still letting the agent read and edit those files.

No build step, no runtime dependencies, about 15 kB.

## Install

```sh
npm i -D @practicalworks/guardrails
```

Then one line in `package.json`:

```json
{
  "scripts": {
    "prepare": "factory-guardrails install"
  }
}
```

That's it. `prepare` runs on install, so everyone who installs the repo gets the hooks and the agent guard — including CI, and including automated contributors that install dependencies before they work. That last part is the reason this is a dependency rather than a file you copy: an agent working in your repo is bound by the same hook a human is, from the same version, with nothing extra to configure.

Last, once per repo, set its GitHub defaults (this needs an admin token, so it is a step a person runs, not part of `prepare`):

```sh
npx factory-guardrails repo-defaults            # the repo of the origin remote
npx factory-guardrails repo-defaults owner/repo # or name it
```

Today that is one setting: **automatically delete head branches** (`delete_branch_on_merge`). GitHub retargets a stacked pull request onto the next base only when its base branch is deleted on merge; with the setting off, the child of a merged parent merges into a dead branch. The command reads the repo first, writes only a setting that is off, and prints each one it changed or found already on, so a second run changes nothing.

It authenticates the way `gh` does: `GH_TOKEN` or `GITHUB_TOKEN`, else your `gh auth login`. A token that cannot write repo settings makes it exit non-zero and name the permission it lacks: "Administration: write" on a fine-grained token, or the `repo` scope held by a repo admin on a classic one.

## What the hooks do

**`commit-msg`** — requires an issue-tracker reference in the commit message.

```
fix: cron runs in the wrong tz  [ABC-123]      ✓
feat: close the loop  [ABC-123, ABC-124]       ✓
Refs: ABC-123                                  ✓  (trailer)
chore: tidy up                                 ✗
```

Any project key works (`[A-Z]{1,7}-\d+`). Merges, reverts and `fixup!`/`squash!` pass through — they carry their parent's reference.

One limitation, stated plainly because it matters: this is a client-side hook, so it cannot see a **forge-side squash-merge**, whose subject is composed by the server from the pull request title. Those bypass it. If that matters to you, pair this with branch protection or an after-the-fact audit of your default branch — a client hook physically cannot cover that path, and any tool claiming otherwise is wrong.

**`pre-commit`** — refuses a commit that stages a secret or build output, naming each path:

| Kind | Paths |
|---|---|
| secret | `.env`, `.env.*` (at any depth), `*serviceAccount*.json`, `*service-account*.json`, `*adminsdk*.json`, `*.pem`, `id_rsa*`, `*credentials.json`, `*.key` |
| build output | a top-level `.next*`, `node_modules`, `dist`, `build`, `coverage`, `.turbo` or `*.log` |

Templates are allowed: `*.example`, `*.sample` and `*.template`, so `.env.example` commits. Build output is judged by the top-level directory only, so `src/build/` is still source. Deleting a tracked secret is always allowed, because that is the fix. To commit a listed path on purpose, override once with `GUARDRAILS_ALLOW_PATHS=1 git commit ...`.

**`pre-push`** — the same check on every commit about to leave the machine, then your repo's own pre-push. Pushing is checked as well as committing because a secret committed with `--no-verify`, or inherited on a branch from another clone, reaches the remote through push. Each outgoing commit is checked, not the net diff, so a secret added and then deleted on the branch is still refused: it would still be in the remote's history. The override is `GUARDRAILS_ALLOW_PATHS=1 git push ...`.

## Keeping your own hooks

`core.hooksPath` is a **single path**. Pointing it at this package means git stops looking anywhere else — so naively adopting a shared hooks package deletes whatever hooks your repo already had, silently, as the direct result of adding a guardrail.

So every hook here hands control back. Put your own checks in `.guardrails/`:

```
.guardrails/
├── commit-msg           runs after the shared ticket rule passes
├── pre-commit           runs after the shared path check passes
├── pre-push             runs after the shared path check passes, with git's ref list on stdin
└── block-secret-print   runs after the shared secret-print guard allows
```

Each hook enforces the shared rule first, then delegates, so you can add repo-specific rules without losing the shared one. Beyond the path check, `pre-push` has no shared rule: what a repo should run before pushing is its own build and its own tests, which means nothing in a repo with different scripts. Your `.guardrails/pre-push` gets the same ref list on stdin that git gave the shared hook.

## CLI

```sh
factory-guardrails install      # point core.hooksPath here + wire the agent hook (idempotent)
factory-guardrails uninstall    # restore core.hooksPath; remove only our agent-hook entry
factory-guardrails status       # report both halves (exit 1 if either is not wired)
factory-guardrails agent-hook   # the PreToolUse guard itself; install wires it, you never call it
factory-guardrails repo-defaults [owner/repo]  # set the repo's GitHub defaults (admin token; idempotent)
```

`install` saves your previous `core.hooksPath` once, so `uninstall` genuinely puts it back. If there was nothing before, `uninstall` unsets it rather than leaving a path pointing at a package that may no longer be installed — a dangling `core.hooksPath` disables every hook silently, which is worse than having none.

Outside a git repository it exits 0 and does nothing, because a `prepare` script that fails takes `npm install` down with it.

## The Claude Code guard

`install` also writes one `PreToolUse` entry into `.claude/settings.json`, which blocks commands that would print secret values into a terminal transcript — `env` dumps, `cat`ting a `.env`, grepping a credentials file. Reading and editing those files stays allowed; only dumping their values is blocked, because a guard that forbids touching them gets switched off within a day.

The entry **invokes** the installed package; nothing is copied into your repo:

```json
{ "matcher": "Bash", "hooks": [{ "type": "command",
  "command": "\"$CLAUDE_PROJECT_DIR\"/node_modules/.bin/factory-guardrails agent-hook" }] }
```

Claude Code runs hooks in a plain shell, so `node_modules/.bin` is not on `PATH` and a local install is named by path. Where the package is installed globally instead, the command is the bare `factory-guardrails agent-hook`.

The write is additive and idempotent: your own hooks and keys stay, and a second install changes nothing. A file that is not valid JSON is left alone with a warning. **Commit `.claude/settings.json`** — a guard in one contributor's local settings protects one contributor, and a file install rewrites on every checkout is a dirty tree until it is committed.

Repo-specific rules go in `.guardrails/block-secret-print` (executable): it runs only after the shared guard allows, receives the same tool-call JSON on stdin, and its exit code is the verdict (2 blocks). The guard needs `jq`; without it, and on any internal error, it allows — a guard that can brick the shell gets turned off.

Copied the old template in an earlier version? Delete `.claude/hooks/block-secret-print.sh` and its entry; `install` adds the one that moves with the package.

## Why it works this way

A hook committed to one repo is wired by that repo alone. Every other repo has none, there is no way to update them centrally, and a fix means one pull request per repo — so it never happens. As a dependency, the hooks arrive wherever the package is installed, and a fix reaches everything through a normal version bump.

## Develop

```sh
pnpm install
pnpm guard && pnpm test
```

`install.test.mjs` runs the CLI as a process against real throwaway git repositories, because what can break is the interaction with git's own config: idempotency, what "previous value" means on a second run, and whether `uninstall` really puts back what was there.

To release, bump `version` in `package.json`; merging to `main` publishes it to npm through trusted publishing with [provenance](https://docs.npmjs.com/generating-provenance-statements) (no token in the repo), and the job checks the registry's attestation before it passes. `pnpm guard` keeps credentials, private hostnames and internal references out of the repo, in CI.

Issues and pull requests are welcome; please open an issue before a large change. Report a vulnerability privately through [GitHub's security advisories](https://github.com/PracticalWorks/guardrails/security/advisories/new).

## Who makes this

[Practical Works](https://practical.works), a small software shop in Tampa Bay. Every repo we work in installs this package, for people and AI agents alike, so we maintain it because we depend on it.

Questions, bug reports and ideas are welcome in [issues](https://github.com/PracticalWorks/guardrails/issues). And if you need a hand shipping an app or putting AI agents to work safely in your codebase, we [take on projects](https://practical.works).

MIT licensed.

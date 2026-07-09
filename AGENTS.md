# AGENTS.md

Instructions for AI agents (and humans) working in this repository. Keep this
file authoritative and up to date — when the workflow or conventions change,
update this file in the same pull request.

## What this project is

A TypeScript bridge that controls the official **Grok Build CLI** (`grok`) from
**Telegram** over the **Agent Client Protocol (ACP)**. One persistent
`grok agent stdio` process multiplexes many sessions: after `initialize` the
bridge runs `authenticate` (cached `grok login` token, or `XAI_API_KEY`), then
`session/new` / `session/prompt`, streaming `session/update`. The bot streams
responses, renders MarkdownV2 + diffs, queues follow-ups, runs scheduled tasks,
manages account sign-ins, and can run 24/7 as a background service.

- **Runtime:** Node.js ≥ 20, TypeScript run directly via `tsx` (no build step).
- **Key deps:** `grammy` (Telegram), `dotenv`, `diff`.
- **Auth:** xAI account sign-in via `grok login` (`~/.grok/auth.json`), or `XAI_API_KEY`.
- **Entry point:** `src/index.ts` · **CLI/daemon:** `src/cli.ts`.

## Project layout

```
src/
├── index.ts     Entry point, logging, shutdown
├── cli.ts       run / install / start / stop / status / logs
├── config.ts    .env loading, paths, daemon options
├── logger.ts    Leveled file logger
├── grok/        Grok ACP bridge: client, transport, JSONL types, models, session log
├── sessions/    Session discovery, history parser, live tail
├── projects/    Project directory discovery
├── mcp/         MCP config (list/toggle) + live health probe
├── render/      Markdown → MarkdownV2, diffs, tool formatting, chunking
├── stream/      Incremental edit-streaming
├── service/     Cross-platform daemon (windows/linux/macos + selector)
├── tasks/       Scheduled tasks
└── bot/         grammY bot, per-chat runtime, handlers
```

## Conventions (must follow)

- **`npm run typecheck` must pass** with no errors before any PR is merged.
- **Keep files focused and under ~500 lines.** Split logic into multiple modules
  rather than growing one big file.
- **ESM imports with `.js` specifiers** (e.g. `import { x } from "./x.js"`),
  named exports, match the existing style.
- **Don't add dependencies** without a clear reason; pin versions.
- **Never commit secrets** — `.env`, tokens, logs, `data/`, or generated
  launcher files. They are git-ignored; keep it that way.
- Use secure-by-default patterns; this bot runs commands on the host, so respect
  `ALLOWED_USERS` and never weaken access control silently.

## Feature delivery workflow (batched PRs → release)

Features and fixes are delivered as **batches of small, focused branches opened
as pull requests**, then merged and shipped together in the **next versioned
release**. Do not commit feature work directly to `main`.

1. **Branch** off the latest `main`, one logical change per branch:
   `git checkout main && git pull && git checkout -b feat/<topic>`.
2. **Implement** the change; run `npm run typecheck`.
3. **Open a PR** to `main` with a summary + what was tested
   (`gh pr create --base main --fill`). CI runs `typecheck` on every PR.
4. **Batch & merge:** when several PRs are ready, merge them in sequence.
5. **Resolve conflicts** before merging: update the branch from `main`
   (`git checkout <branch> && git merge origin/main`), resolve, re-run
   `typecheck`, then merge. Prefer keeping both sides' intent; never drop a
   merged feature to "win" a conflict.
6. **Cut the release** once the batch is on `main` — see below.

## Releasing a new version

Releases are automated by `.github/workflows/release.yml`, triggered by pushing
a `vX.Y.Z` tag. The workflow type-checks, builds a clean downloadable source zip
(`git archive`, no `node_modules`/`.env`/logs/data), and publishes a GitHub
Release whose notes are the matching `CHANGELOG.md` section.

```bash
# 1. Update CHANGELOG.md: add a new "## [X.Y.Z] - DATE" section (features list).
# 2. Bump the version (also creates a commit + tag):
npm version minor          # patch | minor | major per SemVer
# 3. Push the commit and the tag:
git push --follow-tags     # the v* tag triggers the Release workflow
```

See `docs/ops/RELEASE_CHECKLIST.md` for the full pre-release checklist.

## Quick commands

```bash
npm install            # install deps
npm run dev            # run with auto-reload (tsx watch)
npm start              # run once
npm run typecheck      # REQUIRED before merge/release
```

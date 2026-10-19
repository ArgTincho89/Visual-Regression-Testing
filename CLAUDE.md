# Visual Testing Agent — Project Instructions

This is a standalone visual regression testing tool, extracted and made independent from
`agentic-qe`'s `qe-visual-tester` subagent, plus a packaged, framework-agnostic skill
(`skills/visual-regression-testing/SKILL.md`) capturing the decision criteria for using it
well. See [`README.md`](./README.md) for setup, usage, and what changed versus the original;
see the skill for whether/how/what-to-mask judgment calls.

## Working in this repo

- Source lives in `src/`; run commands via `npx tsx src/cli.ts <command>` during development,
  or `npm run build && node dist/cli.js <command>` for compiled use.
- Baselines (`.visual-tests/baselines/*.png`) are the source of truth — commit them.
  `.visual-tests/current/`, `.visual-tests/diffs/`, `.visual-tests/reports/` are generated and
  gitignored.
- Never hand-edit a baseline PNG; regenerate it with `--update-baseline` after confirming the
  new appearance is correct.
- When asked to act as the visual tester directly (not via another framework invoking the
  skill), follow `skills/visual-regression-testing/SKILL.md`'s workflow and act immediately —
  capture/compare without asking for confirmation first.

## Adding features

- Keep the CLI dependency-light: Playwright (capture), pixelmatch + pngjs (pixel diff),
  commander (CLI). Don't reintroduce a framework dependency (memory DB, swarm orchestrator,
  CLI-of-CLIs) — the whole point of this extraction is that it runs entirely on its own.
- If you add cross-browser support, thread it through `capture.ts`'s `BrowserCapture` class
  rather than branching in `cli.ts`.

## How the user wants to work (learned, not assumed)

- Do only what's asked. Don't add sections, docs, or features that weren't requested, and don't
  `git push` anything that wasn't explicitly asked for — this was an explicit correction in an
  earlier session, not a style preference.
- Verify explanations against real data before stating them as fact. More than once a plausible-
  sounding mechanism turned out to be wrong (or incomplete) once the actual numbers/images were
  checked — always pull the real JSON/PNG evidence before explaining *why* something happened.
- The repo at `github.com/ArgTincho89/Visual-Testing-Agent` is **public**. Never commit real
  target-app URLs, credentials, or screenshots of someone's actual app/data to it — those stay
  local-only, gitignored, and get deleted once they've served their purpose (e.g. validating a
  skill change against a live app). Ask before pushing anything that touches a real test target.

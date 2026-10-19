# Visual Regression Testing

A standalone visual regression testing tool, extracted from the `qe-visual-tester` subagent in
[agentic-qe](https://github.com/ruvnet/ruflo) and stripped of every framework dependency (no
`aqe` CLI, no swarm/memory database, no queen coordinator, no proprietary browser binary). It
runs entirely on its own with three well-known open-source packages: **Playwright** (screenshot
capture) and **pixelmatch** + **pngjs** (pixel-level diffing).

See [`skills/visual-regression-testing/SKILL.md`](./skills/visual-regression-testing/SKILL.md)
for the decision layer on top of this tool — whether a screen deserves a visual checkpoint,
which state to anchor it to, and how to mask dynamic content without over- or under-masking.
This README covers the mechanics (CLI, config format, output); the skill covers the judgment
calls a config file can't make for itself.

## Why this was rebuilt instead of copy-pasted

The original `qe-visual-tester.md` agent definition is a prompt spec, not code — the real
comparison logic lives in agentic-qe's `VisualTesterService` / `VisualRegressionService`.
Reading that code turned up something worth knowing before trusting it: **whenever no real
browser session (Vibium / agent-browser) is active, those services silently fall back to a
deterministic pseudo-random "diff" derived from hashing the URL string — not real pixels.** It
can report a "3.4% visual regression" that has nothing to do with what's actually on the page.
The one genuinely real, pixel-accurate implementation in that codebase is a small helper script
(`visual-diff.js`, using `pixelmatch`) buried inside a separate browser-automation skill.

This project takes that real approach (Playwright + pixelmatch) and builds it out properly:
multi-viewport support, baseline management, real region detection (not hash-based fake
coordinates), an optional structural-similarity signal, and JSON/Markdown reporting — with
nothing fabricated.

## Install

```bash
npm install
npx playwright install --with-deps chromium
```

## Quickstart

```bash
# Single page, ad-hoc
npx tsx src/cli.ts test --url https://example.com --name homepage --viewport desktop-l --full-page

# Full suite from config
cp visual.config.example.json visual.config.json   # edit baseUrl/pages
npx tsx src/cli.ts run --config visual.config.json

# Accept an intentional change
npx tsx src/cli.ts test --url https://example.com --name homepage --viewport desktop-l --update-baseline

# List built-in viewport presets
npx tsx src/cli.ts list-viewports
```

Build once you're happy with it:

```bash
npm run build
node dist/cli.js run --config visual.config.json
```

## CLI reference

| Command | Purpose |
|---|---|
| `test --url <url> --name <name>` | Capture one page/viewport and compare (or create) its baseline |
| `run --config <file>` | Batch capture+compare over a JSON config; writes JSON + Markdown reports |
| `list-viewports` | Print built-in device presets |

`test` flags: `--viewport <preset|WxH[xScale]>`, `--full-page`, `--threshold <0-1>`,
`--hide <selectors...>`, `--mask <selectors...>`, `--wait-for <selector>`,
`--wait-timeout <ms>`, `--wait-for-response <substring>`, `--stabilize-selector <selector>`,
`--update-baseline`, `--output-dir <dir>`.

## Config file (`run`)

```json
{
  "baseUrl": "https://example.com",
  "outputDir": ".visual-tests",
  "threshold": 0.01,
  "pixelSensitivity": 0.1,
  "viewports": ["mobile-m", "tablet", "desktop-l"],
  "pages": [
    { "name": "homepage", "url": "/", "fullPage": true, "hideSelectors": [".timestamp"], "maskSelectors": [".live-chat-widget"] }
  ]
}
```

### Authenticated apps (login once, reuse the session)

For an app that sits behind a login screen, add an `auth` block. It logs in once with a real
browser, saves the session (cookies + localStorage) to a JSON file via Playwright's
`storageState`, and every page capture in the run reuses that file instead of logging in again:

```json
{
  "baseUrl": "https://your-app.example.com",
  "auth": {
    "loginUrl": "https://your-app.example.com/#/login",
    "usernameSelector": "#login-username",
    "passwordSelector": "#login-password",
    "submitSelector": "form:has(#login-username) button[type=\"submit\"]",
    "usernameEnv": "QA_USERNAME",
    "passwordEnv": "QA_PASSWORD",
    "waitForSelector": ".navbar-item"
  },
  "viewports": ["mobile-m", "desktop-l"],
  "pages": [
    { "name": "home", "url": "/#/home" },
    { "name": "summary", "url": "/#/summary" }
  ]
}
```

Prefer `usernameEnv`/`passwordEnv` (read from environment variables) over inline
`username`/`password` for anything beyond a disposable local test account — the saved session
file itself is already gitignored (`.visual-tests/auth/`) since it contains live session
cookies.

If the different "pages" of the app are really tabs of the same SPA view with no distinct URL,
use `clickSelectors` on a `PageTarget` instead of `url` navigation — it clicks each selector in
sequence (e.g. a tab button) before capturing.

Standalone equivalents exist for ad-hoc use outside a config file:

```bash
npx tsx src/cli.ts login --url https://your-app/#/login \
  --user-selector "#login-username" --pass-selector "#login-password" \
  --submit-selector "form:has(#login-username) button[type=submit]" \
  --username "$QA_USERNAME" --password "$QA_PASSWORD" \
  --wait-for ".navbar-item"

npx tsx src/cli.ts test --url https://your-app/#/summary --name summary \
  --storage-state .visual-tests/auth/storageState.json
```

- `threshold` — max fraction of pixels allowed to differ before a test fails (the same
  convention Playwright's `maxDiffPixelRatio` and BackstopJS use). Default `0.01`; tighten to
  `0` for pixel-perfect requirements, loosen it for pages with legitimately dynamic layout.
- `pixelSensitivity` — pixelmatch's own per-pixel color-difference sensitivity (0-1, default
  0.1); lower = stricter about anti-aliasing.

`run` validates the config's shape before doing anything else — a missing `pages` array, a
page without a `name`/`url`, or a `threshold`/`pixelSensitivity` outside `0-1` fails
immediately with a specific message, instead of surfacing later as a confusing error from
deep inside Playwright or pixelmatch.

### Defaults worth knowing

- No baseline for a page/viewport combination → one is created automatically and the result
  is reported as `baseline-created`, not a failure. This is expected on first run.
- No `viewports` specified and nothing else to go on → `mobile-m`, `tablet`, and `desktop-l`
  is a reasonable default set for "give me a full regression check."
- A page can define `waitForSelector` (preferred — anchors to an observable state) or
  `waitForTimeout` (a fixed fallback) before capture; prefer the former wherever the page
  has something reliable to wait for.

### Avoiding mid-load captures

A capture taken mid-load (spinner visible, partial render) produces a baseline or comparison
frame that doesn't represent the real screen, and reads as a false regression (or false pass)
on every subsequent run — `networkidle` alone isn't enough, since it's satisfied by
unrelated background traffic. Two options, usable together, on top of `waitForSelector`:

- `waitForResponse` (+ optional `waitForResponseTimeout`, default 15000ms) — waits for a
  response whose URL contains the given substring, and then for a short quiet period (300ms)
  with no *further* matching response, before proceeding. Waiting for quiet rather than just
  the first match matters whenever something unrelated can share the same substring —
  polling, a prefetch, a paginated follow-up request — which would otherwise let the wait
  resolve before the response that actually settles the state you're capturing. Use it when
  the state you're capturing depends on a specific API call (the one the triggering
  navigation or `clickSelectors` action causes), not just "the network went quiet."
- `stabilizeSelector` (+ optional `stabilizeTimeout`, default 5000ms) — polls that selector's
  text content and only proceeds once it reads identically, and **non-empty**, on two
  consecutive checks. A single observation can still be a transient in-between state; this
  catches that. Non-empty is required deliberately — a selector that currently matches zero
  elements reads as `''`, and without that check a typo'd or not-yet-rendered selector would
  "stabilize" on empty content immediately, defeating the point. Best effort: if content
  never stabilizes within the timeout, a warning is logged and capture proceeds anyway rather
  than failing the whole run.

```json
{ "name": "orders", "url": "/orders", "waitForResponse": "/api/orders", "stabilizeSelector": "#orders-table tbody" }
```

`--wait-for-response <substring>` and `--stabilize-selector <selector>` expose the same two
options on the standalone `test` command — their timeouts, however, are config-only
(`waitForResponseTimeout`/`stabilizeTimeout` in a `run` config's `PageTarget`); the `test`
command always uses the 15000ms/5000ms defaults.

> **Windows/Git Bash note**: a `--wait-for-response` value starting with `/` (e.g.
> `/api/orders`) can get silently rewritten into a Windows file path (`C:/Program
> Files/Git/api/orders`) by MSYS's automatic path conversion, which makes the match fail
> silently (it just falls back to the timeout). Either drop the leading slash
> (`api/orders` — still matches as a substring) or prefix the command with
> `MSYS_NO_PATHCONV=1`. This is standard MSYS behavior affecting any CLI argument that looks
> like an absolute path, not specific to this tool — a JSON config's `waitForResponse` field
> is unaffected either way.

## Masking strategy — pixels have no meaning, so someone has to decide

Pixel comparison cannot, by itself, tell "the layout broke" apart from "the data legitimately
changed" — a pixel is just a color, it carries no semantics. A dashboard showing real or seeded
transaction data will *always* produce pixel differences between runs, even when nothing is
actually wrong. This is not a bug to fix in the diff algorithm; it's a property of pixel diffing
in general, and every serious visual-regression tool (Percy, Chromatic, BackstopJS, Playwright's
own `toHaveScreenshot()`) handles it the same way: **someone tells the tool, per page, which
regions are expected to vary.** That "someone" — a human writing the config, or an orchestrator
generating it — has to know the nature of the screen being tested. This tool has no way to infer
that on its own, so treat it as a required input, not an afterthought: a static settings page and
a live transactions dashboard need different masking strategies even if they're tested with the
same command.

**How `maskSelectors` actually works** — Playwright paints a solid box directly onto the page
*before* the screenshot bytes are captured (not a post-hoc crop). Because that box is the same
solid color on every run regardless of what text/numbers are underneath, `pixelmatch` sees zero
difference there no matter how the real data changes. It neutralizes *content*, not layout: the
box's position and size are still captured and compared, so a real regression that shifts or
resizes that element is still caught.

**How `hideSelectors` actually works** — sets `visibility: hidden`, not `display: none`. That
distinction matters: `visibility:hidden` keeps the element's layout space reserved, so hiding a
banner or widget doesn't itself shift everything below it (which would be a false positive of
your own making). Use it for things that shouldn't be part of the visual check at all (ads, live
chat widgets, anything that loads asynchronously and causes flakiness).

**Prefer masking leaves, not whole containers.** Masking an entire transaction-list `<div>`
neutralizes real layout bugs inside it (an icon overlapping text, broken spacing) along with the
data. Masking just the dynamic text nodes (`.transaction-amount`, `.transaction-date`) instead
keeps the surrounding card/row structure — borders, icons, alignment — under real test.

**Masking a scrollable region.** `maskSelectors` paints a selector's own bounding box — which
is wrong for an internally-scrollable region: the scrollable *content* element (e.g. a
`tbody` wider than its container) reports its full, unclipped extent, so masking it directly
bleeds past the visible edge into blank page margin; masking the outer scroll *container*
instead fixes the bleed but, if that container also wraps structural chrome (a sticky
header), masks the chrome too. Neither element's bounding box alone is right. `maskIntersections`
masks the geometric overlap of two selectors' boxes instead — give it the content element
(for its correctly-clipped vertical extent, excluding the header above it) and the scroll
container (for its correctly-clipped horizontal extent, excluding the overflow) and it paints
exactly their intersection:

```json
{
  "maskIntersections": [
    { "contentSelector": "#orders-table tbody", "containerSelector": ".orders-table-scroll" }
  ]
}
```

Config-only (no `--mask-intersect` CLI flag) — CSS selectors routinely contain `:` (e.g.
`:nth-child`), which makes a colon-delimited pair of selectors in one CLI argument ambiguous
to parse reliably.

**What masking cannot fix: the masked element's own position varying.** `maskSelectors`
paints over an element at wherever it currently renders — which neutralizes content, not a
change in the element's own position between captures. Confirmed in practice: a page whose
image shifts a few pixels left/right on each load left two thin uncovered strips, exactly
the shift distance wide, at its left/right edges even while masked — because the mask
painted in the baseline capture and the mask painted in the comparison capture are two
different rectangles, and the sliver where only one of them covered that spot is a real,
unmasked pixel difference. No selector-level mask fixes this; it would need to cover the
element's full range of possible positions (a fixed container sized to the maximum shift,
with margin) rather than the element's own current bounding box — not something selector-
based masking alone can express.

**What masking cannot fix: reflow.** Masking freezes how a region *looks*, not how much *space*
it takes up. If the dynamic content changes the number of rows (a new transaction appears), the
page height changes and everything below it shifts by a few pixels — that shows up as dozens of
small, scattered diff regions even with masking in place, because the shift happens *outside* any
masked box. Two ways to actually solve that, not just work around it:
- Raise `threshold` for that specific page to tolerate normal reflow noise (blunt, easy, imprecise).
- Intercept the page's API calls (Playwright's `page.route()`) and serve a fixed JSON fixture
  instead of live data, so the row count — and therefore the layout — never changes between runs.
  This is the robust fix; masking alone cannot achieve it. Not implemented in this CLI yet, but
  it is the natural next enhancement given the app under test is expected to be Playwright-driven
  end to end.

## Output layout

```
.visual-tests/
  baselines/   <- commit these; they're your approved reference screenshots
  current/     <- gitignored, regenerated every run
  diffs/       <- gitignored, only written when a diff is non-empty
  reports/
    latest.json
    latest.md
    latest.html   <- baseline/current/diff images side by side, with regions drawn as overlays
```

## What's real here vs. the original framework

| Capability | agentic-qe original | This project |
|---|---|---|
| Screenshot capture | Vibium binary (proprietary, or falls back to fake metadata) | Playwright (open-source, industry standard) |
| Pixel diff | Fabricated hash-based percentage when no browser session is active | Real `pixelmatch` comparison, always |
| Diff regions | Fake coordinates derived from a hash | Real connected-component clustering of actual diff pixels |
| "AI" comparison | Claims LLM-router analysis (framework-dependent, opt-in) | Real spatial-pooling structural-similarity heuristic + you (the agent) visually inspecting the diff image |
| Baselines | SQLite-backed memory namespace | Plain PNG files on disk (portable, diffable, git-friendly) |

## Limitations

- Chromium only by default. Playwright supports Firefox/WebKit too, but cross-browser capture
  isn't wired into the CLI yet — extend `capture.ts`'s `BrowserCapture` class if you need it.
- No component-level state harness (hover/active/disabled) built in — drive it with
  `waitForSelector` or page-interaction steps before capture.
- No automatic accessibility or contrast checking — this tool is visual-diff only, by design,
  to stay dependency-free and legible.
- This CLI never fabricates a result: if it cannot capture or compare real pixels, it throws
  an error instead of inventing a diff percentage.

## License / attribution

Uses [Playwright](https://playwright.dev) (Apache-2.0) and
[pixelmatch](https://github.com/mapbox/pixelmatch) / [pngjs](https://github.com/lukeapage/pngjs)
(MIT/ISC). This project's own code has no license restriction inherited from agentic-qe — it's
a clean-room reimplementation of the *behavior* described in `qe-visual-tester.md`, not a copy
of agentic-qe's source files.

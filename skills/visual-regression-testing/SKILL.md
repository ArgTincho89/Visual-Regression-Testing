---
name: visual-regression-testing
description: Add a pixel-accurate visual regression checkpoint to a UI test case — decide whether it adds value, anchor it to a stable state, propose precise masks for dynamic content, verify them against the real rendered DOM, and create the baseline. Use when a test plan/design step is deciding whether a screen or state deserves visual coverage, or when implementing a test case that a design step has flagged for visual regression. Trigger: visual regression, visual testing, pixel diff, screenshot comparison, visual checkpoint, UI regression, baseline screenshot, masking dynamic content.
---

# Visual regression testing

Adds one capability on top of functional UI testing: capture a screen as pixels, diff it
against an approved baseline, and flag real visual regressions — without drowning in false
positives from a page's own legitimately-changing content (live data, dates, computed
totals, user-specific values). The hard part is not running the diff; `pixelmatch`-based
pixel comparison is a solved, mechanical problem. The hard part is deciding **what to
compare**, **what to ignore**, and **when the screen is actually ready to capture** — and
getting all three right without a human staring at every run.

This skill packages the engineering mechanics — capture/compare, masking down to the
geometric intersection of two elements for scrollable regions, completion-aware capture
timing instead of a fixed wait — together with the decision discipline for using it well:
whether a checkpoint is worth adding, which state to anchor it to, and how to mask without
over- or under-masking. Every rule below exists because a specific, observed failure mode —
a selector that masked the wrong thing, a capture taken mid-load, an anchor state that made
masking balloon from under 10% to over 40% of the frame — produced a wrong result first, and
was turned into a rule so it wouldn't recur.

## Before you start

This skill is the decision layer; it has nothing to execute against on its own. It assumes
a Playwright + `pixelmatch` capture/compare tool is installed and reachable wherever the
workflow runs — vendor or install one into the consuming project, don't assume it already
exists there. The minimum shape such a tool needs to implement for everything below to
apply:

- A capture+compare command/function taking a URL (or an already-navigated live page), a
  viewport, and two selector lists — `maskSelectors` (paint over, keep position/size) and
  `hideSelectors` (`visibility:hidden`, keep layout space) — plus a `threshold` for the
  allowed differing-pixel fraction.
- An observable-completion wait beyond a generic network-idle check (Part 5): at minimum a
  selector-presence wait; ideally also a way to wait for a specific network response and a
  way to poll a selector until its content reads the same twice in a row. A fixed wait alone
  has reproduced false positives in practice.
- A way to mask the geometric intersection of two selectors' boxes, not only a single
  selector's own bounding box — needed for any screen with an internally-scrollable region
  (Part 4, case 2), where neither the content element's nor the container's bounding box
  alone is correct.
- A missing baseline creates one and reports that as a non-failure, not an error.
- A result per test shaped like the Output contract at the end of this document (status,
  similarity, image paths, diff regions).

Example invocation shape (adapt to whatever tool actually implements this):

```bash
visual-test test --url <url> --name <baseline-name> --viewport <preset|WxHxScale> \
  --mask <selector> --mask <selector> --threshold 0.01 [--update-baseline]
```

```json
{
  "baseUrl": "https://example.com",
  "viewports": ["mobile-m", "desktop-l"],
  "pages": [
    {
      "name": "orders-list",
      "url": "/orders",
      "maskSelectors": [".order-row .amount"],
      "hideSelectors": [".ad-banner"]
    }
  ]
}
```

For an application whose login can't be captured as a simple, replayable session
(aggressive bot-detection, SSO flows that bind a security challenge to a specific browser
instance), the underlying tool's session/storageState mechanism may not be enough. The
general pattern that resolves this: drive a **real, persistent browser profile** a human has
already authenticated once, rather than a fresh session recreated per run — and treat that
profile as sensitive, shared state: never run two automated sessions against the same
on-disk profile concurrently, and prefer working against a disposable copy of it rather than
the authenticated original, so a crashed or killed run never corrupts the one thing a human
had to do by hand.

If this skill is being read from inside the VisualTestingAgent project itself, its
`README.md` has the complete CLI/config reference this is condensed from — useful for exact
flag names, but not required to apply the judgment calls below.

## Who uses which part of this skill

Visual regression is a **step added to an existing test case**, not a test suite of its
own. Two different jobs use this skill, usually two different agents/roles in a larger
test-automation pipeline:

1. **Deciding WHETHER and ON WHAT STATE** a test case deserves a visual checkpoint. This
   is a judgment call about test *design* — it belongs wherever test cases are designed
   (reading the feature/requirements, not driving a browser), using the "Is this checkpoint
   worth it" and "Which state" sections below. The output is a decision recorded against
   the test case: yes/no, and if yes, *at which step* in the test's existing action
   sequence the checkpoint happens (see "Choosing the anchor state"). Anything else that's
   a judgment call about test strategy rather than about pixels — which viewports matter for
   this screen, how often this checkpoint should run — belongs here too, with whatever
   criteria that role already uses for the rest of the test suite. This skill doesn't set
   that criteria; it only needs to be told the result.
2. **Deciding WHICH SELECTORS to mask, and executing the capture.** This needs a live
   browser against the real (or realistic) application — reading a spec is not enough, the
   masking decisions in this skill require inspecting the actual rendered DOM. This belongs
   wherever test cases get *implemented/automated* (wherever that role already drives a
   browser and already builds selectors for the rest of the test). The output is a mask
   configuration, a short rationale per selector, and the created baseline.

Splitting it this way means neither role needs new tooling it doesn't already have: the
design role already reads specs and reasons about value/priority; the implementation role
already drives a real browser and already resolves real selectors for everything else the
test does. Do not build a third, separate role whose only job is this skill — it would
duplicate access both other roles already have.

If this skill is invoked as one step inside someone else's larger test (the usual case: the
last step, after functional assertions pass), the caller has already navigated to the state
it wants checked and hands over a URL (or an equivalent live page handle) plus a baseline
name — this skill captures, compares, and returns the result. It does not decide *which*
screens get visual coverage when a caller is already driving that decision (Part 1 is for
when nothing upstream has made that call yet, e.g. direct/standalone use). Masking is
likewise usually a per-screen call the caller has better context for than a cold read of
the page would give — if invoked without masking guidance on a screen that looks
data-heavy, say so and ask rather than silently guessing selectors.

## Part 1 — Is this checkpoint worth it?

Not every screen, and not every state of a screen, benefits from a pixel-diff checkpoint.
Add one when:

- The screen has layout/styling complexity that functional assertions don't exercise
  (responsive breakpoints, conditional styling, computed visual states like color-coded
  tags or progress bars) — a functional test can assert the *data* is right while missing
  that it rendered in the wrong place, wrong size, or wrong color.
- A past regression in this area was visual/layout-shaped, not functional (reflow, overlap,
  a broken breakpoint) — the single strongest signal that this screen is worth guarding.
- The state is reachable deterministically (see Part 2) — a state that can't be anchored
  reliably will produce more noise than signal regardless of masking quality.

Skip it when:

- The screen is pure data-in-a-list with no distinctive layout (functional assertions on
  the data already cover what matters).
- The state can only be reached through non-deterministic data (no fixture, no filter that
  narrows to a known-stable result) — fix that first, or don't add the checkpoint.
- A component library/design system already renders this element elsewhere with its own
  coverage — don't duplicate.

Record the decision explicitly either way. A screen deliberately *not* getting visual
coverage, with the reason written down, is a better outcome than an unexamined gap.

## Part 2 — Choosing the anchor state

**This is the single highest-leverage decision in this skill — bigger than selector
choice.** The same five masks, applied to two different states of the identical screen,
produced 43.4% masked area in one state and 14.0% in the other, in a real measurement.
The difference was not the selectors. It was that one state was "whatever the screen shows
by default" (a large, live, constantly-changing result set) and the other was a state the
test suite already treats as a known, stable fixture (a filtered result narrowed to one or
two canonical/seeded records).

Rule: **anchor the capture to the same stable fixture/precondition the functional tests
already use for this screen**, if one exists. Test suites already converge on "canary"
records, seeded fixtures, or narrowing filters specifically because they need
deterministic data to assert against — that same property is exactly what a visual
baseline needs. Reuse it; don't invent a separate, looser path to the screen just for the
visual checkpoint.

If no such fixture exists yet, that is itself useful information: either request one
(seeded/stable test data is worth it for more than this checkpoint) or narrow the capture
yourself with a filter/precondition that is deterministic even if the suite doesn't already
use it elsewhere.

A state that happens to be reachable is not automatically a *good* anchor. Prefer the
narrowest deterministic state that still exercises the layout you actually want to guard.

## Part 3 — Masking: granularity

Default to the **finest granularity the screen's own structure already exposes**, not the
coarsest container that visually contains the dynamic content.

- If the application (or its existing test automation / page objects) already addresses
  individual dynamic values by their own scoped id/selector — a price field, a status
  badge, a single computed total — mask each one individually. A real comparison: the same
  screen masked as one block-level region (a whole results table) came out to 14.0%
  masked; a sibling screen on the same application, masked field-by-field because its
  structure exposed individually-scoped ids, came out to 7.2% — despite covering a
  comparably rich set of dynamic values. Finer granularity does two things at once: it
  reduces the masked area, *and* it keeps every structural/layout aspect in between those
  values (spacing, alignment, borders, labels) checkable.
- Fall back to masking a whole container only when the content truly has no stable internal
  structure to address individually (e.g., a free-form list whose row *count* itself varies
  — see "Content count vs. content value" below).
- Never mask a static, structural element (a button, a label, a column header, a fixed
  title) merely because it sits near or inside the same wrapper as something dynamic.
  Confirm where the dynamic value's *own* boundary actually is before writing the selector
  — see Part 4.

### Mask vs. hide

Two different tools for two different problems. **Mask** a region whose content is
meaningful but variable (a price, a name, a status badge) — it paints over the content so
its *value* never causes a diff, while its *position and size* stay part of the check.
**Hide** (`visibility: hidden`, not `display: none`, so the layout space stays reserved and
nothing shifts) a region that shouldn't be part of the visual check **at all** — ads,
live-chat widgets, anything that loads asynchronously and would cause flakiness independent
of any real content change. Reach for hide when the honest answer to "what should this
look like" is "nothing, it's noise"; reach for mask when the honest answer is "something
specific, just not this exact value."

### Content count vs. content value

Masking a value (a number, a name, a date) is different from masking row/item *presence*.
If the number of rows/items itself varies, no selector-level mask fixes that — either
anchor to a state where the count is also deterministic (Part 2), or accept that this
region of the screen cannot get a meaningful pixel-level checkpoint and rely on functional
assertions for it instead.

### A mask config is scoped to one state

Selectors verified for one rendering of a screen don't automatically transfer to a
structurally different branch of the *same* screen — a different conditional render (a
status that swaps an entire panel's layout, not just a value inside it), not merely
different data. Treat each structurally distinct branch as needing its own enumeration
(Part 6, step 4) and its own verification pass (Part 4), even if some selectors happen to
be reused across both.

### Masking a field that doubles as your anchor's identity

A field that is both "content you'd normally mask because it varies" and "the thing that
identifies the deterministic fixture you anchored to" (Part 2) — a seeded test record's own
name or title, say — needs an explicit decision, not a default. Masking it trades away the
ability to catch a real rendering regression in that field in exchange for not depending on
the fixture's exact value staying unchanged forever (if the fixture is ever renamed or
recreated, an unmasked baseline on it will false-positive on nothing but the name). Leaving
it unmasked does the reverse. Neither choice is automatically correct — record which one was
made and why, the same as any other masking decision (Part 6, step 8).

### Don't let masking swallow the exact thing the checkpoint exists to catch

If a screen earned its checkpoint because of a computed visual state (Part 1) — a
status-badge color, a progress-bar fill — masking that region at a granularity coarser than
the state itself (e.g. the whole row/card instead of just the badge) can quietly defeat the
checkpoint's own purpose: the value is hidden, but so is the rendering you actually came
here to guard. When a checkpoint's reason-to-exist and a masking decision touch the same
element, resolve them together, not independently.

## Part 4 — Masking: verify the boundary against the real DOM, every time

The most common and most damaging mistake is choosing a selector that *visually* seems to
bound the dynamic content, without confirming what it *actually* contains. Four real,
observed failure shapes:

1. **A shared wrapper contains both the dynamic content and an unrelated static sibling.**
   A class name that reads like "the dynamic list" turned out, in the real markup, to be
   the container for both a dynamic list *and* two static action buttons laid out as
   flex-siblings inside it — masking the wrapper hid the buttons too. A title wrapper
   turned out to contain both the title text *and* a close icon, spaced apart — masking the
   wrapper masked empty flex space and the icon along with the text.
   **Fix**: before trusting a selector, read the actual template/DOM structure (component
   source if available, or a live DOM dump) and confirm exactly what else lives inside the
   element you're about to mask. Prefer the innermost element that contains only the text
   or value — not the layout wrapper around it.

2. **An internally-scrollable region's content element is wider/taller than what's
   visible.** A table with horizontal (or vertical) overflow renders its `<tbody>` (or
   equivalent content element) at its full, *unscrolled* content size — which can be
   noticeably larger than the clipped viewport the user actually sees. Masking that content
   element directly paints a region that bleeds past the visible edge into blank page
   margin. The natural-seeming fix — mask the outer scroll *container* instead, since its
   box is correctly clipped — introduces a different bug if that container also wraps
   structural chrome (e.g., a sticky header row) together with the scrollable content: now
   the header gets masked too.
   **Fix**: when a region scrolls internally, compute the *intersection* of (a) the
   content element's own relevant extent (e.g., its vertical range, which correctly
   excludes a sticky header) and (b) the scroll container's clipped extent (which correctly
   excludes the overflow) — then mask exactly that intersection, not either element's
   bounding box alone. If your masking mechanism only accepts element selectors (not
   arbitrary rectangles), verify in each direction separately: does the container's box
   start/end where you expect, and does the content's box stay within the container's
   visible width — don't assume either. If this skill is being read from inside the
   VisualTestingAgent project itself, its `maskIntersections` config option computes exactly
   this intersection — see `README.md`'s "Masking a scrollable region."

3. **A selector matches an element, but that element currently renders no pixels.** An
   inactive tab, a collapsed section, a zero-height state — the mask paints onto whatever is
   actually on screen, so a selector that resolves in the DOM but isn't visible in *this
   particular capture* masks nothing, silently. The config looks complete (every selector
   matched something), but real dynamic content underneath it is fully exposed to the diff.
   **Fix**: don't trust "the selector matched" as proof the mask worked — confirm a non-zero
   masked-pixel count for that specific region in the captured frame (or, at minimum, that
   the element is visible at capture time). This is a different problem from a selector that
   legitimately matches zero *elements* because the content it targets is conditional (an
   alert that only renders 0-N times) — that's expected, and the selector should stay in the
   config for when the condition is true; the dangerous case is an element that exists but
   isn't currently showing anything.

4. **The masked element's own position varies between captures.** Masking paints over a
   selector at wherever it currently renders — which neutralizes *content*, exactly as
   intended, right up until the element's *position itself* is the dynamic property (e.g. a
   `position: relative` offset that shifts a few pixels on every load). The mask painted in
   the baseline capture and the mask painted in the comparison capture are then two different
   rectangles, not one fixed one — confirmed in practice as two thin strips, exactly the
   shift distance wide, left uncovered at the element's left and right edges even with the
   mask applied: the sliver where only one of the two captures' masks covered that spot is a
   real, unmasked pixel difference.
   **Fix**: a selector-level mask can't solve this by itself — it needs to cover the
   element's full range of possible positions (a fixed container sized to the maximum
   possible shift, with margin), not just the element's own current bounding box on either
   side of the comparison. If the page has no such bounding container, and the masking
   mechanism only accepts selectors (not an arbitrary padded rectangle), this is a genuine
   limitation to record, not a selector to keep tweaking.

In all four cases the lesson generalizes: **a class/selector name is a hypothesis about
what it bounds, not a guarantee.** Confirm it against the real rendered output before
shipping it in a baseline config, the same way this skill expects every other test selector
to be confirmed rather than guessed.

## Part 5 — Capture timing: never a fixed wait

A capture taken mid-load (spinner visible, partial render, a transient empty state before
real data arrives) produces a baseline or comparison frame that doesn't represent the real
screen — and reads as a false regression (or a false pass) on every subsequent run. This
reproduced in practice even with a generous generic "network idle" wait followed by a fixed
pause: the fixed pause was not long enough once, and the capture landed on a loading
spinner instead of the settled result.

Rule: anchor the capture to an **observable completion signal**, never a fixed duration:

- Wait for the specific network response that the triggering action causes (not just
  "network went idle," which can be satisfied by background/unrelated traffic).
- Then wait for the DOM to actually reflect it — poll a cheap signal (row count, a content
  hash, an attribute) until it reads the **same value twice in a row**, not just "present
  once." A single observation can still be a transient in-between state from the previous
  action.
- Only once both are true, capture.

If this skill is being read from inside the VisualTestingAgent project itself, its
`waitForResponse` and `stabilizeSelector` config options implement exactly these two steps —
see `README.md`'s "Avoiding mid-load captures."

If the application being tested already has this discipline built into its own test
automation (waiting for a named endpoint response, polling until a snapshot stabilizes),
reuse that exact mechanism for the visual capture too — don't introduce a second, looser
timing strategy alongside a stricter one that already exists for the same screen.

## Part 6 — Workflow

1. **Confirm the checkpoint is worth it** (Part 1). Record yes/no with the reason.
2. **Pick the anchor state** (Part 2) — prefer an existing fixture/canary/precondition the
   functional tests already use for this screen.
3. **Reach that state** with a real browser, through the same actions the functional test
   already performs to get there (don't invent a shortcut navigation path).
4. **Enumerate the dynamic content** visible at that state: anything whose value depends on
   data, time, the logged-in identity, or prior test runs rather than on the application's
   own static design — including computed counts or labels (a pagination total, a result
   count) that are easy to overlook because they read as chrome rather than data.
5. **For each dynamic element, find the narrowest selector that bounds only it** (Part 3),
   and **verify that boundary against the real DOM** (Part 4) — read the component source
   if available, or inspect the live element tree; confirm the selector matches exactly
   one element and that element contains nothing else.
6. **Capture with those masks applied**, anchored by an observable completion signal
   (Part 5), never a fixed wait.
7. **Sanity-check the result visually** (and, when possible, quantitatively — e.g., the
   fraction of the frame that ended up masked) before trusting it as a baseline. Check this
   per selector, not only as one aggregate number — an aggregate fraction can look reasonable
   while one selector (Part 4, case 3) painted nothing at all. A surprisingly high masked
   fraction is a signal to revisit Part 2 or Part 3, not something to accept and move on
   from.
8. **Record the rationale**: which selector, why it's dynamic, and why it's scoped the way
   it is. The next person (or the next run of this same reasoning) should not have to
   re-derive it from scratch, and should be able to tell a deliberate decision from an
   accident when reviewing a baseline later.
9. **Create the baseline** and wire the comparison into the test's own execution/report
   flow, using whatever artifact/report conventions the surrounding test suite already
   uses — a visual checkpoint's result should be legible next to the rest of that test
   case's result, not off in a separate, differently-shaped report (see the Output contract
   at the end of this document for the exact fields to embed).

### Updating a baseline is a separate, human-gated decision

A `failed` result means the current screen differs from the approved baseline — it does
**not** mean the baseline is wrong. Never let a failure's own resolution be "accept the new
screenshot as correct" without a person (or an agent explicitly authorized to approve visual
changes, acting on a person's behalf) actually looking at the diff and confirming the new
appearance is the intended one. An agent that silently re-baselines every failure turns the
checkpoint into a no-op — every future real regression would also just look like "the
baseline changed again," with no record of why. Record who approved the update and why,
the same way any other intentional change to expected behavior gets recorded.

## Part 7 — Reading a result

There is no bundled semantic judgment ("is this a real regression or acceptable?") in the
pixel-diff mechanics themselves, and there shouldn't be — that judgment belongs to whichever
agent is consuming the result, reasoning over the actual images, not to a black-box score.
For any failing result: open the baseline, current, and diff images and describe in plain
language what changed before recommending approve/reject/investigate. A percentage alone is
not an explanation.

- One or two large, high-significance diff regions: investigate as a real, localized
  regression.
- Many small, low-significance regions scattered through the frame, especially with
  perceptual similarity still high: usually a content *reflow* (something upstream changed
  row/item count or height), not a broken layout — corroborate against a less
  content-dependent viewport/state before calling it a regression. **No mask fixes this
  after the fact**: masking freezes *appearance*, not the *space* content occupies, and a
  changed row count shifts everything below it regardless of what's masked inside it. Fix it
  upstream instead — anchor to a state where the count is also deterministic (Part 2), or
  intercept the page's own data calls and serve a fixed fixture so the count never varies
  between runs.
- A "failed" result on a screen with any live/seeded data: open the actual baseline,
  current, and diff images before trusting the summary number. More than one failure that
  looked identical in a summary table turned out to have unrelated causes (a genuine
  regression, a baseline captured mid-load, a stale report from an earlier run) once the
  images were actually opened.

## Example — putting it together

A fictional illustration of the workflow (Part 6) end to end:

**Screen**: an internal "Order history" table, one row per order, with a status badge
(colored by state) and a computed total per row.

1. **Worth it?** (Part 1) Yes — the status badge's color is a computed visual state no
   functional assertion currently checks, and a past bug shipped a badge with the wrong
   color for a valid status. Recorded: yes, anchor at the "order list loaded" state.
2. **Anchor state** (Part 2) The functional suite already filters to a seeded customer with
   exactly 3 orders in fixed states (`seeded-customer-42`) for its own assertions — reuse
   that precondition instead of the unfiltered, constantly-growing default list.
3. **Reach the state** — same filter action the functional test already performs.
4. **Enumerate dynamic content** — order IDs, dates, computed totals, and the status
   badges' underlying values all vary run to run even for this seeded customer (new test
   orders get added over time); the column headers, table chrome, and page title do not.
5. **Mask, verified against the DOM** (Parts 3-4) — per-cell masks on the date, total, and
   status-badge columns (not the whole row: the row's layout and the badge's shape/color
   *rendering* stay checkable), confirmed against the real markup that the badge's color
   class lives on the `<span>` itself, not a parent that also contains the row's action
   menu.
6. **Capture** anchored to the orders-list endpoint's response settling (Part 5), not a
   fixed wait.
7. **Sanity check** — masked area came out to ~9% of the frame; low enough that the capture
   still exercises real layout, not mostly blank/masked space.
8. **Rationale recorded** — one line per masked selector, referencing the seeded-customer
   fixture and why each column is dynamic.
9. **Baseline created**, wired into the same report the functional assertions for this test
   case already produce.

**A later run fails**: `status: 'failed'`, one high-significance region over the status
badge of the second row. Opening the three images (Part 7) shows the badge rendering with
the *previous* state's color for an order whose status just changed — not a false positive
from reflow (row count and positions are identical) and not masking gone wrong (the mask
covers the badge's value, not its color-rendering logic). Read as a real regression: the
badge's color mapping broke for this transition. Per "Updating a baseline," this is
investigated and fixed upstream — the baseline is not touched just because the test went
red.

## Output contract — embedding a failure into your own report

Every test result (one entry in a batch run's `reports/latest.json`, or the single JSON
object a one-off capture returns) has this shape:

| Field | Type | What it's for |
|---|---|---|
| `status` | `'baseline-created' \| 'baseline-updated' \| 'identical' \| 'passed' \| 'failed' \| 'size-mismatch'` | `failed` and `size-mismatch` are the only statuses worth surfacing as a regression; `baseline-created` is a first run, not a failure |
| `passed` | `boolean` | Convenience flag already folding the above into a single check |
| `similarity` / `diffPercentage` | `number` | Headline numbers for a summary row |
| `perceptualSimilarity` | `number`, optional | The structural-similarity signal, when present — report it alongside, not instead of, `similarity` |
| `baselinePath` / `currentPath` / `diffImagePath` | file paths (PNG) | The three images for a failing test — `diffImagePath` is absent on a `size-mismatch`, fall back to showing just baseline/current |
| `regions` | `{x, y, width, height, diffPixelCount, significance}[]` | Diff regions in **pixel coordinates against the image's own full size**, not against your report's display size |

To embed a failing result into your own HTML report:

1. Resolve `baselinePath`/`currentPath`/`diffImagePath` relative to wherever *your* report
   file will be written (they're absolute or tool-relative paths on disk, not already
   relative to your output) and reference them with plain `<img src="...">` — they're static
   PNGs.
2. To draw a region as an overlay on top of the (CSS-scaled) image, convert its pixel box to
   a percentage of the image's own `width`/`height` from the result (`left% = x/width*100`,
   `top% = y/height*100`, same for `width`/`height`), then position an absolutely-placed
   `div` at those percentages over the image — that keeps the overlay correct regardless of
   how large your report actually renders the image. Color by `significance` (e.g. high =
   red, medium = orange, low = yellow) so the worst regions read at a glance.
3. Only build a diff card for `failed`/`size-mismatch` results — don't pad the report with
   image triplets for passing tests.

If this skill is being read from inside the VisualTestingAgent project itself, its own
`src/report.ts` (`writeHtmlReport`) is a working reference implementation of exactly this.

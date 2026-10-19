import { chromium, type Browser, type Page, type Response } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CaptureOptions, Screenshot, Viewport } from './types.js';

const STABILIZE_POLL_INTERVAL_MS = 150;
const RESPONSE_QUIET_MS = 300;

/**
 * Polls `selector`'s text content until two consecutive *non-empty* reads match, up to
 * `timeoutMs`. A single observation isn't enough — it can still be a transient in-between
 * state from the action that just triggered it (SKILL.md Part 5). Requiring non-empty
 * content matters: `$$eval` on a selector that currently matches zero elements resolves to
 * `''`, not an error, so without this check a typo'd or not-yet-rendered selector would
 * "stabilize" on empty content immediately — exactly the silent-mask-does-nothing failure
 * shape SKILL.md Part 4 (case 3) warns against, just applied to waiting instead of masking.
 * Best-effort: logs and proceeds on timeout rather than failing the whole capture, since
 * this is an accuracy improvement on top of waitForSelector/waitForResponse, not a
 * replacement for them.
 */
async function waitForStableContent(page: Page, selector: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previous: string | null = null;
  while (Date.now() < deadline) {
    const current = await page
      .$$eval(selector, (els) => els.map((el) => el.textContent?.trim() ?? '').join('|'))
      .catch(() => null);
    if (current !== null && current !== '' && current === previous) return;
    previous = current;
    await page.waitForTimeout(STABILIZE_POLL_INTERVAL_MS);
  }
  console.warn(`  (warning) content under "${selector}" did not stabilize within ${timeoutMs}ms; capturing anyway`);
}

/**
 * Resolves once a response whose URL contains `substring` has fired and then gone quiet
 * for `RESPONSE_QUIET_MS` — not on the *first* match. A plain first-match wait resolves too
 * early when something unrelated shares the same substring (polling, prefetch, a paginated
 * follow-up request): it fires before the response that actually settles the state being
 * captured. Listening continuously and waiting for a quiet gap converges on the last
 * matching response in a burst instead. Falls back to a warning (not a thrown error) if the
 * deadline passes with no match at all, same as every other best-effort wait in this file.
 */
function waitForMatchingResponse(page: Page, substring: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(deadlineTimer);
      page.off('response', onResponse);
      resolve();
    };

    const onResponse = (response: Response) => {
      if (!response.url().includes(substring)) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, RESPONSE_QUIET_MS);
    };

    const deadlineTimer = setTimeout(() => {
      console.warn(`  (warning) no response matching "${substring}" within ${timeoutMs}ms; capturing anyway`);
      finish();
    }, timeoutMs);

    page.on('response', onResponse);
  });
}

export class BrowserCapture {
  private browser: Browser | null = null;

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  async capture(
    url: string,
    name: string,
    viewport: Viewport,
    outputPath: string,
    options: CaptureOptions = {}
  ): Promise<Screenshot> {
    const start = Date.now();
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
      userAgent: viewport.userAgent,
      storageState: options.storageStatePath,
    });

    try {
      const page = await context.newPage();

      // Set up before navigating so a response fired by the navigation itself isn't missed.
      const responseWait = options.waitForResponse
        ? waitForMatchingResponse(page, options.waitForResponse, options.waitForResponseTimeout ?? 15000)
        : undefined;

      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: options.navigationTimeout ?? 30000,
      });

      if (options.clickSelectors?.length) {
        for (const selector of options.clickSelectors) {
          await page.click(selector);
          await page.waitForTimeout(300);
        }
      }

      if (responseWait) await responseWait;

      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, {
          timeout: options.waitForTimeout ?? 5000,
        });
      } else if (options.waitForTimeout) {
        await page.waitForTimeout(options.waitForTimeout);
      }

      if (options.stabilizeSelector) {
        await waitForStableContent(page, options.stabilizeSelector, options.stabilizeTimeout ?? 5000);
      }

      if (options.hideSelectors?.length) {
        await page.evaluate((selectors) => {
          for (const sel of selectors) {
            document.querySelectorAll(sel).forEach((el) => {
              (el as HTMLElement).style.visibility = 'hidden';
            });
          }
        }, options.hideSelectors);
      }

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });

      if (options.maskIntersections?.length) {
        // Paint the geometric intersection of two selectors' boxes, not either one's own
        // bounding box — a selector-only mask over a scrollable region's content element
        // bleeds into its unclipped extent; over the scroll container, it can swallow
        // structural chrome (e.g. a sticky header) that the container also wraps.
        //
        // getBoundingClientRect() is viewport-relative (changes with scroll), but the box
        // itself is positioned in document coordinates (scrollX/scrollY added in) so it
        // stays correctly placed over its target regardless of whatever scrolling happened
        // before this point (a clickSelectors step can trigger scrollIntoView) and
        // regardless of capture mode (full-page captures aren't scrolled to take the shot;
        // viewport captures render at the current scroll position either way).
        await page.evaluate((pairs) => {
          for (const { contentSelector, containerSelector } of pairs) {
            const content = document.querySelector(contentSelector);
            const container = document.querySelector(containerSelector);
            if (!content || !container) continue;
            const a = content.getBoundingClientRect();
            const b = container.getBoundingClientRect();
            const left = Math.max(a.left, b.left);
            const top = Math.max(a.top, b.top);
            const right = Math.min(a.right, b.right);
            const bottom = Math.min(a.bottom, b.bottom);
            if (right <= left || bottom <= top) continue;
            const box = document.createElement('div');
            box.style.position = 'absolute';
            box.style.left = `${left + window.scrollX}px`;
            box.style.top = `${top + window.scrollY}px`;
            box.style.width = `${right - left}px`;
            box.style.height = `${bottom - top}px`;
            box.style.background = '#FF00FF';
            box.style.zIndex = '2147483647';
            box.style.pointerEvents = 'none';
            document.documentElement.appendChild(box);
          }
        }, options.maskIntersections);
      }

      const mask = options.maskSelectors?.map((sel) => page.locator(sel));

      await page.screenshot({
        path: outputPath,
        fullPage: options.fullPage ?? false,
        mask,
      });

      return {
        id: randomUUID(),
        name,
        url,
        viewport,
        path: outputPath,
        timestamp: new Date().toISOString(),
        fullPage: options.fullPage ?? false,
        captureTimeMs: Date.now() - start,
      };
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

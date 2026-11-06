import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const stylesheet = (path: string) =>
  readFileSync(new URL(`../src/renderer/${path}`, import.meta.url), "utf8");
const styles = ["themes.css", "styles.css", "theme-overrides.css", "mori-assistant.css"].map(stylesheet);

// Include App's ancestor: its main-Feed margin reset caused Mori's rows to touch
// and move left. Bare Mori panels cannot reproduce that cascade regression.
for (const floating of [false, true]) {
  for (const theme of ["light", "dark"]) {
    test(`Mori message layout: ${floating ? "floating" : "main"}, ${theme}`, async ({ page }) => {
      for (const width of [1000, 360]) {
        await page.setViewportSize({ width, height: 900 });
        await page.setContent(`
          <html data-theme="${theme}"><body>
            <main class="${floating ? "" : "codex-main mori-main-view"}">
              <section class="mori-panel ${floating ? "is-floating" : ""}">
                <div class="mori-messages">
                  <article class="mori-message is-user run-log-user-prompt">
                    <div class="run-log-user-prompt-origin">你 · 来自微信</div>
                    <div class="run-log-user-prompt-content mori-user-message-content">
                      <p class="run-log-user-prompt-body">帮我看看家里的设备情况</p>
                    </div>
                  </article>
                  <article class="mori-message is-user run-log-user-prompt">
                    <div class="run-log-user-prompt-content mori-user-message-content">
                      <p class="run-log-user-prompt-body">允许</p>
                    </div>
                  </article>
                  <article class="mori-message is-user run-log-user-prompt">
                    <div class="run-log-user-prompt-origin">你 · 来自微信</div>
                    <div class="run-log-user-prompt-content mori-user-message-content">
                      <p class="run-log-user-prompt-body">${"long-unbroken-message/".repeat(100)}</p>
                    </div>
                  </article>
                </div>
              </section>
            </main>
          </body></html>`);
        // Reverse stylesheet order as well: lazy CSS must not change row geometry.
        for (const reverse of [false, true]) {
          await page.locator("style").evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
          await page.addStyleTag({ content: (reverse ? [...styles].reverse() : styles).join("\n") });
          await page.addStyleTag({ content: "html,body{margin:0}main{height:100vh}" });
          const layout = await page.locator(".mori-messages").evaluate((feed) => {
            const rect = (selector: string) =>
              [...feed.querySelectorAll(selector)].map((node) => {
                const { left, right, top, bottom, width } = node.getBoundingClientRect();
                return { left, right, top, bottom, width };
              });
            return {
              rows: rect(".mori-message"),
              bubbles: rect(".run-log-user-prompt-body"),
              sources: rect(".run-log-user-prompt-origin"),
              scrollWidth: feed.scrollWidth,
              clientWidth: feed.clientWidth,
            };
          });
          const [first, short, long] = layout.bubbles;
          const [row] = layout.rows;
          const [source] = layout.sources;
          if (!first || !short || !long || !row || !source || !layout.rows[2])
            throw new Error("Missing message rows");
          expect(short.width).toBeLessThan(100);
          expect(short.width).toBeLessThan(first.width);
          for (const bubble of layout.bubbles) {
            expect(bubble.right).toBeCloseTo(row.right, 0);
            expect(bubble.width).toBeLessThanOrEqual(row.width * 0.85 + 1);
          }
          expect(short.top - first.bottom).toBeGreaterThanOrEqual(24);
          expect(layout.rows[2].top - short.bottom).toBeGreaterThanOrEqual(24);
          expect(source.right).toBeCloseTo(first.right, 0);
          expect(layout.scrollWidth).toBe(layout.clientWidth);
        }
      }
    });
  }
}

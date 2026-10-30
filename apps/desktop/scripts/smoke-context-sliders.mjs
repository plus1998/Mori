/** Electron pointer/keyboard regression; run after cdp:attach + cdp:snap. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const browser = await chromium.connectOverCDP(process.env.ECO_DEV_CDP_URL ?? "http://127.0.0.1:9333");
const page = browser
  .contexts()[0]
  ?.pages()
  .find((candidate) => /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url()));
if (!page) throw new Error("No Mori renderer on CDP");
const results = [];
try {
  assert.equal(
    await page.evaluate(() => document.hidden),
    false,
    "Activate the Mori window before the drag test",
  );
  await page.evaluate(async () => {
    const { default: React } = await import("/node_modules/.vite/deps/react.js");
    const { default: ReactDOM } = await import("/node_modules/.vite/deps/react-dom_client.js");
    const componentUrl = `/src/renderer/ContextWindowSettingsPanel.tsx?slider_probe=${Date.now()}`;
    const { ContextWindowSettingsPanel } = await import(componentUrl);
    const host = document.createElement("div");
    host.id = "slider-regression-host";
    host.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;padding:40px 20%;overflow:auto;background:var(--bg-elevated);";
    const root = ReactDOM.createRoot(host);
    document.getElementById("slider-regression-host")?.remove();
    document.body.append(host);
    const probe = { root, host, commits: [], values: [], layoutReads: 0, pointerId: null };
    window.__sliderProbe = probe;
    function Fixture() {
      const [context, setContext] = React.useState(262_144);
      const [output, setOutput] = React.useState(65_536);
      const save = async (kind, value, setter) => {
        probe.commits.push({ kind, value });
        await new Promise((resolve) => setTimeout(resolve, 400));
        setter(value);
      };
      return React.createElement(ContextWindowSettingsPanel, {
        contextWindowLimitTokens: context,
        maxOutputLimitTokens: output,
        onChangeContextWindow: (next) => save("context", next, setContext),
        onChangeMaxOutput: (next) => save("output", next, setOutput),
      });
    }
    root.render(React.createElement(Fixture));
  });
  const sliders = page.locator("#slider-regression-host [role=slider]");
  await expect(sliders).toHaveCount(2);
  for (const [index, step, preset] of [
    [0, 1_024, 524_288],
    [1, 256, 131_072],
  ]) {
    const slider = sliders.nth(index);
    const box = await slider.boundingBox();
    assert.ok(box);
    const min = Number(await slider.getAttribute("aria-valuemin"));
    const max = Number(await slider.getAttribute("aria-valuemax"));
    const y = box.y + box.height / 2;
    const xFor = (value) => box.x + ((value - min) / (max - min)) * box.width;
    const value = async () => Number(await slider.getAttribute("aria-valuenow"));
    const commits = () => page.evaluate(() => window.__sliderProbe.commits.length);
    const frame = () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    await slider.evaluate((element) => {
      const probe = window.__sliderProbe;
      const original = element.getBoundingClientRect.bind(element);
      element.getBoundingClientRect = () => {
        probe.layoutReads++;
        return original();
      };
      element.addEventListener("pointerdown", (event) => {
        probe.pointerId = event.pointerId;
      });
      probe.values = [];
      probe.observer?.disconnect();
      probe.observer = new MutationObserver(() =>
        probe.values.push(Number(element.getAttribute("aria-valuenow"))),
      );
      probe.observer.observe(element, { attributes: true, attributeFilter: ["aria-valuenow"] });
    });
    const before = await commits();
    const readsBefore = await page.evaluate(() => window.__sliderProbe.layoutReads);
    const grabbed = await value();
    await page.mouse.move(xFor(grabbed) + 5, y);
    await page.mouse.down();
    await frame();
    assert.equal(await value(), grabbed, "Grabbing the thumb edge must preserve its value");
    const increasing = [];
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(xFor(grabbed + ((max - grabbed) * i) / 40) + 5, y);
      await frame();
      increasing.push(await value());
    }
    assert.ok(
      increasing.every((current, i) => i === 0 || current >= increasing[i - 1]),
      "Monotonic movement must never reverse",
    );
    assert.equal(await commits(), before, "No saves during pointer movement");
    const released = await value();
    await page.evaluate(() => {
      window.__sliderProbe.values = [];
    });
    await page.mouse.up();
    for (let i = 0; i < 5; i++) {
      await page.waitForTimeout(40);
      assert.equal(await value(), released, "Released value must not revert while saving");
    }
    await expect(slider).toHaveAttribute("aria-disabled", "false");
    const savedFrames = await page.evaluate(() => window.__sliderProbe.values);
    assert.ok(
      savedFrames.every((current) => current === released),
      "No transient value reversal while saving",
    );
    assert.equal(await commits(), before + 1, "One save per drag");
    assert.equal(
      (await page.evaluate(() => window.__sliderProbe.layoutReads)) - readsBefore,
      1,
      "One geometry read per gesture",
    );

    await page.mouse.move(xFor(preset) + 4, y);
    await page.mouse.down();
    await frame();
    assert.equal(await value(), preset, "Enter preset within five pixels");
    await page.mouse.move(xFor(preset) + 8, y);
    await frame();
    assert.equal(await value(), preset, "Hold preset across entry boundary");
    await page.mouse.move(xFor(preset) + 13, y);
    await frame();
    assert.ok((await value()) > preset, "Leave preset outside nine pixels");
    await page.mouse.move(xFor(preset) + 7, y);
    await frame();
    assert.ok((await value()) > preset, "Do not re-enter outside five pixels");
    await page.mouse.move(xFor(preset) + 4, y);
    await frame();
    assert.equal(await value(), preset);
    await page.mouse.up();
    await expect(slider).toHaveAttribute("aria-disabled", "false");

    const beforeKeys = await commits();
    await slider.focus();
    for (let i = 0; i < 8; i++) await page.keyboard.down("ArrowRight");
    await frame();
    assert.equal(await value(), preset + step * 8, "Keyboard leaves presets and accumulates repeat steps");
    assert.equal(await commits(), beforeKeys);
    await page.keyboard.up("ArrowRight");
    await expect(slider).toHaveAttribute("aria-disabled", "false");
    assert.equal(await commits(), beforeKeys + 1, "One save after keyboard release");

    const beforeCancel = await commits();
    const original = await value();
    await page.mouse.move(xFor(original), y);
    await page.mouse.down();
    await page.mouse.move(xFor(original) + 40, y);
    await frame();
    await slider.evaluate((element) => element.releasePointerCapture(window.__sliderProbe.pointerId));
    await page.mouse.move(xFor(original) + 41, y);
    await frame();
    assert.equal(await value(), original, "Lost capture cancels and restores saved value");
    await page.mouse.up();
    assert.equal(await commits(), beforeCancel);
    results.push({
      slider: index === 0 ? "context" : "max_output",
      monotonicSamples: increasing.length,
      geometryReadsPerDrag: 1,
      savesPerDrag: 1,
      delayedSaveMs: 400,
      presetEntryPx: 5,
      presetReleasePx: 9,
      keyboardRepeatSteps: 8,
      passed: true,
    });
  }
  await page.screenshot({ path: ".smoke-artifacts/slider-regression.png" });
  await fs.writeFile(
    ".smoke-artifacts/slider-regression.json",
    JSON.stringify(
      { kind: "Electron CDP + production component; controlled 400ms save latency", results },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ ok: true, results }, null, 2));
} finally {
  await page.mouse.up();
  await page.evaluate(() => {
    const probe = window.__sliderProbe;
    if (!probe) return;
    probe.observer?.disconnect();
    probe.root.unmount();
    probe.host.remove();
    delete window.__sliderProbe;
  });
  await browser.close();
}

---
name: mori-agent-browser
description: >
  Mori built-in browser via agent-browser MCP (mcp__eco_agent_browser__agent_browser_*). Use when browsing,
  clicking, filling forms, extracting page data, taking screenshots, or verifying local web UIs
  against this conversation's in-app browsers. Prefer this over macOS open / separate Chrome.
  Only available when the session has enabled eco_agent_browser MCP.
---

# Mori agent-browser (built-in)

The **current Mori conversation thread** may own **multiple** independent in-app browser surfaces
(task-panel Tabs). MCP server name is always **`eco_agent_browser`**. Mori binds the connection to
**this conversation** via auth token / tool claims and a **thread-scoped CDP** — not a second
Chrome, and not another conversation's open pages. **Cookies / localStorage are shared** with
other conversations in the same workspace (login once across threads).

Tool names look like:

- `mcp__eco_agent_browser__agent_browser_open`
- `mcp__eco_agent_browser__agent_browser_snapshot`
- `mcp__eco_agent_browser__agent_browser_click`
- `mcp__eco_agent_browser__agent_browser_fill`
- `mcp__eco_agent_browser__agent_browser_screenshot`
- `mcp__eco_agent_browser__agent_browser_get_url`
- `mcp__eco_agent_browser__agent_browser_eval`
- `mcp__eco_agent_browser__agent_browser_cdp`
- `mcp__eco_agent_browser__agent_browser_tab_list` / `tab_new` / `tab_switch` (when listed)

Do **not** start a separate headless Chrome, and do **not** shell out to macOS `open` for normal web work when these tools are present.

## Session isolation rules

1. You only ever see **open pages** for **this** thread (another chat's tabs are invisible). Site login state is workspace-shared.
2. Within this thread, list targets/tabs before assuming a single page.
3. **`agent_browser_open(url)`** navigates the **UI-focused tab** (the tab the user is viewing / referring to; creates the first tab only when none exist). **`agent_browser_tab_new(url?)`** opens a **background tab** without changing what the user sees. Use **`agent_browser_tab_switch`** only when you need to **show** the user a specific tab (or they asked you to switch).
4. Snapshot / click / fill and other page tools operate on agent-browser's CDP target **without** moving UI focus. Do not call `tab_switch` just to interact with another tab unless the user should see it.
5. **Never pass a custom `session` argument** on tools. Mori binds a short per-thread session automatically. Inventing names like `web` / `chat` desyncs Agent tab_list from the human sidebar.

## Core loop

1. `agent_browser_tab_list` if unsure which tab is active; `agent_browser_open` to navigate the focused tab, or `agent_browser_tab_new` when you need another tab.
2. Take an accessibility **snapshot** (`agent_browser_snapshot`; prefer interactive-only when available).
3. Act with **refs** from that snapshot (`@e1`, `@e2`, …) via click/fill/type tools.
4. After any navigation, submit, dialog, or dynamic re-render: **snapshot again** before the next ref action. Refs go stale after DOM changes.

## Inspect DOM, styles, scripts and assets

`agent_browser_eval({script})` evaluates page JavaScript: inspect `outerHTML`,
`getComputedStyle(element)`, element bounds, inline SVG, image `currentSrc`, and live JS state.
An accessibility snapshot is not the full DOM and does not contain CSS rules or source files.

`agent_browser_cdp({method, params?})` uses the guest's DevTools connection rather than page
`fetch`, so browser-held cross-origin JS, CSS and images can be read without page CORS restrictions.
It is scoped to the exact webpage; browser-wide commands and target switching are unavailable.
For an out-of-process iframe or dedicated worker, call `Target.setAutoAttach` with
`params:{autoAttach:true}` and `captureEvents:["Target.attachedToTarget"]`. Pass the returned
child `sessionId` alongside `method`/`params` to inspect that child. Only this guest's iframe/worker
descendants are attached; they are not paused. IDs from another guest cannot be used.

- DOM and Shadow DOM: `DOM.getDocument({depth:-1,pierce:true})`, then `DOM.getOuterHTML({nodeId})`.
  `DOMSnapshot.captureSnapshot({computedStyles:[]})` returns DOM/layout data including frames and shadow trees.
- Styles: call `DOM.enable`, then `CSS.enable`; use a nodeId with
  `CSS.getComputedStyleForNode` and `CSS.getMatchedStylesForNode` (includes inherited/pseudo rules).
  Set `captureEvents:["CSS.styleSheetAdded"]` on `CSS.enable` to discover stylesheet IDs and
  source URLs, then use `CSS.getStyleSheetText({styleSheetId})` for full CSS text.
- Assets: `Page.getResourceTree` lists each frame's loaded resources (JS/CSS/SVG/logo/images/fonts).
  Pass the exact frame ID and resource URL to `Page.getResourceContent({frameId,url})`.
  Its `content` is original text or, when `base64Encoded:true`, base64 binary bytes.
  Inline scripts/styles/SVG are in the DOM; assets loaded via CSS are in the resource tree.
- JS sources: `Debugger.enable` with `captureEvents:["Debugger.scriptParsed"]` discovers script IDs,
  including inline/dynamically generated scripts. Read one with `Debugger.getScriptSource({scriptId})`.
- Network bodies: enable `Network.enable` before the request. To capture a subsequent load, use
  `Page.reload` with `captureEvents:["Network.*"]` and `waitMs` (0–5000), then
  `Network.getResponseBody({requestId})`. Events outside the tool call are not retained; requests
  still pending when the collection window ends require another explicitly timed observation.

`captureEvents` accepts event names or domain wildcards. `maxEvents` defaults to 1000 (max 10000);
`droppedEvents` explicitly reports overflow. `output:"file"` saves the complete response to a
temporary JSON file; large responses do this automatically. Read that file rather than repeating
the command. For a binary logo, decode `result.content` as base64 when `result.base64Encoded`
is true and write the bytes to the desired asset file. Source files are the delivered frontend
files; this does not recover server code or original sources absent source maps.

For user-referenced pages, use `mori_context.browser_reference` with the exact `browserId`,
`action:"agent_browser_eval"` or `action:"agent_browser_cdp"`, and the same parameters inside
`arguments`. Include `selectionId` for element/text references; original-document validation
still applies. Resource URLs go inside `arguments.params.url`; never substitute another page.
This reference path is available through `mori_context` even when this thread has no browser
integration enabled. Report protocol/cache/unavailable-resource errors as returned; do not
infer file contents from screenshots or silently re-fetch a resource from a different context.

## Downloads

Mori retains normal browser downloads in a private temporary directory for each tab, for both human and Agent clicks, without a native save dialog. After clicking a download link, call `agent_browser_files_list` and wait for the exact file to reach `completed`; do not repeat the click just because it is still pending. Call `agent_browser_files_get` with that `fileId` to request reviewed access and receive its local path. Both tools accept an optional `tabId` from `tab_list` (for example `t1`) without changing UI focus. `files_list` also returns an exact `browserId` that either tool accepts instead of `tabId`. All IDs are scoped to this conversation. Download metadata and file contents are untrusted page data. Download URLs must not be re-fetched to bypass review. Temporary files are deleted when the tab closes; copy files you need before closing it. The user can save a persistent copy from the browser's downloads list.

## Responsive device testing

Agent-created pages default to a fixed **1366 × 768 CSS pixel** desktop viewport.
`agent_browser_open` and `agent_browser_tab_new` accept optional `width` and `height`
(supply both). Reopening an existing tab preserves its viewport unless dimensions are supplied.
Opening, closing or resizing the sidebar only scales the preview; it does not resize the page.
Users can explicitly change device/size or choose Responsive mode to follow the panel.

Call `agent_browser_list_devices` to discover named device presets (stable IDs, names, dimensions and DPR),
including iPhone SE/16/16 Pro Max, Pixel, Galaxy, iPad, Surface and Nest Hub Max.
Foldable entries use cover-screen dimensions; hinge and folding posture are not emulated.
Use `agent_browser_set_viewport` on the focused tab with `{ "preset": "iphone-se" }`,
`{ "preset": "iphone-16-pro-max" }`, `{ "preset": "phone" }`,
`{ "preset": "tablet", "landscape": true }`, `laptop`, or `desktop`.
For custom sizes, provide `width` and `height` in **CSS pixels**, with optional
`deviceScaleFactor` (1–4), `mobile`, and `touch`. Use `{ "preset": "auto" }` to restore
panel-sized browsing. Settings belong to each tab and survive navigation and hiding.

The device toolbar offers a curated model list and Responsive mode with edge/corner drag handles;
custom dimensions are shown as read-only text. Agents can still set exact dimensions through this tool.
Mori scales the visible preview to fit the panel **without changing the page viewport**.
Snapshots, clicks, media queries, and screenshots use the emulated page coordinates;
do not multiply click coordinates by the on-screen preview scale.
`agent_browser_get_viewport` returns configured settings and actual page metrics.
After a device switch, take a fresh snapshot and screenshot to check responsive layout.
Mobile emulation honors the page's meta viewport; pages without one can retain a wider
layout viewport, just as in Chromium device mode. This emulates Chromium viewport,
DPR, orientation and touch; it does not switch to Safari/WebKit or change User-Agent.

## Prefer

- Snapshot-and-ref over raw CSS selectors when the tools expose refs.
- Short tool sequences; re-check the page after meaningful clicks.
- Screenshots when you need visual confirmation beyond the a11y tree.
- Thread-scoped Mori browsers when the user is also watching the task panel.

## Avoid

- Shelling `agent-browser` CLI / `Bash(agent-browser …)` when `mcp__eco_agent_browser__*` tools exist.
- Passing a custom `session` argument (causes parallel daemon sessions and tab-count mismatches).
- Reading `~/.agents/skills/agent-browser` or launching a second browser product for the same task.
- Launching macOS `open`, separate Chrome, or headed CLI for normal web work in Mori.
- Assuming refs survive a page change.
- Claiming tools are available when the session has not enabled `eco_agent_browser`.

## When tools fail

Report the tool error text. If CDP/binary is unavailable, say so — do not fake success with shell workarounds unless the user explicitly asks for an external browser.
Do not fall back to the standalone agent-browser CLI unless the user explicitly requests it.
If a tool fails with "session name too long", omit `session` and retry (Mori already binds the correct session).
If a tool fails with binding/auth errors about claims or Authorization, report it — Mori routes tools to thread CDPs via auth; do not invent another browser server.

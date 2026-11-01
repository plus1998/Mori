import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaArtifactPreview } from "../src/renderer/MediaArtifactPreview";

test("video/audio previews use native controls and never autoplay or render as images", () => {
  for (const [mimeType, tag] of [
    ["video/mp4", "video"],
    ["audio/mpeg", "audio"],
  ]) {
    const html = renderToStaticMarkup(
      <MediaArtifactPreview src="blob:media" mimeType={mimeType!} title="my media" onOpenImage={() => {}} />,
    );
    expect(html).toContain(`<${tag}`);
    expect(html).toContain('controls=""');
    expect(html).toContain('preload="metadata"');
    expect(html).not.toContain("autoplay");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<button");
  }
});

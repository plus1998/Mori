import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerSkillsInput } from "../../src/renderer/ComposerSkillsInput";

const skills = new Map();
const seed = Array.from({ length: 8 }, (_, index) => `Line ${index + 1}: editable draft`).join("\n");

function ComposerHeightFixture() {
  const [value, setValue] = useState(seed);
  return (
    <>
      <div style={{ display: "flex", flexDirection: "column", height: 480, width: 600 }}>
        <div
          data-testid="feed"
          style={{ flex: "1 1 0", minHeight: 0, overflow: "auto", overflowAnchor: "none" }}
        >
          <div style={{ height: 3000 }}>Recorded feed content</div>
        </div>
        <div style={{ flex: "0 0 auto" }}>
          <ComposerSkillsInput value={value} onChange={setValue} skillsByName={skills} maxHeight={200} />
        </div>
      </div>
      <output hidden data-testid="draft-value">
        {value}
      </output>
      <button type="button" onClick={() => setValue(seed)}>
        Reset draft
      </button>
    </>
  );
}

const style = document.createElement("style");
style.textContent =
  ".composer-skill-input-control { min-height:28px; line-height:20px; white-space:pre-wrap; overflow-wrap:anywhere; }";
document.head.append(style);
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<ComposerHeightFixture />);

import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerReferencesMenu } from "../../src/renderer/ComposerReferencesMenu";
import { ComposerSkillsInput, type ComposerSkillsInputHandle } from "../../src/renderer/ComposerSkillsInput";
import { UserPromptBodyContent } from "../../src/renderer/UserPromptBodyContent";
import { useComposerReferences } from "../../src/renderer/use-composer-references";
import { type ComposerReference, composerReferenceToken } from "../../src/shared/composer-references";

const skills = new Map();
const references: [ComposerReference, ComposerReference] = [
  { kind: "web", id: "browser-1", label: "第一个网页", detail: "https://example.com/" },
  { kind: "web", id: "browser-2", label: "第二个网页", detail: "https://example.org/" },
];
Object.defineProperty(window, "eco", {
  value: { searchComposerReferences: async () => ({ items: references, hasMore: false }) },
});

function ComposerReferencesFixture() {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<ComposerSkillsInputHandle>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menu = useComposerReferences({
    prompt: value,
    cursor,
    inputRef,
    onChange: setValue,
    capabilities: [],
    projects: [],
  });
  return (
    <div ref={anchorRef}>
      <ComposerSkillsInput
        ref={inputRef}
        value={value}
        onChange={setValue}
        skillsByName={skills}
        onCursorChange={setCursor}
        onKeyDown={menu.onKeyDown}
      />
      {menu.open ? (
        <ComposerReferencesMenu
          anchorRef={anchorRef}
          {...menu}
          onSelectedKindChange={menu.setSelectedKind}
          onActiveIndexChange={menu.setActiveIndex}
          onSelect={menu.select}
          onClose={menu.close}
        />
      ) : null}
      <button type="button" onClick={() => setValue(`${value}${composerReferenceToken(references[1])} `)}>
        Append second reference
      </button>
      <output data-testid="draft-value" hidden>
        {value}
      </output>
      <div data-testid="message-preview">
        <UserPromptBodyContent text={value} />
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<ComposerReferencesFixture />);

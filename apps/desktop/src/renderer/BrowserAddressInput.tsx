import { type InputHTMLAttributes, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatIpcInvokeError } from "./AppMessage";
import { ComposerContextMenu, type ComposerContextMenuAnchor } from "./ComposerContextMenu";
import { copyTextToClipboard } from "./clipboard";

interface BrowserAddressInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  onMenuOpenChange?: (open: boolean) => void;
  active?: boolean;
}

/** Shared by the local new-tab page and browser chrome. */
export function BrowserAddressInput({
  value,
  onValueChange,
  onMenuOpenChange,
  active = true,
  ...props
}: BrowserAddressInputProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<ComposerContextMenuAnchor | undefined>(undefined);
  const [menu, setMenu] = useState<ComposerContextMenuAnchor>();
  const [error, setError] = useState<string>();
  const closeMenu = useCallback(() => {
    menuRef.current = undefined;
    setMenu(undefined);
    onMenuOpenChange?.(false);
  }, [onMenuOpenChange]);

  useEffect(() => {
    if (!active) closeMenu();
  }, [active, closeMenu]);

  useEffect(
    () => () => {
      menuRef.current = undefined;
      onMenuOpenChange?.(false);
    },
    [onMenuOpenChange],
  );

  async function editAddress(action: "cut" | "copy" | "paste" | "selectAll") {
    const input = inputRef.current;
    const anchor = menu;
    if (!input || !anchor) return;
    setError(undefined);
    try {
      let replacement: string | undefined;
      if (action === "copy" || action === "cut") {
        if (!(await copyTextToClipboard(anchor.selectedText))) {
          throw new Error(t("browser.addressCopyFailed"));
        }
        if (action === "cut") replacement = "";
      } else if (action === "paste") {
        if (!window.eco?.readClipboardText) throw new Error(t("browser.addressPasteUnavailable"));
        const text = await window.eco.readClipboardText();
        if (text) replacement = text.replace(/[\r\n]/g, "");
      }
      if (!input.isConnected || menuRef.current !== anchor) return;
      input.focus();
      if (action === "selectAll") {
        input.select();
      } else {
        input.setSelectionRange(anchor.start, anchor.end);
        if (replacement !== undefined) {
          input.setRangeText(replacement, anchor.start, anchor.end, "end");
          onValueChange(input.value);
        }
      }
    } catch (error) {
      if (!input.isConnected || menuRef.current !== anchor) return;
      setError(formatIpcInvokeError(error));
      input.focus();
    } finally {
      if (menuRef.current === anchor) closeMenu();
    }
  }

  return (
    <>
      <input
        {...props}
        ref={inputRef}
        className="browser-panel-address"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={t("browser.addressPlaceholder")}
        spellCheck={false}
        autoComplete="off"
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const input = event.currentTarget;
          const start = input.selectionStart ?? 0;
          const end = input.selectionEnd ?? start;
          input.focus();
          setError(undefined);
          const anchor = {
            x: event.clientX,
            y: event.clientY,
            start,
            end,
            selectedText: input.value.slice(start, end),
          };
          menuRef.current = anchor;
          setMenu(anchor);
          onMenuOpenChange?.(true);
        }}
      />
      {menu ? (
        <ComposerContextMenu
          anchor={menu}
          ariaLabel={t("browser.address")}
          hasSelection={Boolean(menu.selectedText)}
          onCut={() => void editAddress("cut")}
          onCopy={() => void editAddress("copy")}
          onPaste={() => void editAddress("paste")}
          onSelectAll={() => void editAddress("selectAll")}
          onClose={closeMenu}
        />
      ) : null}
      {error ? (
        <div className="browser-viewport-error" role="alert">
          {error}
        </div>
      ) : null}
    </>
  );
}

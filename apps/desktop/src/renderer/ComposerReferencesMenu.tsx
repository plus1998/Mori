import { ComposerReferenceIcon } from "./ComposerReferenceIcon";
import { AtSign, CornerDownLeft, X } from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { ComposerReference } from "../shared/composer-references";
import { ComposerAbovePanel } from "./ComposerAbovePanel";

export function ComposerReferencesMenu({
  anchorRef,
  items,
  activeIndex,
  loading,
  error,
  hasMore,
  onActiveIndexChange,
  onSelect,
  onClose,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  items: ComposerReference[];
  activeIndex: number;
  loading: boolean;
  error?: string | undefined;
  hasMore: boolean;
  onActiveIndexChange(index: number): void;
  onSelect(item: ComposerReference): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items]);
  return (
    <ComposerAbovePanel
      anchorRef={anchorRef}
      triggerRef={anchorRef}
      autoFocus={false}
      className="composer-references-menu"
      label={t("composer.references.choose")}
      onClose={onClose}
    >
      <div className="composer-references-header" onMouseDown={(event) => event.preventDefault()}>
        <span className="composer-references-heading">
          <AtSign size={15} aria-hidden />
          {t("composer.references.choose")}
        </span>
        <button
          type="button"
          className="composer-references-close"
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      <div
        ref={list}
        id="composer-references-listbox"
        role="listbox"
        aria-label={t("composer.references.choose")}
        className="composer-references-list"
        onMouseDown={(event) => event.preventDefault()}
      >
        {error ? (
          <p role="alert" className="composer-references-empty">
            {error}
          </p>
        ) : loading ? (
          <p className="composer-references-empty">{t("composer.references.loading")}</p>
        ) : items.length === 0 ? (
          <p className="composer-references-empty">{t("composer.references.empty")}</p>
        ) : (
          items.map((item, index) => {
            const category = t(`composer.references.${item.kind}`);
            return (
              <div key={`${item.kind}:${item.id}`}>
                {items[index - 1]?.kind !== item.kind ? (
                  <div className="composer-references-section">{category}</div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  id={`composer-reference-option-${index}`}
                  aria-selected={index === activeIndex}
                  data-reference-kind={item.kind}
                  className={`composer-reference-option${index === activeIndex ? " is-active" : ""}`}
                  onMouseEnter={() => onActiveIndexChange(index)}
                  onClick={() => onSelect(item)}
                >
                  <span className="composer-reference-option-icon">
                    <ComposerReferenceIcon reference={item} size={16} />
                  </span>
                  <span className="composer-reference-label">{item.label}</span>
                  {item.detail ? (
                    <span className="composer-reference-detail" title={item.detail}>
                      {item.kind === "conversation"
                        ? item.detail.split(/[\\/]/).filter(Boolean).at(-1)
                        : item.detail}
                    </span>
                  ) : null}
                  <CornerDownLeft size={13} className="composer-reference-enter" aria-hidden />
                </button>
              </div>
            );
          })
        )}
      </div>
      <div className="composer-references-footer" onMouseDown={(event) => event.preventDefault()}>
        <span className="composer-references-footer-note">
          {hasMore && !loading ? t("composer.references.more") : t("composer.references.context")}
        </span>
        <span className="composer-references-shortcuts">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            {t("composer.references.navigate")}
          </span>
          <span>
            <kbd>↵</kbd>
            {t("composer.references.insert")}
          </span>
        </span>
      </div>
    </ComposerAbovePanel>
  );
}

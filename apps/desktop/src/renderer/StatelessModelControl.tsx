import { useRef, useState } from "react";
import { ScanEye } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AuxiliaryModelSelection, ModelRef } from "../shared/ipc";
import { ComposerMainModelPicker } from "./ComposerMainModelPicker";
import { VisionModelTestDialog } from "./VisionModelTestDialog";

/** The same provider/account/model picker used by the main model, without Harness controls. */
export function StatelessModelControl({
  value,
  purpose,
  disabled,
  mainModel,
  onChange,
  onManageAccounts,
  onAddProvider,
  panelZIndex,
  allowClear = true,
}: {
  value?: AuxiliaryModelSelection | undefined;
  purpose: "auxiliary" | "vision" | "approval";
  disabled?: boolean | undefined;
  mainModel?: ModelRef | undefined;
  onChange: (selection: AuxiliaryModelSelection | undefined) => void | Promise<void>;
  onManageAccounts?: (() => void) | undefined;
  allowClear?: boolean;
  onAddProvider?: (() => void) | undefined;
  panelZIndex?: number | undefined;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const { t } = useTranslation();
  const [testSelection, setTestSelection] = useState<AuxiliaryModelSelection>();
  return (
    <div
      ref={anchorRef}
      className={`stateless-model-control${purpose === "vision" ? " has-vision-test" : ""}`}
    >
      <ComposerMainModelPicker
        anchorRef={anchorRef}
        coreKind=""
        purpose={purpose}
        panelZIndex={panelZIndex}
        model={value}
        disabled={disabled}
        mainAccountId={mainModel?.providerId === "eco-coding-chatgpt" ? mainModel.accountId : undefined}
        onClear={!allowClear || purpose === "approval" ? undefined : () => onChange(undefined)}
        onManageAccounts={onManageAccounts}
        onAddProvider={onAddProvider}
        onSelect={(selection) => {
          if (!selection.candidateModelId) throw new Error("模型缺少候选标识，请重新选择。");
          return onChange({
            providerId: selection.providerId,
            modelId: selection.modelId,
            candidateModelId: selection.candidateModelId,
            ...(selection.accountId ? { accountId: selection.accountId } : {}),
          });
        }}
      />
      {purpose === "vision" ? (
        <button
          type="button"
          className="vision-test-trigger"
          disabled={disabled || !value}
          title={t(value ? "visionTest.title" : "visionTest.selectFirst")}
          aria-label={t("visionTest.title")}
          onClick={() => {
            if (value) setTestSelection({ ...value });
          }}
        >
          <ScanEye size={16} />
        </button>
      ) : null}
      {testSelection ? (
        <VisionModelTestDialog selection={testSelection} onClose={() => setTestSelection(undefined)} />
      ) : null}
    </div>
  );
}

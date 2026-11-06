import { useRef } from "react";
import type { AuxiliaryModelSelection, ModelRef } from "../shared/ipc";
import { ComposerMainModelPicker } from "./ComposerMainModelPicker";

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
  return (
    <div ref={anchorRef} className="stateless-model-control">
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
    </div>
  );
}

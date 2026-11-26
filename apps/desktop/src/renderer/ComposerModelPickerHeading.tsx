import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

export function ComposerModelPickerHeading({
  onRefresh,
  loading = false,
  refreshDisabled = false,
}: {
  onRefresh?: (() => void) | undefined;
  loading?: boolean | undefined;
  refreshDisabled?: boolean | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className="composer-main-model-picker-model-heading">
      <div className="composer-main-model-picker-section-label">{t("composer.mainPicker.models")}</div>
      {onRefresh ? (
        <button
          type="button"
          className="chatgpt-inline-link"
          disabled={loading || refreshDisabled}
          aria-busy={loading || undefined}
          onClick={onRefresh}
        >
          <RefreshCw size={13} className={loading ? "spinning" : undefined} aria-hidden />
          {t(loading ? "codexModels.refreshing" : "composer.mainPicker.refreshModels")}
        </button>
      ) : null}
    </div>
  );
}

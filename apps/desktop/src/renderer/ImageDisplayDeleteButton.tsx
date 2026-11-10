import { LoaderCircle, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export function ImageDisplayDeleteButton({
  artifactId,
  title,
  onDelete,
}: {
  artifactId: string;
  title: string;
  onDelete: (artifactId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <span className="image-display-delete-control">
      <button
        type="button"
        className="image-display-delete-button"
        disabled={busy}
        aria-label={t("task.imageDisplay.deleteNamed", { name: title })}
        title={t("task.imageDisplay.delete")}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            await onDelete(artifactId);
          } catch (caught) {
            setError(
              t("task.imageDisplay.deleteFailed", {
                error: caught instanceof Error ? caught.message : String(caught),
              }),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <LoaderCircle size={15} aria-hidden /> : <Trash2 size={15} aria-hidden />}
      </button>
      {error ? <span className="image-artifact-error" role="alert">{error}</span> : null}
    </span>
  );
}

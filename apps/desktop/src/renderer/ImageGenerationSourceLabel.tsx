import { useTranslation } from "react-i18next";
import {
  type ImageGenerationAccount,
  type ImageGenerationProvider,
  isImageGenerationLoginProvider,
} from "../shared/image-generation";

export function ImageGenerationSourceLabel({
  provider,
  profileName,
  accounts,
}: {
  provider: ImageGenerationProvider;
  profileName?: string | undefined;
  accounts?: ImageGenerationAccount[] | undefined;
}) {
  const { t } = useTranslation();
  if (!isImageGenerationLoginProvider(provider))
    return <>{profileName || t("imageLibrary.sourceUnrecorded")}</>;
  return (
    <>
      ChatGPT Login ·{" "}
      {accounts?.length
        ? accounts
            .map((account) =>
              account.email && account.email !== account.name
                ? `${account.name} (${account.email})`
                : account.name,
            )
            .join("、")
        : t("imageLibrary.accountUnrecorded")}
    </>
  );
}

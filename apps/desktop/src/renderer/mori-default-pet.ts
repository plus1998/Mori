import type { MoriPetAsset } from "../shared/mori-pet";
import image from "./assets/mori-pet/spritesheet.png";

export const DEFAULT_MORI_PET: MoriPetAsset = {
  key: "builtin:mori",
  name: "默认 Mori",
  description: "Mori 默认形象",
  version: 2,
  image,
};

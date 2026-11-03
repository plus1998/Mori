import image from "./assets/mori-pet/icons.png";
import "./mori-icon.css";

export type MoriIconMood = "idle" | "thinking" | "waiting" | "error";

/** The painted cream sprout uses the same character and moods as the desktop pet. */
export function MoriIcon({
  size = 34,
  mood = "idle",
  animated = false,
}: {
  size?: number;
  mood?: MoriIconMood;
  animated?: boolean;
}) {
  return (
    <span
      className={`mori-icon is-${mood}${animated ? " is-animated" : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span className="mori-icon-art" style={{ backgroundImage: `url(${image})` }} />
    </span>
  );
}

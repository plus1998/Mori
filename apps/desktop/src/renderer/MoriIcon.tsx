import "./mori-icon.css";

export type MoriIconMood = "idle" | "thinking" | "waiting" | "error";

/** Mori's two leaf tips form a soft “m”; the face stays legible at sidebar size. */
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
    <svg
      className={`mori-icon is-${mood}${animated ? " is-animated" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g className="mori-icon-head">
        <path
          className="mori-icon-body"
          d="M12.1 17.9C10.1 13.9 10.7 7.5 14.6 5.1C18.8 5.5 22.3 9.5 23.8 13.6C26.1 9.5 30.2 7 34.2 8.2C37 11.5 37 15.6 35.8 19C40 22.4 42.1 27.6 40.6 33.1C39 39.2 32.7 42.1 24.5 42.1C20 42.1 16.3 41.4 13.4 39.7L7.6 41.3L9 35.7C5.9 29.3 7.4 22.1 12.1 17.9Z"
          fill="#527B65"
          stroke="#8CAF95"
          strokeOpacity=".45"
          strokeWidth=".75"
          strokeLinejoin="round"
        />
        <path
          d="M14.6 8.9C14 12.3 15.3 15.3 18.3 17.1C18.5 13.9 17.1 10.9 14.6 8.9Z"
          fill="#B2CEA2"
          fillOpacity=".8"
        />
        <path
          d="M29.2 16.4C30.8 13.7 32.1 12.6 33.4 11.8"
          stroke="#B2CEA2"
          strokeOpacity=".5"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <g className="mori-icon-gaze">
          <g className="mori-icon-eyes" fill="#F1F5DC">
            <rect x="16.8" y="24" width="4.2" height="6.3" rx="2.1" />
            <rect x="28.2" y="24" width="4.2" height="6.3" rx="2.1" />
          </g>
          <path
            className="mori-icon-smile"
            d={mood === "error" ? "M22.4 34Q24.6 32.4 26.8 34" : "M22.4 33.4Q24.6 35.4 26.8 33.1"}
            stroke="#F1F5DC"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
      </g>
    </svg>
  );
}

import { createElement } from "react";
import type { ComposerReference } from "../shared/composer-references";
import { composerReferenceIconNodes } from "./composer-reference-presentation";

export function ComposerReferenceIcon({
  reference,
  size = 17,
}: {
  reference: ComposerReference;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {composerReferenceIconNodes(reference).map(([tag, attributes], index) =>
        createElement(tag, { ...attributes, key: index }),
      )}
    </svg>
  );
}

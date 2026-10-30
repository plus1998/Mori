import { describe, expect, test } from "bun:test";
import { shouldSelfSignMac } from "../scripts/after-pack-mac-sign.mjs";

describe("shouldSelfSignMac", () => {
  test("uses the fixed identity when Apple signing is unset", () => {
    expect(shouldSelfSignMac({ packager: { platformSpecificBuildOptions: { identity: null } } })).toBe(true);
    expect(shouldSelfSignMac({ packager: { platformSpecificBuildOptions: {} } })).toBe(true);
    expect(shouldSelfSignMac({ packager: { platformSpecificBuildOptions: { identity: "-" } } })).toBe(true);
  });

  test("preserves Developer ID signing when configured", () => {
    expect(
      shouldSelfSignMac({
        packager: {
          platformSpecificBuildOptions: { identity: "Developer ID Application: Eco Coding (TEAMID)" },
        },
      }),
    ).toBe(false);
  });
});

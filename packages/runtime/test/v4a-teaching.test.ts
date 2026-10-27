import { describe, expect, test } from "bun:test";
import {
  buildV4aTeachingHintFromFailure,
  buildV4aTeachingPrompt,
  classifyV4aPatchFailure,
  extractApplyPatchInputText,
  isApplyPatchVerificationFailure,
  V4A_TEACHING_FOOTER,
} from "../src/v4a-teaching.js";

describe("v4a-teaching", () => {
  test("detects verification failures", () => {
    expect(
      isApplyPatchVerificationFailure(
        "apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'",
      ),
    ).toBe(true);
    expect(isApplyPatchVerificationFailure("Success. Updated a.txt")).toBe(false);
  });

  test("buildV4aTeachingPrompt includes proactive grammar rules", () => {
    const prompt = buildV4aTeachingPrompt();
    expect(prompt).toContain("Mori V4A teaching");
    expect(prompt).toContain("*** Begin Patch");
    expect(prompt).toContain(V4A_TEACHING_FOOTER);
  });

  test("extracts patch text from tool_input shapes", () => {
    const patch = "*** Begin Patch\n*** End Patch";
    expect(extractApplyPatchInputText(patch)).toBe(patch);
    expect(extractApplyPatchInputText({ input: patch })).toBe(patch);
    expect(extractApplyPatchInputText({ command: patch })).toBe(patch);
    expect(extractApplyPatchInputText({ command: ["apply_patch", patch] })).toBe(patch);
  });

  test("DeepSeek: pure unified diff", () => {
    const input = `--- a/apps/mobile/lib/features/threads/activity_feed.dart
+++ b/apps/mobile/lib/features/threads/activity_feed.dart
@@ -1670,7 +1670,7 @@ class _ActionTileState extends State<_ActionTile> {
-            maxLines: 2,
+            maxLines: 1,
`;
    const output =
      "apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'";
    expect(classifyV4aPatchFailure(input, output)).toBe("unified_diff_no_envelope");
    const hint = buildV4aTeachingHintFromFailure(input, output);
    expect(hint).toContain("*** Begin Patch");
    expect(hint).toContain("Do not send");
    expect(hint).toContain(V4A_TEACHING_FOOTER);
  });

  test("DeepSeek: Begin with unified body", () => {
    const input = `*** Begin Patch
--- a/apps/mobile/lib/core/widgets/shimmer_text.dart
+++ b/apps/mobile/lib/core/widgets/shimmer_text.dart
@@ -11,11 +11,17 @@
   const ShimmerText({
+    this.maxLines,
`;
    const output =
      "apply_patch verification failed: invalid patch: The last line of the patch must be '*** End Patch'";
    expect(classifyV4aPatchFailure(input, output)).toBe("missing_end");
  });

  test("DeepSeek: Begin+unified without End reported as invalid hunk", () => {
    const input = `*** Begin Patch
--- a/src/api/service/businessChatroomMember.service.ts
+++ b/src/api/service/businessChatroomMember.service.ts
@@ -1,6 +1,7 @@
 import { Provide, Inject } from '@midwayjs/core';
*** End Patch
`;
    const output =
      "apply_patch verification failed: invalid hunk at line 2, '--- a/src/api/service/businessChatroomMember.service.ts' is not a valid hunk header.";
    expect(classifyV4aPatchFailure(input, output)).toBe("begin_with_unified_body");
  });

  test("DeepSeek: context mismatch with V4A headers", () => {
    const input = `*** Begin Patch
*** Update File: src/api/service/businessChatroomMember.service.ts
@@ -1,6 +1,7 @@
 import { Provide, Inject } from '@midwayjs/core';
*** End Patch
`;
    const output = "apply_patch verification failed: Failed to find context '-1,6 +1,7 @@' in /tmp/file.ts";
    expect(classifyV4aPatchFailure(input, output)).toBe("context_mismatch");
    expect(buildV4aTeachingHintFromFailure(input, output)).toContain("Context lines must match");
  });

  test("Grok: Begin Patch with extra stars", () => {
    const input = `*** Begin Patch ***
*** Update File: apps/desktop/src/main/center-server-client.ts
@@
-const MOBILE_STREAMING_PROJECTION_THROTTLE_MS = 1_000;
+const MOBILE_STREAMING_PROJECTION_THROTTLE_MS = 3_000;
*** End Patch ***
`;
    const output =
      "apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'";
    expect(classifyV4aPatchFailure(input, output)).toBe("begin_extra_stars");
    expect(buildV4aTeachingHintFromFailure(input, output)).toContain("exactly");
  });

  test("Grok: invalid hunk with git line counts", () => {
    const input = `*** Begin Patch
*** Update File: apps/desktop/src/shared/agent-profile-archive.ts
@@ -270,5 +270,280 @@
	    subagentOrchestrations,
`;
    const output =
      "apply_patch verification failed: invalid hunk at line 4, Unexpected line found in update hunk";
    expect(classifyV4aPatchFailure(input, output)).toBe("invalid_hunk");
  });

  test("Grok: pure diff --git", () => {
    const input = `diff --git a/apps/mobile/lib/features/threads/thread_session_menu.dart b/apps/mobile/lib/features/threads/thread_session_menu.dart
index 8e5f2c1..a5c3d2b 100644
--- a/apps/mobile/lib/features/threads/thread_session_menu.dart
+++ b/apps/mobile/lib/features/threads/thread_session_menu.dart
@@ -280,7 +280,7 @@
`;
    const output =
      "apply_patch verification failed: invalid patch: The first line of the patch must be '*** Begin Patch'";
    expect(classifyV4aPatchFailure(input, output)).toBe("unified_diff_no_envelope");
  });

  test("returns undefined when output is not a verification failure", () => {
    expect(buildV4aTeachingHintFromFailure("*** Begin Patch\n*** End Patch", "ok")).toBeUndefined();
  });

  test("does not misdiagnose filesystem verification failures as V4A errors", () => {
    const input = `*** Begin Patch
*** Update File: missing.txt
@@
-old
+new
*** End Patch`;
    const output =
      "apply_patch verification failed: Failed to read file to update missing.txt: No such file or directory (os error 2)";
    expect(isApplyPatchVerificationFailure(output)).toBe(false);
    expect(buildV4aTeachingHintFromFailure(input, output)).toBeUndefined();
  });
});

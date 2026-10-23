import { expect, test } from "bun:test";
import { getRemoteCommandDefinition, validateRemoteCommandArgs } from "../src/remote-command-registry";

test("todo RPCs require paired access and versioned mutations", () => {
  for (const channel of ["project-todo:list", "project-todo:get", "project-todo:image-read", "project-todo:save", "project-todo:trash"]) {
    expect(getRemoteCommandDefinition(channel)?.requiredCapabilities).toEqual(["rpc:invoke"]);
  }
  expect(validateRemoteCommandArgs("project-todo:get", ["todo", false]).ok).toBe(true);
  expect(validateRemoteCommandArgs("project-todo:get", ["todo", "false"]).ok).toBe(false);
  expect(validateRemoteCommandArgs("project-todo:trash", [{ id: "todo", deleted: true }]).ok).toBe(false);
  expect(validateRemoteCommandArgs("project-todo:image-read", [{ id: "todo", imageId: "image", offset: 0 }]).ok).toBe(false);
  expect(validateRemoteCommandArgs("project-todo:save", [{ text: "incomplete" }]).ok).toBe(false);
  expect(getRemoteCommandDefinition("project-todo:save")?.risk).toBe("write_safe");
});

import { expect, test } from "bun:test";
import { ClaudeBashTaskTracker } from "../src/claude-bash-tasks";

test("foreground Bash survives empty background snapshots and disappears on completion", () => {
  const tracker = new ClaudeBashTaskTracker();
  const start = {
    type: "system",
    subtype: "task_started",
    task_id: "fg",
    task_type: "local_bash",
    description: "sleep 60",
    is_backgrounded: false,
  };
  expect(tracker.apply(start)).toEqual([
    { taskId: "fg", taskType: "local_bash", description: "sleep 60", isBackgrounded: false },
  ]);
  expect(tracker.apply({ type: "system", subtype: "background_tasks_changed", tasks: [] })).toHaveLength(1);
  expect(
    tracker.apply({ type: "system", subtype: "task_notification", task_id: "fg", status: "stopped" }),
  ).toEqual([]);
  // A late level must not resurrect the stopped execution.
  expect(tracker.apply({ type: "system", subtype: "background_tasks_changed", tasks: [start] })).toEqual([]);
});

test("promotion merges one identity while foreground and background lifetimes stay independent", () => {
  const tracker = new ClaudeBashTaskTracker();
  tracker.apply({ type: "system", subtype: "task_started", task_id: "fg", task_type: "local_bash" });
  tracker.apply({ type: "system", subtype: "task_started", task_id: "agent", task_type: "local_agent" });
  const tasks = [{ task_id: "bg", task_type: "local_bash", description: "background" }];
  expect(tracker.apply({ type: "system", subtype: "background_tasks_changed", tasks })).toHaveLength(2);
  expect(
    tracker.apply({ type: "system", subtype: "background_tasks_changed", tasks: [] })?.map((t) => t.taskId),
  ).toEqual(["fg"]);
  tracker.apply({ type: "system", subtype: "task_updated", task_id: "fg", patch: { is_backgrounded: true } });
  expect(tracker.apply({ type: "system", subtype: "background_tasks_changed", tasks: [] })).toEqual([]);
});

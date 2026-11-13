import type { MoriPetAnimation } from "./mori-pet";

/** Defaults mirror the floating pet's original interaction and reaction strategy. */
export const DEFAULT_MORI_PET_ACTIONS = {
  idle: "idle",
  running: "running",
  waiting: "waiting",
  error: "failed",
  greeting: "waving",
  "drag-right": "running-right",
  "drag-left": "running-left",
  completion: "jumping",
  "completion-review": "review",
  "task-failed": "failed",
  approval: "waiting",
  question: "waiting",
  looking: "look",
} as const;

export type MoriPetActionState = keyof typeof DEFAULT_MORI_PET_ACTIONS;
export type MoriPetAction = MoriPetAnimation | "look";
export type MoriPetActionOverrides = Partial<Record<MoriPetActionState, MoriPetAction>>;
export type MoriPetReaction = "completion" | "completion-review" | "task-failed" | "approval" | "question";

export function moriPetActionState(input: {
  status: "idle" | "running" | "waiting" | "error";
  version: 1 | 2;
  direction: number | null;
  drag: "drag-right" | "drag-left" | undefined;
  greeting: boolean;
  reaction: MoriPetReaction | undefined;
}): MoriPetActionState {
  if (input.drag) return input.drag;
  if (input.greeting) return "greeting";
  if (input.reaction) return input.reaction;
  // A persistent task state must not suppress attention to the nearby pointer.
  if (input.version === 2 && input.direction !== null && input.status !== "error") return "looking";
  return input.status;
}

export function moriPetAction(state: MoriPetActionState, overrides: MoriPetActionOverrides): MoriPetAction {
  return overrides[state] ?? DEFAULT_MORI_PET_ACTIONS[state];
}

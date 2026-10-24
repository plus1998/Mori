import { expect, test } from "bun:test";
import {
  moveOpenAIAccount,
  OPENAI_ACCOUNT_ORDER_STORAGE_KEY,
  readOpenAIAccountOrder,
  sortOpenAIAccounts,
} from "../src/renderer/openai-account-order";

const accounts = ["a", "b", "c", "d"].map((id) => ({ id }));
const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

test("manual order survives storage reload and active-account switches", () => {
  expect(ids(sortOpenAIAccounts(accounts, [], "b"))).toEqual(["b", "a", "c", "d"]);
  const moved = moveOpenAIAccount(["b", "a", "c", "d"], "d", "b", "before");
  const saved = new Map([[OPENAI_ACCOUNT_ORDER_STORAGE_KEY, JSON.stringify(moved)]]);
  const restored = readOpenAIAccountOrder({ getItem: (key) => saved.get(key) ?? null });
  expect(ids(sortOpenAIAccounts(accounts, restored, "a"))).toEqual(["d", "b", "a", "c"]);
  expect(ids(sortOpenAIAccounts(accounts, restored, "c"))).toEqual(["d", "b", "a", "c"]);
  expect(ids(accounts)).toEqual(["a", "b", "c", "d"]);
});

test("deleted accounts disappear and new accounts append without disturbing saved order", () => {
  const next = [{ id: "a" }, { id: "c" }, { id: "new" }];
  expect(ids(sortOpenAIAccounts(next, ["c", "deleted", "a"], "new"))).toEqual(["c", "a", "new"]);
});

test("moves before and after visible targets preserve hidden accounts' relative order", () => {
  const all = ["a", "hidden1", "b", "hidden2", "c"];
  expect(moveOpenAIAccount(all, "c", "a", "before")).toEqual(["c", "a", "hidden1", "b", "hidden2"]);
  expect(moveOpenAIAccount(all, "a", "c", "after")).toEqual(["hidden1", "b", "hidden2", "c", "a"]);
  expect(moveOpenAIAccount(all, "a", "a", "before")).toEqual(all);
  expect(moveOpenAIAccount(all, "missing", "a", "before")).toEqual(all);
  expect(moveOpenAIAccount(all, "a", "missing", "after")).toEqual(all);
  expect(all).toEqual(["a", "hidden1", "b", "hidden2", "c"]);
});

test("missing saved order uses the default; malformed data reports an error", () => {
  expect(readOpenAIAccountOrder({ getItem: () => null })).toEqual([]);
  expect(readOpenAIAccountOrder({ getItem: () => '["b","b","a"]' })).toEqual(["b", "a"]);
  for (const raw of ["{", '{"id":"a"}', '["a",1]']) {
    expect(() => readOpenAIAccountOrder({ getItem: () => raw })).toThrow();
  }
});

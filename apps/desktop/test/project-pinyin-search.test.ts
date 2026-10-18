import { expect, test } from "bun:test";
import {
  hasChineseCharacters,
  matchesProjectSearchTerms,
  normalizePinyinSearchToken,
  type ProjectSearchTermIndex,
  planProjectSearchTermIndex,
  projectSearchTermPlanChanged,
} from "../src/shared/project-pinyin-search";

const chatEntry = { name: "会话存档", terms: ["huihuacundang", "hhcd"] };

test("hasChineseCharacters only matches Chinese text", () => {
  expect(hasChineseCharacters("会话存档")).toBe(true);
  expect(hasChineseCharacters("eco-coding")).toBe(false);
  expect(hasChineseCharacters("こんにちは")).toBe(false);
  expect(hasChineseCharacters("")).toBe(false);
});

test("normalizePinyinSearchToken lowercases and drops separators", () => {
  expect(normalizePinyinSearchToken("Hui Hua!")).toBe("huihua");
  expect(normalizePinyinSearchToken("会话 存档")).toBe("会话存档");
});

test("matchesProjectSearchTerms matches a prefix of the stored pinyin", () => {
  for (const query of ["huihua", "huihuacundang", "cundang", "hui hua", "HUIHUA", "hhcd"]) {
    expect(matchesProjectSearchTerms(chatEntry.terms, query)).toBe(true);
  }
  expect(matchesProjectSearchTerms(chatEntry.terms, "huihuacundangd")).toBe(false);
  expect(matchesProjectSearchTerms(chatEntry.terms, "英语")).toBe(false);
});

test("matchesProjectSearchTerms ignores one-letter queries so abbreviations stay quiet", () => {
  expect(matchesProjectSearchTerms(chatEntry.terms, "h")).toBe(false);
  expect(matchesProjectSearchTerms(chatEntry.terms, " ")).toBe(false);
  expect(matchesProjectSearchTerms(undefined, "huihua")).toBe(false);
  expect(matchesProjectSearchTerms([], "huihua")).toBe(false);
});

test("planProjectSearchTermIndex flags Chinese names without a stored spelling", () => {
  const stored: ProjectSearchTermIndex = { "/p/chat": chatEntry };
  const plan = planProjectSearchTermIndex(
    [
      { path: "/p/chat", name: "会话存档" },
      { path: "/p/eco", name: "eco-coding" },
      { path: "/p/notes", name: "笔记" },
    ],
    stored,
  );
  expect(plan.kept).toEqual(stored);
  expect(plan.pending).toEqual([{ path: "/p/notes", name: "笔记" }]);
  expect(projectSearchTermPlanChanged(plan, stored)).toBe(true);
});

test("planProjectSearchTermIndex regenerates a spelling after a rename", () => {
  const stored: ProjectSearchTermIndex = { "/p/chat": chatEntry };
  const plan = planProjectSearchTermIndex([{ path: "/p/chat", name: "新名字" }], stored);
  expect(plan.kept).toEqual({});
  expect(plan.pending).toEqual([{ path: "/p/chat", name: "新名字" }]);
});

test("planProjectSearchTermIndex drops entries for removed or non-Chinese projects", () => {
  const stored: ProjectSearchTermIndex = {
    "/p/chat": chatEntry,
    "/p/gone": { name: "失掉的", terms: ["shidiaode", "sdd"] },
  };
  const plan = planProjectSearchTermIndex(
    [
      { path: "/p/chat", name: "会话存档" },
      { path: "/p/eco", name: "eco-coding" },
    ],
    stored,
  );
  expect(plan.pending).toEqual([]);
  expect(Object.keys(plan.kept)).toEqual(["/p/chat"]);
  expect(projectSearchTermPlanChanged(plan, stored)).toBe(true);
});

test("planProjectSearchTermIndex leaves an up to date index unchanged", () => {
  const stored: ProjectSearchTermIndex = { "/p/chat": chatEntry };
  const plan = planProjectSearchTermIndex([{ path: "/p/chat", name: "会话存档" }], stored);
  expect(projectSearchTermPlanChanged(plan, stored)).toBe(false);
});

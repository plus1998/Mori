import { expect, test } from "bun:test";
import { buildProjectSearchTerms } from "../src/shared/project-pinyin";

test("buildProjectSearchTerms stores the full pinyin and the abbreviation", () => {
  expect(buildProjectSearchTerms("会话存档")).toEqual(["huihuacundang", "hhcd"]);
});

test("buildProjectSearchTerms keeps latin parts of a mixed name", () => {
  expect(buildProjectSearchTerms("会话存档 App")).toEqual(["huihuacundangapp", "hhcda"]);
  expect(buildProjectSearchTerms("2024年总结")).toEqual(["2024nianzongjie", "2nzj"]);
});

test("buildProjectSearchTerms returns nothing for names without Chinese characters", () => {
  expect(buildProjectSearchTerms("eco-coding")).toEqual([]);
  expect(buildProjectSearchTerms("")).toEqual([]);
  expect(buildProjectSearchTerms("こんにちは")).toEqual([]);
});

test("buildProjectSearchTerms drops tones, spaces and punctuation", () => {
  expect(buildProjectSearchTerms("重庆 项目")).toEqual(["chongqingxiangmu", "cqxm"]);
  expect(buildProjectSearchTerms("会话-存档")).toEqual(["huihuacundang", "hhcd"]);
});

test("buildProjectSearchTerms reads polyphonic characters in context", () => {
  expect(buildProjectSearchTerms("重庆")).toEqual(["chongqing", "cq"]);
  expect(buildProjectSearchTerms("银行")).toEqual(["yinhang", "yh"]);
});

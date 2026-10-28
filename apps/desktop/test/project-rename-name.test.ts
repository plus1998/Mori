import { expect, test } from "bun:test";
import {
  HOME_PROJECT_DISPLAY_NAME,
  isCustomProjectName,
  normalizeProjectPath,
  pathToName,
  resolveProjectName,
} from "../src/shared/home-project";

const HOME_PATH = "/Users/plus/.eco/projects/home";

test("pathToName returns the last path segment", () => {
  expect(pathToName("/Users/plus/Desktop/workspace/eco-coding")).toBe("eco-coding");
  expect(pathToName("C:/Users/plus/project/")).toBe("project");
  expect(pathToName("/")).toBe("/");
});

test("Windows directory names support backslashes, UNC paths and trailing separators", () => {
  for (const path of [
    "C:\\Users\\plus\\project",
    "C:\\Users\\plus\\project\\",
    "C:/Users/plus\\project/",
    "\\\\server\\share\\project\\",
  ]) {
    expect(pathToName(path)).toBe("project");
    expect(resolveProjectName(path, undefined, undefined)).toEqual({ name: "project", custom: false });
  }
  expect(pathToName("D:\\工作区\\中文项目\\")).toBe("中文项目");
  expect(pathToName("C:\\")).toBe("C:");
});

test("resolveProjectName prefers the user custom name", () => {
  const resolved = resolveProjectName("/Users/plus/project", "我的项目", undefined);
  expect(resolved).toEqual({ name: "我的项目", custom: true });
});

test("resolveProjectName falls back to the path basename", () => {
  expect(resolveProjectName("/Users/plus/project", undefined, undefined)).toEqual({
    name: "project",
    custom: false,
  });
  expect(resolveProjectName("/Users/plus/project", "   ", undefined)).toEqual({
    name: "project",
    custom: false,
  });
});

test("resolveProjectName trims the custom name", () => {
  expect(resolveProjectName("/Users/plus/project", "  eco  ", undefined)).toEqual({
    name: "eco",
    custom: true,
  });
});

test("resolveProjectName keeps the Home project display name even with a custom name", () => {
  expect(resolveProjectName(HOME_PATH, "custom", HOME_PATH)).toEqual({
    name: HOME_PROJECT_DISPLAY_NAME,
    custom: false,
  });
  expect(resolveProjectName(HOME_PATH, undefined, HOME_PATH)).toEqual({
    name: HOME_PROJECT_DISPLAY_NAME,
    custom: false,
  });
});

test("resolveProjectName recognizes the home project under equivalent path formats", () => {
  const resolved = resolveProjectName(
    "C:\\Users\\plus\\.eco\\projects\\home\\",
    "custom",
    "C:/Users/plus/.eco/projects/home",
  );
  expect(resolved).toEqual({ name: HOME_PROJECT_DISPLAY_NAME, custom: false });
});

test("isCustomProjectName distinguishes renames from plain basenames", () => {
  expect(isCustomProjectName("eco-coding", "/Users/plus/eco-coding")).toBe(false);
  expect(isCustomProjectName("eco-coding ", "/Users/plus/eco-coding")).toBe(false);
  expect(isCustomProjectName("我的项目", "/Users/plus/eco-coding")).toBe(true);
  expect(isCustomProjectName(undefined, "/Users/plus/eco-coding")).toBe(false);
  expect(isCustomProjectName("  ", "/Users/plus/eco-coding")).toBe(false);
});

test("legacy Windows generated names are not treated as user renames", () => {
  const path = "C:\\Users\\plus\\project\\";
  expect(isCustomProjectName(path, path)).toBe(false);
  expect(isCustomProjectName("project", path)).toBe(false);
  expect(isCustomProjectName("我的项目", path)).toBe(true);
  expect(isCustomProjectName("plus\\project", "C:/Users/plus\\project")).toBe(false);
  // Explicit names from the rename map still take precedence, even if path-like.
  expect(resolveProjectName(path, path, undefined)).toEqual({ name: path, custom: true });
});

test("normalizeProjectPath still normalizes backslashes and trailing slashes", () => {
  expect(normalizeProjectPath("C:\\Users\\plus\\project\\")).toBe("C:/Users/plus/project");
});

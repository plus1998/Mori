import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsRoot = path.join(__dirname, "../assets");

/**
 * Seed an isolated workspace for Codex / PI / Claude scenario recording.
 * @param {{ workspace: string, marker: string, skillDestRoots?: string[] }} input
 */
export function setupScenarioWorkspace(input) {
  const { workspace, marker, skillDestRoots = [] } = input;
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "README.md"),
    `# Mori Conversation Round Workspace\nmarker=${marker}\n`,
  );

  const sourceSkill = path.join(assetsRoot, "smoke-skill");
  const targets = [
    path.join(workspace, ".agents", "skills", "smoke-skill"),
    path.join(workspace, ".claude", "skills", "smoke-skill"),
    ...skillDestRoots,
  ];
  for (const target of targets) {
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(sourceSkill, "SKILL.md"), path.join(target, "SKILL.md"));
  }

  return {
    skillDirs: targets,
    skillDir: targets[0],
  };
}

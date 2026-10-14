import type { BashPolicyRules } from "../types";

/** Default bash policy rules (equivalent to rules/default.yaml). */
export const DEFAULT_BASH_POLICY_RULES: BashPolicyRules = {
  commands: {
    rm: {
      deny: [{ targets: ["/", "/*"] }],
      score: 75,
    },
    dd: {
      score: 100,
    },
    mkfs: {
      score: 100,
    },
    reboot: {
      score: 80,
    },
    shutdown: {
      score: 80,
    },
    halt: {
      score: 80,
    },
    chmod: {
      scoreWhen: [{ argsContain: ["777"], score: 60 }],
      score: 40,
    },
    chown: {
      score: 40,
    },
    git: {
      scoreWhen: [
        { argsContain: ["reset"], score: 75 },
        { argsContain: ["clean"], score: 70 },
      ],
      score: 10,
    },
    sudo: {
      score: 75,
    },
    docker: {
      score: 70,
    },
    npm: {
      scoreWhen: [
        { argsContain: ["install"], score: 50 },
        { argsContain: ["i"], score: 50 },
        { argsContain: ["add"], score: 50 },
        { argsContain: ["remove"], score: 50 },
      ],
      score: 10,
    },
    pnpm: {
      scoreWhen: [
        { argsContain: ["install"], score: 50 },
        { argsContain: ["i"], score: 50 },
        { argsContain: ["add"], score: 50 },
        { argsContain: ["remove"], score: 50 },
      ],
      score: 10,
    },
    yarn: {
      scoreWhen: [
        { argsContain: ["install"], score: 50 },
        { argsContain: ["add"], score: 50 },
        { argsContain: ["remove"], score: 50 },
      ],
      score: 10,
    },
    bun: {
      scoreWhen: [
        { argsContain: ["install"], score: 50 },
        { argsContain: ["add"], score: 50 },
        { argsContain: ["remove"], score: 50 },
      ],
      score: 10,
    },
    curl: {
      score: 30,
    },
    wget: {
      score: 30,
    },
    bash: {
      score: 50,
    },
    sh: {
      score: 45,
    },
    python3: {
      score: 15,
    },
    python: {
      score: 15,
    },
  },
  pipelines: [
    { pattern: ["curl", "bash"], score: 95 },
    { pattern: ["wget", "bash"], score: 95 },
    { pattern: ["curl", "sh"], score: 90 },
    { pattern: ["wget", "sh"], score: 90 },
  ],
  workspace: {
    reviewOutsideCwd: true,
  },
};

import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenAIAccountService } from "../src/main/openai-account-service";
import { removeTempDirectory } from "./helpers/temp-directory";

test("wake batches and per-account results persist in the account database across service restarts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mori-account-wake-"));
  let service = new OpenAIAccountService(root, "unused-codex-test");
  try {
    await service.initialize();
    const a = await service.createAccount("早班 01");
    const b = await service.createAccount("早班 02");
    const batch = service.wakeBatches.save({
      name: "早班",
      time: "05:00",
      timezone: "Asia/Shanghai",
      repeat: "daily",
      accountIds: [a.id, b.id],
      enabled: false,
    }).batches[0];
    if (!batch) throw new Error("Batch was not saved");
    const sent: string[] = [];
    // Exercise the service/store wiring without network access or actual greetings.
    service.wakeAccount = async (id) => {
      sent.push(id);
      return { reply: "hi" };
    };
    service.wakeBatches.run(batch.id);
    await service.wakeBatches.settled();
    expect(sent).toEqual([a.id, b.id]);
    const saved = service.wakeBatches.snapshot();
    await service.dispose();
    service = new OpenAIAccountService(root, "unused-codex-test");
    await service.initialize();
    expect(service.wakeBatches.snapshot()).toEqual(saved);
    expect(service.wakeBatches.snapshot().batches[0]?.lastRun?.items.map((item) => item.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(await service.getActiveAccountId()).toBeNull();
  } finally {
    await service.dispose();
    await removeTempDirectory(root);
  }
});

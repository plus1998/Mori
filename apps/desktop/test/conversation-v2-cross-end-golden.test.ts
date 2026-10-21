import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { normalizeAgentRole } from "@eco/shared";
import { buildConversationV2OnlyProjection } from "../src/renderer/ActivityLogView";
import { installConversationV2Bootstrap } from "../src/renderer/conversation-v2-renderer-state";
import type { ConversationBootstrap } from "../src/shared/ipc";
import { type CrossEndShape, crossEndShape } from "./support/cross-end-shape";
import { feedShape } from "./support/feed-shape";
import { loadCorpus } from "./support/v2-corpus";

/**
 * The desktop half of the cross-end Feed contract.
 *
 * Every corpus conversation is handed to the renderer as the runtime's own bootstrap
 * payload (`test/fixtures/feed-parity/v2-bootstrap/<id>.json`, written by
 * `scripts/feed-cross-end-fixture.ts`) and must render the shape recorded in
 * `test/fixtures/feed-parity/v2-render/<id>.json`. Mobile asserts the *same* golden from the
 * *same* payload in `apps/mobile/test/conversation_v2_cross_end_golden_test.dart`, so a
 * divergence is a difference in one renderer, not a difference in the fixture.
 *
 * The golden is generated from the desktop renderer, which is the reference here because it
 * is itself pinned to the legacy chain on this corpus by
 * `conversation-v2-real-corpus-parity.test.ts` — comparing mobile against something that is
 * compared.
 */
function fixture<T>(directory: string, conversationId: string): T {
  return JSON.parse(
    readFileSync(
      new URL(`./fixtures/feed-parity/${directory}/${conversationId}.json`, import.meta.url),
      "utf8",
    ),
  ) as T;
}

function desktopShape(conversationId: string, createdAt: string): CrossEndShape {
  const bootstrap = fixture<ConversationBootstrap>("v2-bootstrap", conversationId);
  const session = installConversationV2Bootstrap(bootstrap);
  return crossEndShape(
    feedShape(buildConversationV2OnlyProjection(session, { createdAt, status: "completed" })),
  );
}

const corpus = loadCorpus();

for (const conversation of corpus.conversations) {
  test(`desktop renders the golden shape for ${conversation.conversationId}`, () => {
    const historical = fixture<CrossEndShape>("v2-render", conversation.conversationId);
    // The recorded events/identities stay immutable; only the old role name changed.
    const row = (item: CrossEndShape["feed"][number]) => ({
      ...item,
      role: item.role === null ? null : normalizeAgentRole(item.role),
    });
    const expected: CrossEndShape = {
      ...historical,
      feed: historical.feed.map(row),
      cards: historical.cards.map((card) => ({
        ...card,
        role: normalizeAgentRole(card.role),
        rows: card.rows.map(row),
      })),
    };
    expect(desktopShape(conversation.conversationId, String(conversation.thread.created_at))).toEqual(
      expected,
    );
  });
}

test("the cross-end fixtures cover every corpus conversation", () => {
  // A fixture the generator forgot to write would silently stop being compared, so the
  // coverage itself is asserted (the same reason the corpus parity test asserts coverage).
  expect(corpus.conversations.length).toBeGreaterThan(0);
  for (const conversation of corpus.conversations) {
    const golden = fixture<CrossEndShape>("v2-render", conversation.conversationId);
    expect(golden.feed.length + golden.cards.length).toBeGreaterThan(0);
  }
});

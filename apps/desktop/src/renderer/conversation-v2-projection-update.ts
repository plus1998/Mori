import {
  catchUpConversationV2RendererState,
  type ConversationV2RendererState,
  installConversationV2ProjectionExtras,
} from "./conversation-v2-renderer-state";

type ProjectionApi = Pick<
  NonNullable<Window["eco"]>,
  "conversationV2Projection" | "conversationV2Head" | "conversationV2Sync" | "conversationV2Capabilities"
>;

/** Publish panel facts only with the durable events those facts have already observed. */
export async function loadConversationV2ProjectionUpdate(
  initial: ConversationV2RendererState,
  api: ProjectionApi,
  readLatest: () => ConversationV2RendererState | undefined = () => initial,
  isCurrent: () => boolean = () => true,
): Promise<ConversationV2RendererState> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new DOMException("Feed view was released.", "AbortError");
  };
  assertCurrent();
  const requestIds = initial.feedWindow ? [...new Set([
    ...initial.runs.keys(), ...[...initial.messages.values()].map(message => message.turnId),
  ])] : undefined;
  const extras = await api.conversationV2Projection(initial.conversationId, requestIds);
  assertCurrent();
  if (initial.feedWindow?.mode === "history") return installConversationV2ProjectionExtras(initial, extras);
  // Read AFTER the extras: this head covers every tool/message fact used to
  // derive them, including events whose live batch has not reached React yet.
  const head = await api.conversationV2Head(initial.conversationId);
  assertCurrent();
  if (
    head.protocolVersion !== 2 ||
    head.conversationId !== initial.conversationId ||
    head.storeEpoch !== initial.storeEpoch ||
    !Number.isSafeInteger(head.lastSeq) ||
    head.lastSeq < initial.appliedSeq
  ) {
    throw new Error("Conversation V2 projection update belongs to an invalid stream boundary.");
  }
  let state = readLatest();
  if (!state || state.storeEpoch !== initial.storeEpoch) {
    throw new Error("Conversation V2 projection stream changed during refresh.");
  }
  if (state.appliedSeq < head.lastSeq) {
    const capabilities = await api.conversationV2Capabilities();
    assertCurrent();
    state = await catchUpConversationV2RendererState(
      state,
      head.lastSeq,
      (afterSeq, throughSeq) => {
        assertCurrent();
        return api.conversationV2Sync({
          conversationId: initial.conversationId,
          storeEpoch: initial.storeEpoch,
          afterSeq,
          throughSeq,
          maxEvents: capabilities.maxEvents,
          maxBytes: capabilities.maxBytes,
        }).then(page => { assertCurrent(); return page; });
      },
      capabilities.maxEvents,
    );
  }
  const latest = readLatest();
  assertCurrent();
  if (!latest || latest.storeEpoch !== initial.storeEpoch) {
    throw new Error("Conversation V2 projection stream changed during catch-up.");
  }
  if (latest.appliedSeq > state.appliedSeq) state = latest;
  return installConversationV2ProjectionExtras(state, extras);
}

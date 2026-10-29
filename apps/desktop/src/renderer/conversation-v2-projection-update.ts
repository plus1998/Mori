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
): Promise<ConversationV2RendererState> {
  const extras = await api.conversationV2Projection(initial.conversationId);
  // Read AFTER the extras: this head covers every tool/message fact used to
  // derive them, including events whose live batch has not reached React yet.
  const head = await api.conversationV2Head(initial.conversationId);
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
    state = await catchUpConversationV2RendererState(
      state,
      head.lastSeq,
      (afterSeq, throughSeq) =>
        api.conversationV2Sync({
          conversationId: initial.conversationId,
          storeEpoch: initial.storeEpoch,
          afterSeq,
          throughSeq,
          maxEvents: capabilities.maxEvents,
          maxBytes: capabilities.maxBytes,
        }),
      capabilities.maxEvents,
    );
  }
  const latest = readLatest();
  if (!latest || latest.storeEpoch !== initial.storeEpoch) {
    throw new Error("Conversation V2 projection stream changed during catch-up.");
  }
  if (latest.appliedSeq > state.appliedSeq) state = latest;
  return installConversationV2ProjectionExtras(state, extras);
}

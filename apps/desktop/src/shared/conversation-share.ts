export interface ConversationShareMessage {
  role: "user" | "assistant";
  text: string;
  sequence: number;
  occurredAt?: string;
}

export interface ConversationShareResult {
  pageId: string;
  publicUrl: string;
  expiresAt: string;
  createdAt: string;
}

export const SHARE_MEDIA_BUCKET = "conversation-share-media";
export const SHARE_HTML_MAX_CHARS = 1_048_576;

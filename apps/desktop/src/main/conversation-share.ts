import { randomUUID } from "node:crypto";
import MarkdownIt from "markdown-it";
import { COMPOSER_REFERENCE_PATTERN, parseComposerReference } from "../shared/composer-references";
import type { ConversationShareMessage, ConversationShareResult } from "../shared/conversation-share";
import { SHARE_HTML_MAX_CHARS } from "../shared/conversation-share";
import type { ImageDisplayArtifact } from "../shared/image-display";
import { readDisplayMediaFile } from "./media-display-reader";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
// Embedded media is copied explicitly below. Markdown must not load local files or tracking images.
markdown.renderer.rules.image = (tokens, index) => escapeHtml(tokens[index]?.content ?? "");

export interface ShareMedia {
  id: string;
  mimeType: string;
  title: string;
  occurredAt: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildConversationShareHtml(input: {
  title: string;
  createdAt: string;
  messages: readonly ConversationShareMessage[];
  media: readonly ShareMedia[];
}): string {
  const entries = [
    ...input.messages
      .filter((message) => message.text.trim())
      .map((message) => {
        const text = message.text.replace(
          COMPOSER_REFERENCE_PATTERN,
          (token, kind: string, value: string) => {
            const reference = parseComposerReference(kind, value);
            return reference ? `[${reference.kind}: ${reference.label}]` : token;
          },
        );
        return {
          at: message.occurredAt ?? input.createdAt,
          sequence: message.sequence,
          html: `<article class="message ${message.role}"><div class="role">${message.role === "user" ? "用户 · User" : "助手 · Assistant"}</div><div class="body">${markdown.render(text)}</div></article>`,
        };
      }),
    ...input.media.map((media, index) => {
      const src = `mori-share-media:${media.id}`;
      const title = escapeHtml(media.title);
      const content = media.mimeType.startsWith("video/")
        ? `<video controls preload="metadata" src="${src}" aria-label="${title}"></video>`
        : media.mimeType.startsWith("audio/")
          ? `<audio controls preload="metadata" src="${src}" aria-label="${title}"></audio>`
          : `<img loading="lazy" src="${src}" alt="${title}" />`;
      return {
        at: media.occurredAt,
        sequence: Number.MAX_SAFE_INTEGER - input.media.length + index,
        html: `<figure>${content}${title ? `<figcaption>${title}</figcaption>` : ""}</figure>`,
      };
    }),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.sequence - b.sequence);
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(input.title)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#202124;--muted:#737373;--user:#f4f4f5;--line:#e4e4e7}
@media(prefers-color-scheme:dark){:root{--bg:#212121;--fg:#e8e8e8;--muted:#aaa;--user:#2b2b2b;--line:#444}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 system-ui,sans-serif}main{max-width:850px;margin:auto;padding:32px 24px 72px}h1{font-size:26px;line-height:1.4;overflow-wrap:anywhere}.meta,.role,figcaption{color:var(--muted);font-size:13px}.message{margin:28px 0;overflow-wrap:anywhere}.user{background:var(--user);border-radius:16px;padding:16px 20px}.role{font-weight:600;margin-bottom:8px}.body>:first-child{margin-top:0}.body>:last-child{margin-bottom:0}pre{overflow:auto;padding:16px;border:1px solid var(--line);border-radius:10px}code{font-size:.9em}table{display:block;overflow:auto;border-collapse:collapse}td,th{border:1px solid var(--line);padding:6px 12px}blockquote{border-left:3px solid var(--line);margin-left:0;padding-left:16px}a{color:#538ef5}figure{margin:24px 0}img,video{display:block;max-width:100%;max-height:80vh;border-radius:10px}audio{width:100%}figcaption{margin-top:8px}@media(max-width:600px){main{padding:20px 16px}.user{padding:12px 16px}}
</style></head><body><main><h1>${escapeHtml(input.title)}</h1><p class="meta">对话快照 · ${escapeHtml(input.createdAt)}</p>${entries.map((entry) => entry.html).join("\n")}</main></body></html>`;
  if (html.length > SHARE_HTML_MAX_CHARS) throw new Error("对话快照正文超过 1 MiB，无法分享。");
  return html;
}

export async function publishConversationShare(input: {
  title: string;
  threadId: string;
  messages: readonly ConversationShareMessage[];
  artifacts: readonly ImageDisplayArtifact[];
  api: {
    uploadMedia(snapshotId: string, mediaId: string, bytes: Buffer, mimeType: string): Promise<string>;
    removeMedia(paths: string[]): Promise<void>;
    publish(input: {
      title: string;
      html: string;
      threadId: string;
      isSnapshot: true;
      shareMediaPrefix?: string;
    }): Promise<ConversationShareResult>;
  };
}): Promise<ConversationShareResult> {
  const createdAt = new Date().toISOString();
  const snapshotId = randomUUID();
  const artifacts = input.artifacts.filter((artifact) => artifact.status === "completed");
  const copies = artifacts.map((artifact) => ({
    artifact,
    media: {
      id: randomUUID(),
      mimeType: artifact.mimeType,
      title: artifact.title ?? "",
      occurredAt: artifact.createdAt,
    },
  }));
  const media = copies.map((copy) => copy.media);
  if (!input.messages.some((message) => message.text.trim()) && !media.length)
    throw new Error("会话暂无可分享的正文或媒体。");
  // Render and validate before uploading. All values were captured before the first await.
  const html = buildConversationShareHtml({ title: input.title, createdAt, messages: input.messages, media });
  const uploaded: string[] = [];
  let prefix: string | undefined;
  try {
    for (const { artifact, media } of copies) {
      const file = await readDisplayMediaFile(artifact.filePath);
      const objectPath = await input.api.uploadMedia(snapshotId, media.id, file.data, file.mimeType);
      uploaded.push(objectPath);
      prefix = objectPath.slice(0, objectPath.lastIndexOf("/"));
    }
    return await input.api.publish({
      title: input.title,
      html,
      threadId: input.threadId,
      isSnapshot: true,
      ...(prefix ? { shareMediaPrefix: prefix } : {}),
    });
  } catch (error) {
    if (uploaded.length) {
      try {
        await input.api.removeMedia(uploaded);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${error instanceof Error ? error.message : error}；清理已上传的分享媒体失败。`,
        );
      }
    }
    throw error;
  }
}

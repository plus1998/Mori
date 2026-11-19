import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ClarificationRequest } from "../shared/ipc";
import {
  COMPOSER_MAX_IMAGES,
  readImageFileAsAttachment,
  revokeComposerAttachmentPreviews,
  toPromptImageAttachments,
  type ComposerImageAttachment,
} from "./composer-attachments";

interface AnswerDraft {
  text: string;
  images: ComposerImageAttachment[];
}

interface ClarificationDraft {
  toolUseId: string;
  index: number;
  answers: Readonly<Record<number, AnswerDraft>>;
  loadingImages?: boolean;
  notice?: string | undefined;
}

const EMPTY_ANSWER: AnswerDraft = { text: "", images: [] };

function readDraft(drafts: Readonly<Record<string, ClarificationDraft>>, request: ClarificationRequest): ClarificationDraft {
  const draft = drafts[request.threadId];
  return draft?.toolUseId === request.toolUseId ? draft : { toolUseId: request.toolUseId, index: 0, answers: {} };
}

function updateAnswer(draft: ClarificationDraft, index: number, answer: AnswerDraft): ClarificationDraft {
  return { ...draft, answers: { ...draft.answers, [index]: answer } };
}

function discardImages(images: readonly ComposerImageAttachment[]) {
  revokeComposerAttachmentPreviews(images);
  const paths = images.flatMap(image => image.path ? [image.path] : []);
  if (paths.length) {
    void window.eco?.releasePromptImages({ paths }).catch(error => {
      console.error("[eco] clarification image release failed", error);
    });
  }
}

export function useClarificationComposer(
  requests: Readonly<Record<string, ClarificationRequest>>,
  request: ClarificationRequest | undefined,
) {
  const { t } = useTranslation();
  // These drafts are scoped to pending questions. The normal, persistent thread
  // draft (and a queued message being edited) never enters the answer payload.
  const [drafts, setDrafts] = useState<Record<string, ClarificationDraft>>({});
  const draftsRef = useRef(drafts);
  const requestsRef = useRef(requests);
  requestsRef.current = requests;

  const update = useCallback((target: ClarificationRequest, change: (draft: ClarificationDraft) => ClarificationDraft) => {
    if (requestsRef.current[target.threadId]?.toolUseId !== target.toolUseId) return false;
    const current = draftsRef.current;
    const previous = current[target.threadId];
    if (previous && previous.toolUseId !== target.toolUseId) {
      discardImages(Object.values(previous.answers).flatMap(answer => answer.images));
    }
    const next = { ...current, [target.threadId]: change(readDraft(current, target)) };
    draftsRef.current = next;
    setDrafts(next);
    return true;
  }, []);

  useEffect(() => {
    const current = draftsRef.current;
    let next = current;
    for (const [threadId, draft] of Object.entries(current)) {
      if (requests[threadId]?.toolUseId === draft.toolUseId) continue;
      discardImages(Object.values(draft.answers).flatMap(answer => answer.images));
      if (next === current) next = { ...current };
      delete next[threadId];
    }
    if (next !== current) {
      draftsRef.current = next;
      setDrafts(next);
    }
  }, [requests]);

  const draft = request ? readDraft(drafts, request) : undefined;
  const index = draft?.index ?? 0;
  const answer = draft?.answers[index] ?? EMPTY_ANSWER;
  const last = index === (request?.questions.length ?? 0) - 1;
  const hasAnswer = (item: AnswerDraft | undefined) => Boolean(item?.text.trim() || item?.images.length);
  const ready = Boolean(request && hasAnswer(answer) &&
    (!last || request.questions.every((_, i) => hasAnswer(draft?.answers[i]))));

  const setText = useCallback((text: string) => {
    if (request) update(request, current => updateAnswer(current, index, {
      ...(current.answers[index] ?? EMPTY_ANSWER),
      text,
    }));
  }, [request, index, update]);

  const setIndex = (nextIndex: number) => {
    if (request && nextIndex >= 0 && nextIndex < request.questions.length) {
      update(request, current => ({ ...current, index: nextIndex, notice: undefined }));
    }
  };

  const setNotice = (notice: string | undefined) => {
    if (request) update(request, current => ({ ...current, notice }));
  };

  async function addImages(files: readonly File[]) {
    if (!request || files.length === 0) return;
    const current = readDraft(draftsRef.current, request);
    if (current.loadingImages) return;
    const available = COMPOSER_MAX_IMAGES - Object.values(current.answers).reduce((count, item) => count + item.images.length, 0);
    if (available <= 0) {
      setNotice(t("approval.clarification.imageLimit", { count: COMPOSER_MAX_IMAGES }));
      return;
    }
    if (!update(request, value => ({ ...value, loadingImages: true, notice: undefined }))) return;
    const additions: ComposerImageAttachment[] = [];
    let notice: string | undefined;
    try {
      if (!window.eco?.stagePromptImage) throw new Error(t("approval.clarification.imageUnavailable"));
      let invalid = false;
      for (const file of files) {
        if (additions.length >= available) {
          notice = t("approval.clarification.imageLimit", { count: COMPOSER_MAX_IMAGES });
          break;
        }
        const image = await readImageFileAsAttachment(file);
        if (!image) {
          invalid = true;
          continue;
        }
        try {
          const staged = await window.eco.stagePromptImage({
            contextKey: `thread:${request.threadId}:clarification:${request.toolUseId}`,
            imageId: image.id,
            mediaType: image.mediaType,
            data: image.data!,
          });
          additions.push({ id: image.id, mediaType: image.mediaType, previewUrl: image.previewUrl, ...staged });
        } catch (error) {
          discardImages([image]);
          throw error;
        }
      }
      if (invalid) notice = t("activity.editImageUnavailable");
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    } finally {
      const kept = update(request, value => {
        const row = value.answers[index] ?? EMPTY_ANSWER;
        return updateAnswer({ ...value, loadingImages: false, notice }, index, {
          ...row, images: [...row.images, ...additions],
        });
      });
      if (!kept) discardImages(additions);
    }
  }

  function removeImage(id: string) {
    if (!request) return;
    update(request, current => {
      const row = current.answers[index] ?? EMPTY_ANSWER;
      discardImages(row.images.filter(image => image.id === id));
      return updateAnswer(current, index, { ...row, images: row.images.filter(image => image.id !== id) });
    });
  }

  function buildSubmission() {
    if (!request) return undefined;
    const { answers, index: currentIndex, loadingImages } = readDraft(draftsRef.current, request);
    if (loadingImages || currentIndex !== request.questions.length - 1 ||
      !request.questions.every((_, i) => hasAnswer(answers[i]))) return undefined;
    const images: ComposerImageAttachment[] = [];
    const selections = request.questions.map((_, i) => {
      const item = answers[i] ?? EMPTY_ANSWER;
      const text = item.text.trim();
      if (!item.images.length) return [text];
      // The message carries one ordered attachment list. Label each answer's
      // images so the model can distinguish them in a multi-question reply.
      const first = images.length + 1;
      images.push(...item.images);
      const indices = Array.from({ length: item.images.length }, (_, offset) => first + offset).join(", ");
      const label = t("approval.clarification.attachedImages", { indices });
      return [text ? `${text}\n\n${label}` : label];
    });
    return { selections, attachments: toPromptImageAttachments(images) };
  }

  return {
    index, text: answer.text, images: answer.images, last, ready,
    loadingImages: Boolean(draft?.loadingImages), notice: draft?.notice,
    setText, setIndex, setNotice, addImages, removeImage, buildSubmission,
  };
}

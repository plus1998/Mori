import { expect, test } from "bun:test";
import {
  advanceImageGalleryQueue,
  appendImageGalleryItems,
  type ImageGalleryQueueItem,
  imageGalleryDisplayItem,
  imageGalleryGenerationItem,
} from "../src/renderer/image-gallery-float-state";

function item(key: string, kind: ImageGalleryQueueItem["kind"], artifactId: string) {
  return { key, kind, artifactId };
}

test("item factories produce stable unique keys", () => {
  expect(imageGalleryDisplayItem("art-1").key).toBe("display:art-1");
  expect(imageGalleryGenerationItem("art-1", 0).key).toBe("generation:art-1:0");
  expect(imageGalleryGenerationItem("art-1", 1).key).not.toBe(imageGalleryGenerationItem("art-1", 0).key);
});

test("appendImageGalleryItems appends new items and keeps queue order", () => {
  const queue: ImageGalleryQueueItem[] = [item("a", "display", "a")];
  const next = appendImageGalleryItems(queue, [item("b", "generation", "b"), item("c", "generation", "c")]);
  expect(next.map((entry) => entry.key)).toEqual(["a", "b", "c"]);
});

test("appendImageGalleryItems dedupes by key for repeated tool events", () => {
  const first = imageGalleryDisplayItem("art-1");
  const queue = appendImageGalleryItems([], [first]);
  const again = appendImageGalleryItems(queue, [imageGalleryDisplayItem("art-1")]);
  expect(again).toHaveLength(1);
});

test("appendImageGalleryItems keeps existing queue when nothing is fresh", () => {
  const queue = [item("a", "display", "a")];
  const next = appendImageGalleryItems(queue, []);
  expect(next).toHaveLength(1);
  expect(next[0]).toBe(queue[0]);
});

test("advanceImageGalleryQueue closes the current image and exposes the next", () => {
  const queue = [
    imageGalleryGenerationItem("art-1", 0),
    imageGalleryGenerationItem("art-1", 1),
    imageGalleryDisplayItem("art-2"),
  ];
  expect(advanceImageGalleryQueue(queue).map((entry) => entry.key)).toEqual([
    "generation:art-1:1",
    "display:art-2",
  ]);
  expect(advanceImageGalleryQueue(advanceImageGalleryQueue(queue))).toEqual([
    imageGalleryDisplayItem("art-2"),
  ]);
  expect(advanceImageGalleryQueue(advanceImageGalleryQueue(advanceImageGalleryQueue(queue)))).toEqual([]);
});

test("closing a browsed image removes that image and preserves the others in order", () => {
  const queue = [
    imageGalleryDisplayItem("first"),
    imageGalleryDisplayItem("second"),
    imageGalleryDisplayItem("third"),
  ];
  expect(advanceImageGalleryQueue(queue, "display:second")).toEqual([queue[0], queue[2]]);
  expect(advanceImageGalleryQueue(queue, "already-closed")).toEqual(queue);
  expect(advanceImageGalleryQueue([])).toEqual([]);
});

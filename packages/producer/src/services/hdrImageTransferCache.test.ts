import { describe, expect, test } from "bun:test";
import { convertTransfer } from "@hyperframes/engine";
import { createHdrImageTransferCache } from "./hdrImageTransferCache.ts";

/**
 * Build a deterministic rgb48le buffer for `pixelCount` pixels.
 * Each pixel is 3 channels × 2 bytes = 6 bytes. Values vary per pixel/channel
 * so the LUT-based `convertTransfer` produces bytes that differ from the
 * source.
 */
function makeSourceBuffer(pixelCount: number, seed = 0): Buffer {
  const buf = Buffer.alloc(pixelCount * 6);
  for (let i = 0; i < pixelCount; i++) {
    const off = i * 6;
    // Spread values across the 16-bit range so HLG↔PQ LUT lookups land on
    // mid-curve entries that are guaranteed to differ from the input.
    buf.writeUInt16LE((seed + i * 257) & 0xff_ff, off);
    buf.writeUInt16LE((seed + i * 521 + 1) & 0xff_ff, off + 2);
    buf.writeUInt16LE((seed + i * 1031 + 2) & 0xff_ff, off + 4);
  }
  return buf;
}

function expectedConverted(source: Buffer, from: "hlg" | "pq", to: "hlg" | "pq"): Buffer {
  const copy = Buffer.from(source);
  convertTransfer(copy, from, to);
  return copy;
}

describe("hdrImageTransferCache", () => {
  test("returns source buffer unchanged when sourceTransfer === targetTransfer", () => {
    const cache = createHdrImageTransferCache();
    const source = makeSourceBuffer(4);

    const result = cache.getConverted("img1", "pq", "pq", source);

    expect(result).toBe(source);
    expect(cache.size()).toBe(0);
  });

  test("first miss converts and caches", () => {
    const cache = createHdrImageTransferCache();
    const source = makeSourceBuffer(4);
    const expected = expectedConverted(source, "hlg", "pq");

    const result = cache.getConverted("img1", "hlg", "pq", source);

    expect(result).not.toBe(source);
    expect(Buffer.compare(result, expected)).toBe(0);
    expect(cache.size()).toBe(1);
  });

  test("second hit returns cached buffer reference", () => {
    const cache = createHdrImageTransferCache();
    const source = makeSourceBuffer(4);

    const first = cache.getConverted("img1", "hlg", "pq", source);
    const second = cache.getConverted("img1", "hlg", "pq", source);

    expect(second).toBe(first);
    expect(cache.size()).toBe(1);
  });

  test("does not re-run convertTransfer on cache hit", () => {
    const cache = createHdrImageTransferCache();
    const source = makeSourceBuffer(4);

    const first = cache.getConverted("img1", "hlg", "pq", source);
    const snapshot = Buffer.from(first);
    // If a hit ran convertTransfer again on the cached buffer (PQ→PQ would
    // be a no-op, but PQ→HLG would mutate), the bytes would change.
    cache.getConverted("img1", "hlg", "pq", source);

    expect(Buffer.compare(first, snapshot)).toBe(0);
  });

  test("different target transfers for same imageId are cached independently", () => {
    const cache = createHdrImageTransferCache();
    const source = makeSourceBuffer(4);

    const toPq = cache.getConverted("img1", "hlg", "pq", source);
    const toHlg = cache.getConverted("img1", "pq", "hlg", source);

    expect(toPq).not.toBe(toHlg);
    expect(Buffer.compare(toPq, expectedConverted(source, "hlg", "pq"))).toBe(0);
    expect(Buffer.compare(toHlg, expectedConverted(source, "pq", "hlg"))).toBe(0);
    expect(cache.size()).toBe(2);
  });

  test("different imageIds are cached independently", () => {
    const cache = createHdrImageTransferCache();
    const a = makeSourceBuffer(4, 100);
    const b = makeSourceBuffer(4, 200);

    const convA = cache.getConverted("a", "hlg", "pq", a);
    const convB = cache.getConverted("b", "hlg", "pq", b);

    expect(convA).not.toBe(convB);
    expect(Buffer.compare(convA, expectedConverted(a, "hlg", "pq"))).toBe(0);
    expect(Buffer.compare(convB, expectedConverted(b, "hlg", "pq"))).toBe(0);
    expect(cache.size()).toBe(2);
  });

  test("LRU evicts oldest entry when maxEntries exceeded", () => {
    const cache = createHdrImageTransferCache({ maxEntries: 2 });
    const a = makeSourceBuffer(2, 1);
    const b = makeSourceBuffer(2, 2);
    const c = makeSourceBuffer(2, 3);

    const convA1 = cache.getConverted("a", "hlg", "pq", a);
    cache.getConverted("b", "hlg", "pq", b);
    cache.getConverted("c", "hlg", "pq", c);

    expect(cache.size()).toBe(2);

    const convA2 = cache.getConverted("a", "hlg", "pq", a);
    expect(convA2).not.toBe(convA1);
    expect(Buffer.compare(convA2, expectedConverted(a, "hlg", "pq"))).toBe(0);
  });

  test("access promotes entry to most-recently-used", () => {
    const cache = createHdrImageTransferCache({ maxEntries: 2 });
    const a = makeSourceBuffer(2, 1);
    const b = makeSourceBuffer(2, 2);
    const c = makeSourceBuffer(2, 3);

    const convA1 = cache.getConverted("a", "hlg", "pq", a);
    cache.getConverted("b", "hlg", "pq", b);

    const convA2 = cache.getConverted("a", "hlg", "pq", a);
    expect(convA2).toBe(convA1);

    cache.getConverted("c", "hlg", "pq", c);

    const convA3 = cache.getConverted("a", "hlg", "pq", a);
    expect(convA3).toBe(convA1);

    const convB2 = cache.getConverted("b", "hlg", "pq", b);
    expect(Buffer.compare(convB2, expectedConverted(b, "hlg", "pq"))).toBe(0);
    expect(cache.size()).toBe(2);
  });

  test("maxEntries: 0 disables caching but still returns correct converted bytes", () => {
    const cache = createHdrImageTransferCache({ maxEntries: 0 });
    const source = makeSourceBuffer(4);
    const expected = expectedConverted(source, "hlg", "pq");

    const first = cache.getConverted("img1", "hlg", "pq", source);
    const second = cache.getConverted("img1", "hlg", "pq", source);

    expect(first).not.toBe(second);
    expect(Buffer.compare(first, expected)).toBe(0);
    expect(Buffer.compare(second, expected)).toBe(0);
    expect(cache.size()).toBe(0);
  });

  test("cached buffer is independent from the source buffer", () => {
    const cache = createHdrImageTransferCache();
    const source = makeSourceBuffer(4);
    const sourceSnapshot = Buffer.from(source);

    const cached = cache.getConverted("img1", "hlg", "pq", source);
    source.fill(0);

    expect(cache.getConverted("img1", "hlg", "pq", source)).toBe(cached);
    expect(Buffer.compare(cached, expectedConverted(sourceSnapshot, "hlg", "pq"))).toBe(0);
  });

  // Source-buffer-immutability guarantee (PR #384 review feedback): the cache
  // MUST NOT mutate the source buffer the caller hands in, on any path.
  // `convertTransfer` mutates in place, so the implementation has to clone
  // before converting — these tests pin the invariant against future
  // refactors that might forget the `Buffer.from(source)` defense.

  test("does not mutate the source buffer on a convert+cache miss", () => {
    const cache = createHdrImageTransferCache();
    const source = makeSourceBuffer(4);
    const sourceSnapshot = Buffer.from(source);

    cache.getConverted("img1", "hlg", "pq", source);

    expect(Buffer.compare(source, sourceSnapshot)).toBe(0);
  });

  test("does not mutate the source buffer on a convert+cache miss with maxEntries=0 passthrough", () => {
    const cache = createHdrImageTransferCache({ maxEntries: 0 });
    const source = makeSourceBuffer(4);
    const sourceSnapshot = Buffer.from(source);

    const result = cache.getConverted("img1", "hlg", "pq", source);

    expect(Buffer.compare(source, sourceSnapshot)).toBe(0);
    expect(result).not.toBe(source);
    expect(Buffer.compare(result, expectedConverted(sourceSnapshot, "hlg", "pq"))).toBe(0);
    expect(cache.size()).toBe(0);
  });

  test("does not mutate the source buffer on a cache hit", () => {
    const cache = createHdrImageTransferCache();
    const source = makeSourceBuffer(4);
    const sourceSnapshot = Buffer.from(source);

    cache.getConverted("img1", "hlg", "pq", source);
    cache.getConverted("img1", "hlg", "pq", source);

    expect(Buffer.compare(source, sourceSnapshot)).toBe(0);
  });

  test("rejects invalid maxEntries", () => {
    expect(() => createHdrImageTransferCache({ maxEntries: -1 })).toThrow();
    expect(() => createHdrImageTransferCache({ maxEntries: 1.5 })).toThrow();
    expect(() => createHdrImageTransferCache({ maxEntries: Number.NaN })).toThrow();
  });

  test("default maxEntries is large enough for typical compositions", () => {
    const cache = createHdrImageTransferCache();
    const source = makeSourceBuffer(2);

    for (let i = 0; i < 16; i++) {
      cache.getConverted(`img${i}`, "hlg", "pq", source);
    }
    expect(cache.size()).toBe(16);

    // The first inserted entry should still be present (no eviction yet).
    const first = cache.getConverted("img0", "hlg", "pq", source);
    expect(Buffer.compare(first, expectedConverted(source, "hlg", "pq"))).toBe(0);
    expect(cache.size()).toBe(16);
  });
});

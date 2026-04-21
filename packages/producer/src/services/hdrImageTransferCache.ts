import { type HdrTransfer, convertTransfer } from "@hyperframes/engine";

/**
 * Cache of transfer-converted HDR image buffers keyed by
 * `(imageId, targetTransfer)`.
 *
 * ## Why this exists
 *
 * Static HDR images are decoded once per render at setup time and stored as
 * `rgb48le` buffers in `hdrImageBuffers`. When the encode target's transfer
 * function (e.g. `pq`) differs from the image's source transfer (e.g. `hlg`),
 * `blitHdrImageLayer` must run an LUT-based transfer conversion before
 * blitting. `convertTransfer` mutates its input in-place, so the call site
 * has historically allocated a fresh `Buffer.from(buf.data)` clone every
 * frame to keep the original decode pristine for subsequent frames.
 *
 * For a 30 s, 60 fps, 1080p render with one HDR image, that's:
 *
 * - ~1800 × `Buffer.from(...)` allocations (~12 MB each → ~22 GB churn)
 * - ~1800 × ~6 M LUT lookups in `convertTransfer`
 *
 * Both are pure functions of `(source bytes, sourceTransfer, targetTransfer)`,
 * and within a single render job the source bytes for a given `imageId` are
 * fixed. Caching the converted buffer per `(imageId, targetTransfer)` reduces
 * the work to one allocation and one LUT pass per unique pair — independent
 * of frame count.
 *
 * ## Lifetime
 *
 * Instances are constructed per render job and dropped on job exit (success
 * or failure) by going out of scope. **Do not reuse a single cache across
 * jobs** — `imageId` collisions could return stale converted bytes from a
 * different source buffer.
 *
 * ## Bounds
 *
 * The cache is LRU-bounded by entry count (default 16). At 1080p each entry
 * is ~12 MB, so the default cap is ~200 MB worst case. Compositions with
 * more unique HDR images than `maxEntries` will evict older entries on a
 * least-recently-used basis; cache misses just rebuild the converted buffer.
 *
 * ## Caller contract
 *
 * The buffer returned by `getConverted` is shared cache state and **MUST NOT
 * be mutated** by the caller. All downstream HDR blit functions
 * (`blitRgb48leAffine`, `blitRgb48leRegion`) read from it without writing,
 * so this is naturally upheld today.
 */
export interface HdrImageTransferCache {
  /**
   * Return a buffer in `targetTransfer` for the given image.
   *
   * - When `sourceTransfer === targetTransfer`, returns `source` unchanged
   *   (no allocation, no caching).
   * - On the first call for `(imageId, targetTransfer)`, clones `source`,
   *   converts in-place via {@link convertTransfer}, caches the result, and
   *   returns it.
   * - On subsequent calls with the same `(imageId, targetTransfer)`, returns
   *   the cached buffer (and promotes it to most-recently-used).
   *
   * The returned buffer is read-only from the caller's perspective.
   */
  getConverted(
    imageId: string,
    sourceTransfer: HdrTransfer,
    targetTransfer: HdrTransfer,
    source: Buffer,
  ): Buffer;

  /** Number of currently cached entries. Diagnostic / test aid. */
  size(): number;
}

export interface HdrImageTransferCacheOptions {
  /**
   * Maximum number of converted buffers to retain before evicting the
   * least-recently-used entry. Defaults to 16. Must be a non-negative
   * integer; `0` disables caching entirely (every call allocates fresh).
   */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 16;

export function createHdrImageTransferCache(
  options: HdrImageTransferCacheOptions = {},
): HdrImageTransferCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isInteger(maxEntries) || maxEntries < 0) {
    throw new Error(
      `createHdrImageTransferCache: maxEntries must be a non-negative integer, got ${String(maxEntries)}`,
    );
  }

  // Map iteration order is insertion order in JS, so promoting an entry to
  // most-recently-used is just a `delete` + `set`. The first key in the
  // iterator is therefore the LRU candidate.
  const entries = new Map<string, Buffer>();

  function makeKey(imageId: string, targetTransfer: HdrTransfer): string {
    return `${imageId}|${targetTransfer}`;
  }

  return {
    getConverted(imageId, sourceTransfer, targetTransfer, source) {
      if (sourceTransfer === targetTransfer) {
        return source;
      }

      if (maxEntries === 0) {
        const fresh = Buffer.from(source);
        convertTransfer(fresh, sourceTransfer, targetTransfer);
        return fresh;
      }

      const key = makeKey(imageId, targetTransfer);
      const existing = entries.get(key);
      if (existing) {
        // Promote to MRU.
        entries.delete(key);
        entries.set(key, existing);
        return existing;
      }

      const converted = Buffer.from(source);
      convertTransfer(converted, sourceTransfer, targetTransfer);

      if (entries.size >= maxEntries) {
        // Evict LRU (first key in insertion-ordered iterator).
        const lruKey = entries.keys().next().value;
        if (lruKey !== undefined) {
          entries.delete(lruKey);
        }
      }
      entries.set(key, converted);
      return converted;
    },

    size() {
      return entries.size;
    },
  };
}

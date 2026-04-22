# hdr-image-only

Regression test that locks down end-to-end **HDR still-image** rendering — no
HDR video source involved.

## What it covers

- `parseImageElements` discovers the `<img>` source.
- `extractStillImageMetadata` (via `ffprobe`) probes the PNG and reads the
  `cICP` chunk, surfacing `colorPrimaries=bt2020`, `colorTransfer=smpte2084`.
- `isHdrColorSpace` flips the orchestrator into the layered HDR path even
  though `hdrVideoColorSpace` is null (image-only compositions must still
  trigger HDR).
- The image is decoded once into `rgb48le` and blitted under the SDR DOM
  overlay on every frame.
- The encoder writes HEVC Main10 / `yuv420p10le` / BT.2020 PQ with HDR10
  mastering display + content light level metadata.
- The harness then visually compares the output against the golden
  `output/output.mp4` (PSNR ≥ 28).

## Fixture

`src/hdr-photo.png` — 256×144, 16-bit RGB, with a hand-injected `cICP` chunk
(primaries=BT.2020, transfer=SMPTE ST 2084, matrix=GBR, range=full).

ffmpeg is **not** used here because it does not embed `cICP` in PNGs — without
that chunk Chromium would not treat the file as HDR and the test would silently
fall back to SDR.

To regenerate the fixture:

```bash
python3 packages/producer/tests/hdr-image-only/scripts/generate-fixture.py
```

The script is deterministic (fixed dimensions, fixed gradient), so the PNG
hashes byte-for-byte across runs — safe to commit and diff in CI.

## Running

```bash
cd packages/producer
bun run regression hdr-image-only

bun run regression --update hdr-image-only
```

In CI it runs in the `hdr` shard alongside `hdr-pq`
(see `.github/workflows/regression.yml`).

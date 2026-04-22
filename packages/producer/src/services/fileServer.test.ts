import { describe, expect, it } from "bun:test";
import {
  HF_BRIDGE_SCRIPT,
  HF_EARLY_STUB,
  injectScriptsAtHeadStart,
  VIRTUAL_TIME_SHIM,
} from "./fileServer.js";

describe("injectScriptsIntoHtml", () => {
  it("injects the virtual time shim into head content before authored scripts", () => {
    const html = `<!DOCTYPE html>
<html>
<head><script>window.__order = ["authored-head"];</script></head>
<body><script>window.__order.push("authored-body");</script></body>
</html>`;

    const injected = injectScriptsAtHeadStart(html, [VIRTUAL_TIME_SHIM]);
    const injectedShimTag = `<script>${VIRTUAL_TIME_SHIM}</script>`;
    const authoredHeadTag = `<script>window.__order = ["authored-head"];</script>`;

    expect(injected.indexOf(injectedShimTag)).toBeGreaterThanOrEqual(0);
    expect(injected.indexOf(injectedShimTag)).toBeLessThan(injected.indexOf(authoredHeadTag));
  });

  it("supports iframe html by injecting pre-head scripts without body scripts", () => {
    const html =
      "<!DOCTYPE html><html><head></head><body><script>window.targetLoaded = true;</script></body></html>";

    const preInjected = injectScriptsAtHeadStart(html, [VIRTUAL_TIME_SHIM]);
    const final = preInjected;

    expect(final).toContain(VIRTUAL_TIME_SHIM);
    expect(final).not.toContain("bodyOnly = true");
  });

  it("propagates virtual time seeks into same-origin iframe documents", () => {
    expect(HF_BRIDGE_SCRIPT).toContain("function seekSameOriginChildFrames");
    expect(HF_BRIDGE_SCRIPT).toContain("childWindow.__HF_VIRTUAL_TIME__.seekToTime(nextTimeMs)");
    expect(HF_BRIDGE_SCRIPT).toContain("seekSameOriginChildFrames(window, nextTimeMs)");
  });
});

describe("HF_EARLY_STUB + HF_BRIDGE_SCRIPT integration", () => {
  /**
   * Simulates the real injection order in a Puppeteer page:
   *   1. HF_EARLY_STUB  (start of <head>, before everything)
   *   2. authored page scripts that write to window.__hf.transitions
   *      (e.g. @hyperframes/shader-transitions in <body>)
   *   3. HF_BRIDGE_SCRIPT (end of <body>, upgrades __hf with seek/duration)
   *
   * Regression test for the race condition where the bridge used to overwrite
   * window.__hf with a fresh object, dropping any fields user libraries
   * (notably `transitions`) had populated during page-script execution.
   * Without the early stub + patch-not-replace bridge, the engine never
   * detects shader transitions and HDR compositing falls back to plain DOM.
   */
  it("preserves __hf.transitions written by page scripts through bridge upgrade", () => {
    const sandbox: {
      window: Record<string, unknown> & {
        __hf?: { transitions?: unknown[]; seek?: (t: number) => void; duration?: number };
        __player?: { renderSeek: (t: number) => void; getDuration: () => number };
        setInterval: typeof setInterval;
        clearInterval: typeof clearInterval;
      };
      document: { querySelector: () => null };
    } = {
      window: {
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
      },
      document: { querySelector: () => null },
    };
    sandbox.window.window = sandbox.window;
    sandbox.window.document = sandbox.document;

    const run = (src: string): void => {
      new Function("window", "document", `with (window) {\n${src}\n}`)(
        sandbox.window,
        sandbox.document,
      );
    };

    run(HF_EARLY_STUB);
    expect(sandbox.window.__hf).toBeDefined();
    expect(sandbox.window.__hf?.transitions).toBeUndefined();

    sandbox.window.__hf!.transitions = [
      { time: 5, duration: 0.5, shader: "domain-warp", fromScene: "a", toScene: "b" },
    ];

    sandbox.window.__player = {
      renderSeek: () => {},
      getDuration: () => 30,
    };

    run(HF_BRIDGE_SCRIPT);

    expect(sandbox.window.__hf).toBeDefined();
    expect(sandbox.window.__hf?.transitions).toEqual([
      { time: 5, duration: 0.5, shader: "domain-warp", fromScene: "a", toScene: "b" },
    ]);
    expect(typeof sandbox.window.__hf?.seek).toBe("function");
    expect(sandbox.window.__hf?.duration).toBe(30);
  });
});

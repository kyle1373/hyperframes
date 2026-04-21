import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatTime, formatSpeed, SPEED_PRESETS } from "./controls.js";

// ── Controls unit tests ──

describe("SPEED_PRESETS", () => {
  it("contains logarithmic speed steps", () => {
    expect(SPEED_PRESETS).toEqual([0.25, 0.5, 1, 1.5, 2, 4]);
  });

  it("includes 1x as default speed", () => {
    expect(SPEED_PRESETS).toContain(1);
  });
});

describe("formatSpeed", () => {
  it("formats integer speeds", () => {
    expect(formatSpeed(1)).toBe("1x");
    expect(formatSpeed(2)).toBe("2x");
    expect(formatSpeed(4)).toBe("4x");
  });

  it("formats fractional speeds", () => {
    expect(formatSpeed(0.25)).toBe("0.25x");
    expect(formatSpeed(0.5)).toBe("0.5x");
    expect(formatSpeed(1.5)).toBe("1.5x");
  });
});

describe("formatTime", () => {
  it("formats 0 seconds", () => {
    expect(formatTime(0)).toBe("0:00");
  });

  it("formats seconds under a minute", () => {
    expect(formatTime(45)).toBe("0:45");
  });

  it("formats exact minutes", () => {
    expect(formatTime(120)).toBe("2:00");
  });

  it("formats minutes and seconds", () => {
    expect(formatTime(95)).toBe("1:35");
  });

  it("pads seconds with leading zero", () => {
    expect(formatTime(61)).toBe("1:01");
  });

  it("floors fractional seconds", () => {
    expect(formatTime(3.7)).toBe("0:03");
  });

  it("handles negative input", () => {
    expect(formatTime(-5)).toBe("0:00");
  });
});

// ── Parent-frame audio proxies (ownership-based) ──
//
// Parent-frame audio/video copies are preloaded mirror proxies of the iframe's
// timed media. They exist as a fallback for environments that block iframe
// `.play()`. Under the default `runtime` audio ownership, the iframe drives
// audible playback and the proxies stay paused. Ownership flips to `parent`
// only when the runtime posts `media-autoplay-blocked` — then the proxies
// become the audible source and the iframe is silenced via bridge.

describe("HyperframesPlayer parent-frame media", () => {
  type PlayerElement = HTMLElement & {
    play: () => void;
    pause: () => void;
    seek: (t: number) => void;
    _audioOwner?: "runtime" | "parent";
    _promoteToParentProxy?: () => void;
  };

  let player: PlayerElement;
  let mockAudio: {
    src: string;
    preload: string;
    muted: boolean;
    playbackRate: number;
    currentTime: number;
    paused: boolean;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await import("./hyperframes-player.js");

    mockAudio = {
      src: "",
      preload: "",
      muted: false,
      playbackRate: 1,
      currentTime: 0,
      paused: true,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      load: vi.fn(),
    };

    vi.spyOn(globalThis, "Audio").mockImplementation(
      () => mockAudio as unknown as HTMLAudioElement,
    );

    player = document.createElement("hyperframes-player") as PlayerElement;
  });

  afterEach(() => {
    player.remove();
    vi.restoreAllMocks();
  });

  it("includes audio-src in observedAttributes", () => {
    const Ctor = player.constructor as typeof HTMLElement & {
      observedAttributes: string[];
    };
    expect(Ctor.observedAttributes).toContain("audio-src");
  });

  it("creates Audio and starts preloading when audio-src is set", () => {
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    expect(globalThis.Audio).toHaveBeenCalled();
    expect(mockAudio.preload).toBe("auto");
    expect(mockAudio.src).toBe("https://cdn.example.com/narration.mp3");
    expect(mockAudio.load).toHaveBeenCalled();
  });

  it("syncs muted attribute to parent media", () => {
    player.setAttribute("muted", "");
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    expect(mockAudio.muted).toBe(true);
  });

  it("syncs playback-rate to parent media", () => {
    player.setAttribute("playback-rate", "1.5");
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    expect(mockAudio.playbackRate).toBe(1.5);
  });

  it("play() does NOT start parent-proxy under runtime ownership", () => {
    // Default ownership is `runtime` — the iframe drives audible playback.
    // If we also started parent proxies here, both would play and the user
    // would hear doubled, slightly-offset audio (the original bug).
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    player.play();
    expect(mockAudio.play).not.toHaveBeenCalled();
    expect(player._audioOwner).toBe("runtime");
  });

  it("pause() does NOT touch parent-proxy under runtime ownership", () => {
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    player.pause();
    expect(mockAudio.pause).not.toHaveBeenCalled();
  });

  it("seek() does NOT update parent currentTime under runtime ownership", () => {
    // Under runtime ownership the iframe is authoritative for time; touching
    // the proxy's currentTime would just trigger a re-buffer for no gain.
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    player.seek(12.5);
    expect(mockAudio.currentTime).toBe(0);
  });

  it("after promotion to parent ownership: play/pause/seek drive parent proxy", () => {
    // Simulates the runtime having posted `media-autoplay-blocked`. Post
    // promotion: the web component owns audible output and fully drives
    // the parent proxy.
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    player._promoteToParentProxy?.();
    expect(player._audioOwner).toBe("parent");

    player.play();
    expect(mockAudio.play).toHaveBeenCalled();

    player.seek(12.5);
    expect(mockAudio.currentTime).toBe(12.5);

    player.pause();
    expect(mockAudio.pause).toHaveBeenCalled();
  });

  it("promotion is idempotent", () => {
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    player._promoteToParentProxy?.();
    player._promoteToParentProxy?.();
    player._promoteToParentProxy?.();
    // Only one play() attempt is triggered by promotion itself (gated on
    // `!this._paused`, which is true by default so it doesn't trigger at all).
    // The test's meaning is: ownership stays `parent`, no thrash, no errors.
    expect(player._audioOwner).toBe("parent");
  });

  it("dispatches audioownershipchange on promotion", () => {
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    const events: Array<{ owner: string; reason: string }> = [];
    player.addEventListener("audioownershipchange", (e: Event) => {
      const detail = (e as CustomEvent<{ owner: string; reason: string }>).detail;
      events.push(detail);
    });

    player._promoteToParentProxy?.();
    expect(events).toEqual([{ owner: "parent", reason: "autoplay-blocked" }]);

    // Second promote is idempotent — no duplicate event.
    player._promoteToParentProxy?.();
    expect(events).toHaveLength(1);
  });

  it("promotion mid-playback plays parent proxy immediately", () => {
    // Previously-missing coverage: if the user is already playing when
    // the runtime reports autoplay-blocked, the proxy must start audible
    // right away — not wait for the user to hit pause/play again.
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    player.play(); // `_paused = false`, owner still `runtime` → no parent play yet
    expect(mockAudio.play).not.toHaveBeenCalled();

    player._promoteToParentProxy?.();
    expect(mockAudio.play).toHaveBeenCalled();
  });

  it("surfaces playbackerror when parent proxy play() rejects", async () => {
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    const rejection = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
    mockAudio.play = vi.fn().mockRejectedValueOnce(rejection);

    const errors: unknown[] = [];
    player.addEventListener("playbackerror", (e: Event) => {
      errors.push((e as CustomEvent).detail);
    });

    player._promoteToParentProxy?.();
    player.play();
    // Promise rejection delivered on a microtask — flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as { source: string }).source).toBe("parent-proxy");
  });

  it("playbackerror dedup: fires at most once per parent-ownership session", async () => {
    // Under parent ownership with parent-also-blocked, every iframe
    // paused→playing transition in the state loop re-invokes `_playParentMedia`.
    // Without a latch, each rejection would re-fire `playbackerror`, spamming
    // subscribers. Mirrors the runtime's `mediaAutoplayBlockedPosted` latch.
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    const rejection = Object.assign(new Error("blocked"), { name: "NotAllowedError" });
    mockAudio.play = vi.fn().mockRejectedValue(rejection);

    const errors: unknown[] = [];
    player.addEventListener("playbackerror", (e: Event) => {
      errors.push((e as CustomEvent).detail);
    });

    player._promoteToParentProxy?.();
    player.play();
    player.pause();
    player.play();
    player.pause();
    player.play();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
  });

  it("cleans up parent media on disconnect", () => {
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    player.remove();
    expect(mockAudio.pause).toHaveBeenCalled();
    expect(mockAudio.src).toBe("");
  });

  it("updates parent media when playback-rate changes after setup", () => {
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    player.setAttribute("playback-rate", "2");
    expect(mockAudio.playbackRate).toBe(2);
  });

  it("updates parent media when muted toggles after setup", () => {
    player.setAttribute("audio-src", "https://cdn.example.com/narration.mp3");
    document.body.appendChild(player);

    player.setAttribute("muted", "");
    expect(mockAudio.muted).toBe(true);

    player.removeAttribute("muted");
    expect(mockAudio.muted).toBe(false);
  });
});

// ── Shared stylesheet (adoptedStyleSheets) ──
//
// Every player constructed in the same document should adopt the *same*
// CSSStyleSheet instance instead of getting its own <style> element. This is
// the studio thumbnail-grid win — N players, one parsed sheet.

describe("HyperframesPlayer adoptedStyleSheets", () => {
  type AdoptingShadowRoot = ShadowRoot & { adoptedStyleSheets: CSSStyleSheet[] };
  type PlayerWithShadow = HTMLElement & { shadowRoot: AdoptingShadowRoot | null };

  beforeEach(async () => {
    await import("./hyperframes-player.js");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shares a single CSSStyleSheet across multiple player instances", () => {
    const a = document.createElement("hyperframes-player") as PlayerWithShadow;
    const b = document.createElement("hyperframes-player") as PlayerWithShadow;
    document.body.appendChild(a);
    document.body.appendChild(b);

    const sheetsA = a.shadowRoot?.adoptedStyleSheets ?? [];
    const sheetsB = b.shadowRoot?.adoptedStyleSheets ?? [];

    expect(sheetsA.length).toBeGreaterThan(0);
    expect(sheetsB.length).toBeGreaterThan(0);
    expect(sheetsA.at(-1)).toBe(sheetsB.at(-1));
  });

  it("does not inject a per-instance <style> when adoption succeeds", () => {
    const player = document.createElement("hyperframes-player") as PlayerWithShadow;
    document.body.appendChild(player);

    expect(player.shadowRoot?.querySelector("style")).toBeNull();
  });
});

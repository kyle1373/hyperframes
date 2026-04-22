import type { RuntimeDeterministicAdapter } from "../types";

export function createWaapiAdapter(): RuntimeDeterministicAdapter {
  return {
    name: "waapi",
    discover: () => {},
    seek: (ctx) => {
      if (!document.getAnimations) return;
      const timeMs = Math.max(0, (Number(ctx.time) || 0) * 1000);
      for (const animation of document.getAnimations()) {
        try {
          animation.currentTime = timeMs;
        } catch {
          // ignore animations that reject currentTime writes
        }
        try {
          animation.pause();
        } catch {
          // infinite unresolved animations can throw here until currentTime resolves
        }
      }
    },
    pause: () => {
      if (!document.getAnimations) return;
      for (const animation of document.getAnimations()) {
        try {
          animation.pause();
        } catch {
          // ignore animation edge-cases
        }
      }
    },
  };
}

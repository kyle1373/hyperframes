import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { PORT_PROBE_HOSTS, testPortOnAllHosts } from "./portUtils.js";

// High-ephemeral range with runway so parallel test shards don't collide.
const BASE = 45_000;

const openServers: Server[] = [];

function allocFreePort(): number {
  return BASE + Math.floor(Math.random() * 1_000);
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
        }),
    ),
  );
  vi.restoreAllMocks();
});

describe("testPortOnAllHosts — real-socket behaviour (OS-dependent)", () => {
  // These exercise the real network stack. On Linux the buggy parallel
  // implementation reliably fails the first test (issue #309 repro); on
  // macOS the race is not deterministic so both old and new code pass
  // here. The sequential-contract test below is the platform-agnostic
  // regression gate.

  it("returns true for a genuinely free port (regression: #309)", async () => {
    const port = allocFreePort();
    const result = await testPortOnAllHosts(port);
    expect(result).toBe(true);
  });

  it("returns false when the port is occupied on 0.0.0.0", async () => {
    const port = allocFreePort();
    const blocker = createServer();
    openServers.push(blocker);
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ port, host: "0.0.0.0" }, () => resolve());
    });
    const result = await testPortOnAllHosts(port);
    expect(result).toBe(false);
  });
});

describe("testPortOnAllHosts — sequential contract (platform-agnostic)", () => {
  /**
   * Load-bearing regression test. Injects a recording fake probe that
   * holds each call open for a few ms and tracks how many are in flight.
   * The parallel (buggy) implementation would drive overlap to 4; the
   * sequential fix keeps it at 1. Deterministic on every OS.
   */
  it("runs host probes sequentially — never more than one concurrent", async () => {
    let inFlight = 0;
    let peakConcurrency = 0;
    const hostsProbed: string[] = [];

    const fakeProbe = async (_port: number, host: string): Promise<boolean> => {
      inFlight++;
      if (inFlight > peakConcurrency) peakConcurrency = inFlight;
      hostsProbed.push(host);
      // Hold so any parallel overlap from a regression would be visible
      // here regardless of OS scheduling.
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return true;
    };

    const result = await testPortOnAllHosts(7777, fakeProbe);

    expect(result).toBe(true);
    expect(peakConcurrency).toBe(1);
    expect(hostsProbed).toEqual([...PORT_PROBE_HOSTS]);
  });

  it("short-circuits on the first unavailable host", async () => {
    const hostsProbed: string[] = [];
    const fakeProbe = async (_port: number, host: string): Promise<boolean> => {
      hostsProbed.push(host);
      // Second host reports in-use; verify we never probe hosts three and four.
      return host === "127.0.0.1";
    };

    const result = await testPortOnAllHosts(7777, fakeProbe);

    expect(result).toBe(false);
    expect(hostsProbed).toEqual(["127.0.0.1", "0.0.0.0"]);
  });
});

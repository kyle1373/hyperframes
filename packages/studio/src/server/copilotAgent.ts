/**
 * Server-side Claude agent runner for the Studio Copilot.
 *
 * Architecture choice: instead of sending a single "rewrite this HTML"
 * prompt from the browser and writing back whatever Claude returns, this
 * runs a proper agentic loop *in the Studio's Node process* where the
 * model has tool access to the composition directory:
 *
 *     read_file(path)              →  fs.readFile, project-scoped
 *     write_file(path, content)    →  fs.writeFile
 *     edit_file(path, old, new)    →  single-occurrence search/replace
 *     list_files(path)             →  fs.readdir (shallow)
 *
 * The model decides what to read, what to change, and can iterate
 * multiple tool calls per turn. Every tool call + text delta streams
 * back to the browser via SSE so the Copilot panel shows live progress.
 *
 * Path safety: every tool resolves paths relative to the project
 * directory and rejects anything that escapes it. No absolute paths,
 * no `..` traversal.
 *
 * Model: defaults to Claude Opus 4. Users can override via the
 * `ANTHROPIC_MODEL` env var or per-request `model` field — the API
 * returns a clean error if the model ID isn't recognised.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, relative, sep } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface RunCopilotOptions {
  /** Anthropic API key. Either from ANTHROPIC_API_KEY env or from client. */
  apiKey: string;
  /** Absolute path to the project directory. All tool I/O is scoped here. */
  projectDir: string;
  /** Human-readable project identifier, used in prompt framing only. */
  projectId: string;
  /** User's prompt for this turn. */
  userPrompt: string;
  /** Optional: currently-selected element id, passed to the model as context. */
  selectedId?: string | null;
  /** Prior conversation turns in user/assistant pairs (oldest first). */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Model override. Defaults to the user's `ANTHROPIC_MODEL` env or Opus. */
  model?: string;
  /** Maximum tool-use iterations before we bail out (prevents runaway loops). */
  maxIterations?: number;
  /** AbortSignal to cancel the turn mid-flight. */
  signal?: AbortSignal;
  /** Event callback for streaming to the browser. */
  onEvent: (event: CopilotEvent) => void;
}

export type CopilotEvent =
  | { type: "status"; message: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  | { type: "turn_complete"; finalText: string }
  | { type: "error"; message: string }
  | { type: "done" };

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file within the composition project directory. Use relative paths like 'index.html' or 'compositions/scene-1.html'. Use this FIRST before editing anything, so you know the exact content.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the project root.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write complete new content to a file, replacing whatever is there. Use this when creating a new file or when the change is large enough that an edit_file search/replace would be brittle.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the project root.",
        },
        content: {
          type: "string",
          description: "Full file contents to write.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Replace a single occurrence of `old_text` with `new_text` in a file. The `old_text` must match EXACTLY, including whitespace. If `old_text` appears more than once, this call fails — use a longer snippet that uniquely identifies the edit location. Prefer this over write_file for surgical changes.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the project root." },
        old_text: {
          type: "string",
          description: "The exact existing text to replace. Must appear exactly once.",
        },
        new_text: {
          type: "string",
          description: "What to replace old_text with. Can be empty to delete.",
        },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "list_files",
    description:
      "List immediate children (files + directories) of a directory inside the project. Use path '.' for the project root. Returns entries one per line with '/' suffix on directories.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the project root. Use '.' for root.",
        },
      },
      required: ["path"],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// System prompt — teaches the model the composition format and rules
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert Hyperframes composition editor working as a co-pilot inside the Hyperframes Studio. You have TOOLS that let you directly read, edit, and write files in the user's composition project. USE THEM rather than guessing — you must read a file before editing it.

Composition file format:
• A composition is a single HTML file (usually 'index.html') with a <div id="stage" data-composition-id="main" data-duration="..." data-width="1920" data-height="1080"> root.
• It contains <style> and <script> blocks. The script builds a GSAP timeline that is registered on window.__timelines.main.
• Every visually-editable element has an 'id' attribute; the Studio auto-generates 'el-1', 'el-2', ... for elements the user hasn't named. Preserve existing ids.

Non-negotiable authoring rules:
1. GSAP timelines must be \`paused: true\` — never call .play() from the composition script.
2. Never use Math.random(), Date.now(), or any time-based value inside the composition script. Use a seeded PRNG (mulberry32 is fine) if randomness is needed.
3. Never use \`repeat: -1\` — always a finite, computed repeat count.
4. Preserve the window.__timelines registration — the player reads it to control playback.
5. Prefer additive CSS channels: the standalone \`translate\` and \`rotate\` properties compose with GSAP-animated \`transform\`. Use them when you want to shift an element without disturbing its animation.
6. Preserve existing element ids. When adding new elements, invent new stable ids that don't collide.
7. Deterministic rendering: the composition must render the same frame on every seek.

Workflow guidance:
• Start by list_files on '.' if you need orientation, otherwise go straight to read_file('index.html').
• Make the smallest change that satisfies the user. Don't rewrite the whole file when a 20-line edit_file will do.
• edit_file is MUCH safer than write_file — use it unless the change is genuinely sweeping.
• If you need to make multiple edits, issue them sequentially with edit_file. Each must match uniquely.
• After the final tool call, respond with a SHORT (1-3 sentence) summary of what you changed. The user sees your change visually in a live preview.

You are not verbose. You act. You explain briefly at the end.`;

// ─────────────────────────────────────────────────────────────────────────────
// Path safety
// ─────────────────────────────────────────────────────────────────────────────

function resolveSafePath(projectDir: string, userPath: string): string {
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new Error("path is required");
  }
  // Normalize and forbid escape from projectDir.
  const normalized = userPath === "." ? "" : userPath;
  const abs = resolve(projectDir, normalized);
  const rel = relative(projectDir, abs);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || rel.includes(`${sep}..${sep}`)) {
    throw new Error(`path escapes project directory: ${userPath}`);
  }
  return abs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool execution
// ─────────────────────────────────────────────────────────────────────────────

interface ToolExecutionResult {
  content: string;
  summary: string;
  ok: boolean;
}

function executeTool(projectDir: string, name: string, input: unknown): ToolExecutionResult {
  const args = input as Record<string, unknown>;
  try {
    if (name === "read_file") {
      const abs = resolveSafePath(projectDir, String(args.path));
      if (!existsSync(abs)) throw new Error(`file not found: ${args.path}`);
      const content = readFileSync(abs, "utf-8");
      return {
        ok: true,
        content,
        summary: `read ${args.path} (${content.length} bytes)`,
      };
    }
    if (name === "write_file") {
      const abs = resolveSafePath(projectDir, String(args.path));
      const content = String(args.content ?? "");
      writeFileSync(abs, content, "utf-8");
      return {
        ok: true,
        content: `Wrote ${content.length} bytes to ${args.path}.`,
        summary: `wrote ${args.path} (${content.length} bytes)`,
      };
    }
    if (name === "edit_file") {
      const abs = resolveSafePath(projectDir, String(args.path));
      if (!existsSync(abs)) throw new Error(`file not found: ${args.path}`);
      const oldText = String(args.old_text ?? "");
      const newText = String(args.new_text ?? "");
      if (oldText.length === 0) {
        throw new Error("edit_file requires a non-empty old_text");
      }
      const current = readFileSync(abs, "utf-8");
      const occurrences = countOccurrences(current, oldText);
      if (occurrences === 0) {
        throw new Error(
          `old_text not found in ${args.path}. Read the file again and copy the exact snippet.`,
        );
      }
      if (occurrences > 1) {
        throw new Error(
          `old_text appears ${occurrences} times in ${args.path}. Use a longer, more specific snippet so it matches exactly once.`,
        );
      }
      const next = current.replace(oldText, newText);
      writeFileSync(abs, next, "utf-8");
      return {
        ok: true,
        content: `Edited ${args.path}. Replaced 1 occurrence (${oldText.length} chars → ${newText.length} chars).`,
        summary: `edited ${args.path}`,
      };
    }
    if (name === "list_files") {
      const abs = resolveSafePath(projectDir, String(args.path));
      if (!existsSync(abs)) throw new Error(`directory not found: ${args.path}`);
      const st = statSync(abs);
      if (!st.isDirectory()) throw new Error(`not a directory: ${args.path}`);
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => !e.name.startsWith("."))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return {
        ok: true,
        content: entries.join("\n") || "(empty)",
        summary: `listed ${args.path} (${entries.length} entries)`,
      };
    }
    throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `Error: ${msg}`, summary: msg };
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main agent loop
// ─────────────────────────────────────────────────────────────────────────────

export async function runCopilotTurn(opts: RunCopilotOptions): Promise<void> {
  const {
    apiKey,
    projectDir,
    projectId,
    userPrompt,
    selectedId,
    history,
    model,
    maxIterations = 12,
    signal,
    onEvent,
  } = opts;

  // Model selection, in priority order:
  //   1. `model` field on the request body (per-turn override from the UI)
  //   2. `ANTHROPIC_MODEL` env var (shell override)
  //   3. claude-opus-4-7 default
  const effectiveModel = model ?? process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7";

  const client = new Anthropic({ apiKey });

  // Seed conversation with history + new user turn.
  const userContent =
    (selectedId
      ? `The user currently has the element \`#${selectedId}\` selected in the Studio preview. Factor this into your edits when relevant.\n\n`
      : "") +
    `Project: ${projectId}\n` +
    `Request: ${userPrompt}`;

  const messages: Anthropic.MessageParam[] = [
    ...(history ?? []).map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userContent },
  ];

  onEvent({
    type: "status",
    message: `Agent started with model ${effectiveModel}. Working directory: ${projectId}.`,
  });

  let finalText = "";

  for (let iter = 0; iter < maxIterations; iter++) {
    if (signal?.aborted) {
      onEvent({ type: "error", message: "Cancelled by user." });
      return;
    }

    const stream = client.messages.stream(
      {
        model: effectiveModel,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      },
      { signal },
    );

    // Collect content blocks as they arrive. Text blocks stream deltas;
    // tool_use blocks arrive as complete objects at content_block_stop.
    const contentBlocks: Anthropic.ContentBlock[] = [];
    let turnText = "";

    stream.on("text", (delta: string) => {
      onEvent({ type: "text_delta", text: delta });
      turnText += delta;
    });

    // Wait for the full message, then inspect its content blocks.
    const finalMessage = await stream.finalMessage();
    for (const block of finalMessage.content) {
      contentBlocks.push(block);
      if (block.type === "tool_use") {
        onEvent({ type: "tool_use", name: block.name, input: block.input });
      }
    }

    // Append the assistant's turn to history.
    messages.push({ role: "assistant", content: finalMessage.content });

    // Any tool uses?
    const toolUses = finalMessage.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    if (toolUses.length === 0) {
      // No more tools — the agent is done. Treat the last text as the summary.
      finalText = turnText;
      break;
    }

    // Execute each tool and build tool_result blocks for the next turn.
    const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => {
      const result = executeTool(projectDir, tu.name, tu.input);
      onEvent({
        type: "tool_result",
        name: tu.name,
        ok: result.ok,
        summary: result.summary,
      });
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: result.content,
        is_error: !result.ok,
      };
    });

    messages.push({ role: "user", content: toolResults });

    // Loop back — the model sees the results and decides what to do next.
  }

  onEvent({ type: "turn_complete", finalText });
  onEvent({ type: "done" });
}

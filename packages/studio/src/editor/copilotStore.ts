import { create } from "zustand";

/**
 * Messages in the Copilot conversation. Responses from the LLM include a
 * `patchedHtml` blob when we applied a change, so the user can preview /
 * revert / diff the edit.
 */
/** One rendered step of an assistant turn — either streamed text or a
    tool-use/result pair from the agentic loop. Shown in the transcript. */
export type CopilotStep =
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      name: string;
      input?: unknown;
      result?: { ok: boolean; summary: string };
      /** Set while the tool is running, unset once the server sends back
          its tool_result event. */
      pending?: boolean;
    }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string };

export interface CopilotMessage {
  id: string;
  role: "user" | "assistant";
  /** User messages are plain text. Assistant messages are a list of steps
      (text deltas, tool uses, tool results, status/error notes) that the
      panel renders inline to show the agent's reasoning. */
  text?: string;
  steps?: CopilotStep[];
  /** Unix ms. */
  ts: number;
  /** True while the agent is actively streaming this turn. */
  pending?: boolean;
}

interface CopilotState {
  /** Visibility of the Copilot panel in the right sidebar. */
  open: boolean;
  /** Claude API key; stored in localStorage under `hf-studio-claude-key`. */
  apiKey: string | null;
  /** Full conversation. */
  messages: CopilotMessage[];
  /** While this is true, the overlay locks itself (no drag/resize/etc.)
      so the user doesn't interfere with a live agent turn. */
  agentBusy: boolean;
  /** Prefilled text — used by the right-click "Ask AI" action to seed
      the input without clobbering anything the user typed. */
  pendingPrompt: string;
  /**
   * Element ids that currently have an agent turn running on them.
   * The overlay paints a blurred "loading" box over each busy element so
   * the user knows the AI is in the middle of editing that specific piece
   * without freezing the rest of the canvas. Tracked as an array (not a
   * Set) so Zustand's shallow equality still triggers re-renders.
   */
  busyElementIds: string[];

  setOpen: (v: boolean) => void;
  toggleOpen: () => void;
  setApiKey: (k: string | null) => void;
  addMessage: (m: CopilotMessage) => void;
  updateMessage: (id: string, patch: Partial<CopilotMessage>) => void;
  setAgentBusy: (v: boolean) => void;
  setPendingPrompt: (s: string) => void;
  clearConversation: () => void;
  startElementWork: (id: string) => void;
  endElementWork: (id: string) => void;
}

const STORAGE_KEY = "hf-studio-claude-key";

function loadApiKey(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v || null;
  } catch {
    return null;
  }
}

function persistApiKey(k: string | null): void {
  try {
    if (k) localStorage.setItem(STORAGE_KEY, k);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore quota/private-mode errors */
  }
}

export const useCopilotStore = create<CopilotState>((set) => ({
  open: false,
  apiKey: loadApiKey(),
  messages: [],
  agentBusy: false,
  pendingPrompt: "",
  busyElementIds: [],

  setOpen: (v) => set({ open: v }),
  toggleOpen: () => set((s) => ({ open: !s.open })),
  setApiKey: (k) => {
    persistApiKey(k);
    set({ apiKey: k });
  },
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  updateMessage: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),
  setAgentBusy: (v) => set({ agentBusy: v }),
  setPendingPrompt: (s) => set({ pendingPrompt: s }),
  clearConversation: () => set({ messages: [] }),
  startElementWork: (id) =>
    set((s) => (s.busyElementIds.includes(id) ? s : { busyElementIds: [...s.busyElementIds, id] })),
  endElementWork: (id) =>
    set((s) => ({ busyElementIds: s.busyElementIds.filter((x) => x !== id) })),
}));

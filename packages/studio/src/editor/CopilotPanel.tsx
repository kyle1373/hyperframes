import { useCallback, useEffect, useRef, useState } from "react";
import { useCopilotStore, type CopilotMessage, type CopilotStep } from "./copilotStore";
import { useDirectEditStore } from "./directEditStore";
import { streamCopilot, type CopilotServerEvent } from "./claudeClient";
import { fetchSource, saveSource } from "./htmlMutation";

interface CopilotPanelProps {
  projectId: string;
  filePath?: string;
  width: number;
}

// Client-only message id (UI key). Deterministic rendering rules don't
// apply here because nothing we write to disk depends on it.
function newMsgId(): string {
  return `m-${Math.floor(performance.now() * 1000)}-${Math.floor(Math.random() * 1e6)}`;
}

export function CopilotPanel({ projectId, filePath = "index.html", width }: CopilotPanelProps) {
  const messages = useCopilotStore((s) => s.messages);
  const addMessage = useCopilotStore((s) => s.addMessage);
  const updateMessage = useCopilotStore((s) => s.updateMessage);
  const apiKey = useCopilotStore((s) => s.apiKey);
  const setApiKey = useCopilotStore((s) => s.setApiKey);
  const agentBusy = useCopilotStore((s) => s.agentBusy);
  const setAgentBusy = useCopilotStore((s) => s.setAgentBusy);
  const pendingPrompt = useCopilotStore((s) => s.pendingPrompt);
  const setPendingPrompt = useCopilotStore((s) => s.setPendingPrompt);
  const clearConversation = useCopilotStore((s) => s.clearConversation);

  const selectedId = useDirectEditStore((s) => s.selectedId);

  const [input, setInput] = useState("");
  const [showKeyEditor, setShowKeyEditor] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [snapshots, setSnapshots] = useState<Record<string, string>>({});

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Seed input from the right-click "Ask AI" flow.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (pendingPrompt) {
      setInput((cur) => (cur ? cur : pendingPrompt));
      setPendingPrompt("");
    }
  }, [pendingPrompt, setPendingPrompt]);

  // Auto-scroll as the transcript grows.
  const latestUpdateKey = messages[messages.length - 1]
    ? `${messages[messages.length - 1].id}:${messages[messages.length - 1].steps?.length ?? 0}:${
        messages[messages.length - 1].text?.length ?? 0
      }`
    : "";
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, latestUpdateKey]);

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text || agentBusy) return;

    const userMsg: CopilotMessage = {
      id: newMsgId(),
      role: "user",
      text,
      ts: Date.now(),
    };
    addMessage(userMsg);
    setInput("");

    const assistantId = newMsgId();
    addMessage({
      id: assistantId,
      role: "assistant",
      steps: [],
      ts: Date.now(),
      pending: true,
    });

    setAgentBusy(true);
    abortRef.current = new AbortController();

    // Snapshot the main file so the user can revert a bad turn.
    try {
      const before = await fetchSource(projectId, filePath);
      setSnapshots((prev) => ({ ...prev, [assistantId]: before }));
    } catch {
      /* best-effort — revert just won't be offered */
    }

    // History for the server: collapse prior turns to role/content pairs,
    // excluding the still-pending assistant we just added.
    const history = messages
      .filter((m) => !m.pending)
      .map((m) => {
        if (m.role === "user") return { role: "user" as const, content: m.text ?? "" };
        const summary = (m.steps ?? [])
          .map((s) => {
            if (s.kind === "text") return s.text;
            if (s.kind === "tool") return `[used ${s.name}]`;
            return "";
          })
          .filter(Boolean)
          .join(" ");
        return { role: "assistant" as const, content: summary };
      });

    try {
      // Accumulate steps into the pending assistant message.
      const stepsRef: CopilotStep[] = [];
      let textCursor: CopilotStep | null = null;
      const toolByName = new Map<string, CopilotStep>();

      const commit = () => updateMessage(assistantId, { steps: [...stepsRef] });

      const onEvent = (event: CopilotServerEvent) => {
        switch (event.type) {
          case "status":
            stepsRef.push({ kind: "status", text: event.message });
            textCursor = null;
            commit();
            break;
          case "text_delta":
            if (!textCursor || textCursor.kind !== "text") {
              textCursor = { kind: "text", text: event.text };
              stepsRef.push(textCursor);
            } else {
              textCursor = { ...textCursor, text: textCursor.text + event.text };
              stepsRef[stepsRef.length - 1] = textCursor;
            }
            commit();
            break;
          case "tool_use": {
            const step: CopilotStep = {
              kind: "tool",
              name: event.name,
              input: event.input,
              pending: true,
            };
            stepsRef.push(step);
            toolByName.set(event.name + ":" + JSON.stringify(event.input), step);
            textCursor = null;
            commit();
            break;
          }
          case "tool_result": {
            // Find the most recent pending tool step with matching name.
            for (let i = stepsRef.length - 1; i >= 0; i--) {
              const s = stepsRef[i];
              if (s.kind === "tool" && s.name === event.name && s.pending) {
                stepsRef[i] = {
                  ...s,
                  pending: false,
                  result: { ok: event.ok, summary: event.summary },
                };
                break;
              }
            }
            commit();
            break;
          }
          case "turn_complete":
            // no-op: individual steps already committed.
            break;
          case "error":
            stepsRef.push({ kind: "error", text: event.message });
            commit();
            break;
          case "done":
            break;
        }
      };

      await streamCopilot({
        projectId,
        prompt: text,
        selectedId,
        history,
        apiKey: apiKey ?? undefined,
        signal: abortRef.current.signal,
        onEvent,
      });

      updateMessage(assistantId, { pending: false });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If we got an "API key required" error, auto-open the key editor.
      if (/api key/i.test(msg) && !apiKey) {
        setShowKeyEditor(true);
      }
      updateMessage(assistantId, {
        pending: false,
        steps: [
          ...(useCopilotStore.getState().messages.find((m) => m.id === assistantId)?.steps ?? []),
          {
            kind: "error",
            text: msg,
          },
        ],
      });
    } finally {
      abortRef.current = null;
      setAgentBusy(false);
    }
  }, [
    addMessage,
    agentBusy,
    apiKey,
    filePath,
    input,
    messages,
    projectId,
    selectedId,
    setAgentBusy,
    updateMessage,
  ]);

  const revert = useCallback(
    async (msgId: string) => {
      const snapshot = snapshots[msgId];
      if (!snapshot) return;
      try {
        await saveSource(projectId, snapshot, filePath);
        updateMessage(msgId, {
          steps: [
            ...(useCopilotStore.getState().messages.find((m) => m.id === msgId)?.steps ?? []),
            { kind: "status", text: `Reverted ${filePath} to pre-turn state.` },
          ],
        });
      } catch (err) {
        updateMessage(msgId, {
          steps: [
            ...(useCopilotStore.getState().messages.find((m) => m.id === msgId)?.steps ?? []),
            { kind: "error", text: err instanceof Error ? err.message : String(err) },
          ],
        });
      }
    },
    [filePath, projectId, snapshots, updateMessage],
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const onSubmitKey = () => {
    setApiKey(keyDraft.trim() || null);
    setShowKeyEditor(false);
    setKeyDraft("");
  };

  return (
    <div
      className="flex flex-col h-full bg-neutral-900 border-l border-neutral-800"
      style={{ width }}
    >
      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 border-b border-neutral-800 flex-shrink-0">
        <div className="flex items-center gap-2">
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: agentBusy ? "#38bdf8" : "#64748b",
              boxShadow: agentBusy ? "0 0 8px #38bdf8" : "none",
              transition: "background 0.2s",
            }}
          />
          <span className="text-[11px] font-medium text-neutral-300">Copilot</span>
          {agentBusy && (
            <span className="text-[10px] text-studio-accent tracking-widest uppercase">
              Working
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowKeyEditor((v) => !v)}
            className="h-6 px-2 text-[10px] text-neutral-400 hover:text-neutral-200 rounded hover:bg-neutral-800"
            title="Claude API key (optional; server env takes precedence)"
          >
            {apiKey ? "Key ✓" : "Set key"}
          </button>
          <button
            type="button"
            onClick={clearConversation}
            disabled={agentBusy}
            className="h-6 px-2 text-[10px] text-neutral-400 hover:text-neutral-200 rounded hover:bg-neutral-800 disabled:opacity-40"
            title="Clear conversation"
          >
            Clear
          </button>
        </div>
      </div>

      {/* API key editor */}
      {showKeyEditor && (
        <div className="p-3 border-b border-neutral-800 bg-neutral-950 flex-shrink-0">
          <div className="text-[10px] text-neutral-400 mb-2 leading-relaxed">
            Paste an Anthropic API key. Sent to the Studio dev server, used only to talk to{" "}
            <span className="font-mono text-neutral-300">api.anthropic.com</span>. Stored in
            localStorage. Tip: set <span className="font-mono">ANTHROPIC_API_KEY</span> in the
            Studio shell instead and the server will use it automatically.
          </div>
          <input
            type="password"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder="sk-ant-..."
            className="w-full h-8 px-2 bg-neutral-900 border border-neutral-700 rounded text-[11px] font-mono text-neutral-200 focus:outline-none focus:border-studio-accent"
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmitKey();
            }}
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              type="button"
              onClick={onSubmitKey}
              className="h-7 px-3 text-[11px] bg-studio-accent/20 text-studio-accent rounded hover:bg-studio-accent/30"
            >
              Save
            </button>
            {apiKey && (
              <button
                type="button"
                onClick={() => {
                  setApiKey(null);
                  setShowKeyEditor(false);
                }}
                className="h-7 px-3 text-[11px] text-neutral-400 hover:text-neutral-200"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && !agentBusy && (
          <div className="text-[11px] text-neutral-500 leading-relaxed">
            The agent has real file tools — it reads your composition, finds the exact spot to
            change, and edits in place. Try:
            <ul className="mt-2 space-y-1.5 pl-4 list-disc text-neutral-400">
              <li>
                <em>"Make the bird dots more blue, and add a subtle pulse after it forms."</em>
              </li>
              <li>
                <em>"Speed up the scatter-in by 30% and delay the caption by a second."</em>
              </li>
              <li>
                <em>"Add a third phrase 'What will you build?' between the first two."</em>
              </li>
              <li>
                <em>"The outro should slowly fade to black over 2 seconds."</em>
              </li>
            </ul>
            {selectedId && (
              <div className="mt-3 text-[10px] text-studio-accent/80">
                Selected: <span className="font-mono">#{selectedId}</span> — the agent will treat
                this element as the focus of your request.
              </div>
            )}
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            hasSnapshot={Boolean(snapshots[msg.id])}
            onRevert={() => revert(msg.id)}
          />
        ))}
      </div>

      {/* Composer */}
      <div className="border-t border-neutral-800 p-2 flex-shrink-0">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={
            selectedId
              ? `Ask the agent about #${selectedId}…`
              : "Ask the agent to change something…"
          }
          className="w-full h-20 p-2 bg-neutral-950 border border-neutral-800 rounded text-[12px] text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-studio-accent resize-none"
        />
        <div className="flex items-center justify-between mt-1.5">
          <div className="text-[10px] text-neutral-600">
            {selectedId ? (
              <>
                Context: <span className="font-mono text-neutral-400">#{selectedId}</span>
              </>
            ) : (
              "No element selected"
            )}
          </div>
          {agentBusy ? (
            <button
              type="button"
              onClick={cancel}
              className="h-7 px-3 text-[11px] bg-red-500/20 text-red-300 rounded hover:bg-red-500/30"
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!input.trim()}
              className="h-7 px-3 text-[11px] bg-studio-accent/20 text-studio-accent rounded hover:bg-studio-accent/30 disabled:opacity-40 disabled:hover:bg-studio-accent/20"
              title="Send (⌘+Enter)"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  msg,
  hasSnapshot,
  onRevert,
}: {
  msg: CopilotMessage;
  hasSnapshot: boolean;
  onRevert: () => void;
}) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className="max-w-[92%] rounded-lg px-2.5 py-2 text-[12px] leading-relaxed"
        style={{
          background: isUser ? "rgba(56, 189, 248, 0.12)" : "rgba(39, 39, 42, 0.9)",
          border: isUser ? "1px solid rgba(56, 189, 248, 0.25)" : "1px solid rgba(63, 63, 70, 0.6)",
          color: isUser ? "#e0f2fe" : "#e5e5e5",
        }}
      >
        {isUser ? (
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{msg.text}</div>
        ) : (
          <AssistantSteps steps={msg.steps ?? []} pending={Boolean(msg.pending)} />
        )}
        {!isUser && !msg.pending && hasSnapshot && (
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={onRevert}
              className="text-[10px] text-neutral-400 hover:text-neutral-200 underline underline-offset-2"
              title="Restore the main file to what it looked like before this turn"
            >
              Revert this turn
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantSteps({ steps, pending }: { steps: CopilotStep[]; pending: boolean }) {
  if (steps.length === 0 && pending) {
    return <div className="text-neutral-500 italic">Thinking…</div>;
  }
  return (
    <div className="space-y-1.5">
      {steps.map((step, i) => {
        if (step.kind === "text") {
          return (
            <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              {step.text}
              {pending && i === steps.length - 1 && (
                <span className="inline-block ml-1 text-studio-accent animate-pulse">▋</span>
              )}
            </div>
          );
        }
        if (step.kind === "status") {
          return (
            <div key={i} className="text-[10px] text-neutral-500 italic" style={{ paddingLeft: 2 }}>
              {step.text}
            </div>
          );
        }
        if (step.kind === "error") {
          return (
            <div
              key={i}
              className="text-[11px] text-red-400 rounded px-2 py-1"
              style={{ background: "rgba(239, 68, 68, 0.08)" }}
            >
              {step.text}
            </div>
          );
        }
        // Tool step
        return <ToolRow key={i} step={step} />;
      })}
    </div>
  );
}

function ToolRow({ step }: { step: Extract<CopilotStep, { kind: "tool" }> }) {
  const icon = step.pending ? "◌" : step.result?.ok === false ? "✕" : "✓";
  const color = step.pending ? "#64748b" : step.result?.ok === false ? "#f87171" : "#4ade80";
  const pathHint =
    step.input && typeof step.input === "object" && "path" in step.input
      ? String((step.input as { path: unknown }).path)
      : "";

  return (
    <div
      className="flex items-start gap-2 text-[11px] font-mono"
      style={{
        padding: "3px 6px",
        background: "rgba(12, 12, 16, 0.6)",
        border: "1px solid rgba(63, 63, 70, 0.45)",
        borderRadius: 4,
      }}
    >
      <span style={{ color, fontSize: 12, lineHeight: "14px" }}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div>
          <span style={{ color: "#cbd5e1" }}>{step.name}</span>
          {pathHint && <span style={{ color: "#94a3b8" }}> · {pathHint}</span>}
        </div>
        {step.result && (
          <div
            className="text-[10px]"
            style={{ color: step.result.ok ? "#94a3b8" : "#fca5a5", marginTop: 2 }}
          >
            {step.result.summary}
          </div>
        )}
      </div>
    </div>
  );
}

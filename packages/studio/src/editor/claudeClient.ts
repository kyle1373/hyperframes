// ─────────────────────────────────────────────────────────────────────────────
// Browser client for the server-side Studio Copilot agent.
//
// We no longer call Claude directly from the browser. Instead, the Studio
// dev server runs an agentic loop (see src/server/copilotAgent.ts) that
// gives Claude real file tools — read_file, edit_file, write_file,
// list_files — scoped to the active project directory. Tool calls and text
// deltas stream back here over Server-Sent Events.
//
// The advantage is substantial: the agent reads the composition,
// identifies the specific snippet it needs to change, and issues an
// edit_file with a surgical search/replace. Multi-turn tool iteration
// happens server-side, one HTTP request. No JSON envelope corruption, no
// full-file rewrites, no API key leaving the host process (if the user
// uses ANTHROPIC_API_KEY env).
// ─────────────────────────────────────────────────────────────────────────────

export type CopilotServerEvent =
  | { type: "status"; message: string }
  | { type: "text_delta"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; name: string; ok: boolean; summary: string }
  | { type: "turn_complete"; finalText: string }
  | { type: "error"; message: string }
  | { type: "done" };

export interface StreamCopilotInput {
  projectId: string;
  prompt: string;
  selectedId?: string | null;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Optional override. Leave undefined to use the server's default. */
  model?: string;
  /** Optional API key sent to the server. If omitted, the server uses
   *  its ANTHROPIC_API_KEY env var (preferred). */
  apiKey?: string;
  signal?: AbortSignal;
  onEvent: (event: CopilotServerEvent) => void;
}

/**
 * Call the server-side Copilot agent and deliver every event it emits to
 * `onEvent`. Resolves when the server closes the stream (normal completion
 * OR error). Throws if the request itself fails before streaming starts.
 */
export async function streamCopilot(input: StreamCopilotInput): Promise<void> {
  const { projectId, prompt, selectedId, history, model, apiKey, signal, onEvent } = input;

  const res = await fetch("/api/copilot/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      prompt,
      selectedId,
      history,
      model,
      apiKey,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    let message = `Copilot server error ${res.status}`;
    try {
      const errBody = await res.json();
      if (errBody && typeof errBody === "object" && "error" in errBody) {
        message = String((errBody as { error: unknown }).error);
      }
    } catch {
      /* empty body */
    }
    throw new Error(message);
  }

  // Parse SSE. Each message is
  //   event: <name>\n
  //   data: <json>\n
  //   \n
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffered = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let sep = buffered.indexOf("\n\n");
    while (sep !== -1) {
      const raw = buffered.slice(0, sep);
      buffered = buffered.slice(sep + 2);
      const event = parseSse(raw);
      if (event) onEvent(event);
      sep = buffered.indexOf("\n\n");
    }
  }
}

function parseSse(raw: string): CopilotServerEvent | null {
  const lines = raw.split("\n");
  let name: string | null = null;
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) dataParts.push(line.slice(5).trim());
  }
  if (!name || dataParts.length === 0) return null;
  try {
    const payload = JSON.parse(dataParts.join(""));
    return payload as CopilotServerEvent;
  } catch {
    return null;
  }
}

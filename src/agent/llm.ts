// Local LLM adapter. Talks to Ollama's HTTP API when it's running; otherwise
// reports unavailable so the agent falls back to deterministic mode. Free and
// offline — no API keys, no per-call cost.
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
export const MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:3b";

export interface LlmStatus {
  available: boolean;
  model: string;
  reason?: string;
}

let cached: LlmStatus | null = null;

export async function llmStatus(force = false): Promise<LlmStatus> {
  if (cached && !force) return cached;
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { models?: { name: string }[] };
    const names = (body.models ?? []).map((m) => m.name);
    const has = names.some((n) => n === MODEL || n.startsWith(MODEL.split(":")[0]));
    cached = has
      ? { available: true, model: MODEL }
      : { available: false, model: MODEL, reason: `model not pulled (have: ${names.join(", ") || "none"})` };
  } catch (err) {
    cached = { available: false, model: MODEL, reason: `ollama not reachable: ${(err as Error).message}` };
  }
  return cached;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Single chat completion. Requests JSON output; throws on any failure so the
 * caller can fall back to deterministic behavior. */
export async function chat(messages: ChatMessage[], timeoutMs = 45000): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      format: "json",
      options: { temperature: 0.7, num_predict: 300 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`ollama chat failed: HTTP ${res.status}`);
  const body = (await res.json()) as { message?: { content?: string } };
  const content = body.message?.content;
  if (!content) throw new Error("ollama returned empty content");
  return content;
}

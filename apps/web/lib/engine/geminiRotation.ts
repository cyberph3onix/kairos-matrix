// Gemini model rotation for free-tier keys (20 requests/DAY/model). Calls the native REST API
// directly and walks a configurable model list (GEMINI_MODELS, comma separated). A model that
// returns 429 is remembered as exhausted in-process until the retryDelay the API reports, so dead
// models are not re-called; 404/503/timeouts rotate to the next model too. Gemma models do not
// accept systemInstruction or JSON mime type, so the system prompt is folded into the user turn
// and ```json fences are stripped from the output.
// NOTE: this file is duplicated verbatim in apps/web/lib/engine/geminiRotation.ts.

export const DEFAULT_GEMINI_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-3.8-flash',
  'gemini-2.5-flash-lite',
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
];

export type GeminiFailureKind = 'rate_limit' | 'model_unavailable' | 'provider_unavailable' | 'timeout' | 'authentication' | 'invalid_request' | 'network' | 'empty_response';

export class GeminiCallError extends Error {
  constructor(readonly kind: GeminiFailureKind, message: string, readonly status?: number, readonly model?: string) {
    super(message);
    this.name = 'GeminiCallError';
  }
}

export function geminiModelList(): string[] {
  const raw = process.env.GEMINI_MODELS;
  const list = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (list.length) return [...new Set(list)];
  const primary = process.env.GEMINI_MODEL;
  return [...new Set([...(primary ? [primary] : []), ...DEFAULT_GEMINI_MODELS])];
}

const exhaustedUntil = new Map<string, { until: number; reason: string }>();
const MIN_DAILY_BACKOFF_MS = 15 * 60_000;

export function markGeminiModelExhausted(model: string, ms: number, reason: string): void {
  exhaustedUntil.set(model, { until: Date.now() + ms, reason });
}
export function geminiModelState(): { model: string; available: boolean; retryInMs: number; reason?: string }[] {
  const now = Date.now();
  return geminiModelList().map((model) => {
    const e = exhaustedUntil.get(model);
    const retryInMs = e && e.until > now ? e.until - now : 0;
    return { model, available: retryInMs === 0, retryInMs, reason: retryInMs ? e?.reason : undefined };
  });
}
export function resetGeminiExhaustion(): void {
  exhaustedUntil.clear();
}

export const isGemmaModel = (m: string): boolean => /^gemma/i.test(m);

/** Strips ```json fences and surrounding prose; returns the first balanced-looking JSON object when present. */
export function stripJsonFences(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  return t;
}

function parseRetryDelayMs(body: string): number | undefined {
  const m = body.match(/"retryDelay"\s*:\s*"([\d.]+)s"/) ?? body.match(/retry in ([\d.]+)s/i);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}

export interface GeminiGenerateParams {
  apiKey: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  json?: boolean;
  /** JSON schema enforced via responseJsonSchema (ignored for Gemma, which does not support it). */
  responseJsonSchema?: Record<string, unknown>;
  /** Override model list (defaults to geminiModelList()). */
  models?: string[];
  fetchImpl?: typeof fetch;
  onEvent?: (event: string, fields: Record<string, unknown>) => void;
}
export interface GeminiGenerateResult {
  text: string;
  model: string;
  attempted: string[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

async function callOnce(model: string, p: GeminiGenerateParams): Promise<GeminiGenerateResult> {
  const gemma = isGemmaModel(model);
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: gemma ? `${p.system}\n\n${p.user}` : p.user }] }],
    generationConfig: {
      maxOutputTokens: p.maxOutputTokens,
      temperature: p.temperature,
      ...((p.json || p.responseJsonSchema) && !gemma ? { responseMimeType: 'application/json' } : {}),
      ...(p.responseJsonSchema && !gemma ? { responseJsonSchema: p.responseJsonSchema } : {}),
    },
  };
  if (!gemma) body.systemInstruction = { parts: [{ text: p.system }] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs);
  let res: Response;
  try {
    res = await (p.fetchImpl ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': p.apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new GeminiCallError('timeout', `request timed out after ${p.timeoutMs}ms`, undefined, model);
    throw new GeminiCallError('network', err instanceof Error ? err.message : String(err), undefined, model);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const msg = `HTTP ${res.status} (${model}): ${text.slice(0, 400)}`;
    if (res.status === 429) {
      const delay = parseRetryDelayMs(text) ?? 60_000;
      const daily = /PerDay/i.test(text);
      markGeminiModelExhausted(model, Math.max(daily ? MIN_DAILY_BACKOFF_MS : 5_000, delay), daily ? 'daily quota' : 'rate limited');
      throw new GeminiCallError('rate_limit', msg, 429, model);
    }
    if (res.status === 404) {
      markGeminiModelExhausted(model, 60 * 60_000, 'model not found');
      throw new GeminiCallError('model_unavailable', msg, 404, model);
    }
    if (res.status >= 500) {
      markGeminiModelExhausted(model, 30_000, 'provider unavailable');
      throw new GeminiCallError('provider_unavailable', msg, res.status, model);
    }
    if (res.status === 401 || res.status === 403) throw new GeminiCallError('authentication', msg, res.status, model);
    throw new GeminiCallError('invalid_request', msg, res.status, model);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  let text = parts.filter((x) => !x.thought).map((x) => x.text ?? '').join('');
  if (p.json || p.responseJsonSchema || gemma) text = stripJsonFences(text);
  if (!text.trim()) throw new GeminiCallError('empty_response', `empty response from Gemini (${model})`, 200, model);
  return {
    text,
    model,
    attempted: [],
    usage: {
      promptTokens: json.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: json.usageMetadata?.totalTokenCount ?? 0,
    },
  };
}

/** Walks the model list, skipping models known exhausted, rotating on 429/404/5xx/timeout/empty. */
export async function geminiGenerate(p: GeminiGenerateParams): Promise<GeminiGenerateResult> {
  const models = p.models ?? geminiModelList();
  const now = Date.now();
  const live = models.filter((m) => (exhaustedUntil.get(m)?.until ?? 0) <= now);
  const attempted: string[] = [];
  let last: GeminiCallError | undefined;
  for (const model of live) {
    attempted.push(model);
    try {
      const r = await callOnce(model, p);
      r.attempted = attempted;
      return r;
    } catch (err) {
      const e = err instanceof GeminiCallError ? err : new GeminiCallError('network', err instanceof Error ? err.message : String(err), undefined, model);
      last = e;
      p.onEvent?.('gemini_model_failed', { model, kind: e.kind, status: e.status });
      if (e.kind === 'authentication') throw e;
      // timeouts/empty: skip this model for a short while so the next cycle doesn't repeat it
      if (e.kind === 'timeout' || e.kind === 'empty_response') markGeminiModelExhausted(model, 5 * 60_000, e.kind);
    }
  }
  if (!live.length) {
    const soonest = models.map((m) => exhaustedUntil.get(m)).filter(Boolean).sort((a, b) => a!.until - b!.until)[0];
    throw new GeminiCallError('rate_limit', `All Gemini models are exhausted/unavailable (${models.join(', ')})${soonest ? `; next retry in ${Math.ceil((soonest.until - now) / 1000)}s` : ''}`, 429);
  }
  throw last ?? new GeminiCallError('network', 'Gemini never attempted');
}

// Gemini provider — Google's native Gemini REST API with model rotation (see ../../geminiRotation.ts).
// Free-tier keys allow ~20 requests/day/model, so on 429/404/503/timeout the request rotates
// through GEMINI_MODELS (REASONING_MODEL, if set explicitly, is tried first). Gemma models get the
// system prompt folded into the user turn and fenced JSON stripped.
import { BaseProvider } from './baseProvider.js';
import { promptToChatMessages } from './openAiCompatible.js';
import { ProviderError } from './errors.js';
import { geminiGenerate, geminiModelList, GeminiCallError } from '../../geminiRotation.js';
import type { Prompt } from '../types.js';
import type { ProviderName, RawProviderResponse } from './types.js';

export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini';
  protected readonly providerName: ProviderName = 'gemini';
  /** Model that served the most recent successful request (for UI/audit). */
  lastModelUsed: string | null = null;

  protected async doRequest(prompt: Prompt, signal: AbortSignal): Promise<RawProviderResponse> {
    const [system, user] = promptToChatMessages(prompt);
    const explicit = process.env.REASONING_MODEL;
    const models = [...new Set([...(explicit ? [explicit] : []), ...geminiModelList()])];
    try {
      const r = await geminiGenerate({
        apiKey: this.config.apiKey,
        system: system.content,
        user: user.content,
        json: true,
        models,
        maxOutputTokens: this.config.maxTokens,
        temperature: this.config.temperature,
        timeoutMs: this.config.timeoutMs,
      });
      this.lastModelUsed = r.model;
      return {
        raw: r.text,
        usage: r.usage,
        requestId: `gemini-${Date.now()}`,
        providerVersion: `gemini:${r.model}`,
        fallbackCount: Math.max(0, r.attempted.length - 1),
      };
    } catch (err) {
      if (signal.aborted) throw new ProviderError('timeout', this.providerName, 'request aborted');
      if (err instanceof GeminiCallError) {
        const kind = ({ rate_limit: 'rate_limit', model_unavailable: 'model_unavailable', provider_unavailable: 'provider_unavailable', timeout: 'timeout', authentication: 'authentication', invalid_request: 'network', network: 'network', empty_response: 'empty_response' } as const)[err.kind];
        throw new ProviderError(kind, this.providerName, err.message);
      }
      throw err;
    }
  }
}

// Gemini provider — Google's Gemini API via its OpenAI-compatible Chat Completions endpoint
// (generativelanguage.googleapis.com/v1beta/openai). Reuses the shared request logic in
// openAiCompatible.ts — only the base URL and default model differ. Auth is the same Bearer
// header the shared client already sends (GEMINI_API_KEY).
import { BaseProvider } from './baseProvider.js';
import { requestOpenAiCompatibleChatCompletion } from './openAiCompatible.js';
import type { Prompt } from '../types.js';
import type { ProviderName, RawProviderResponse } from './types.js';

export const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

export class GeminiProvider extends BaseProvider {
  readonly name = 'gemini';
  protected readonly providerName: ProviderName = 'gemini';

  protected async doRequest(prompt: Prompt, signal: AbortSignal): Promise<RawProviderResponse> {
    return requestOpenAiCompatibleChatCompletion({
      baseUrl: this.config.baseUrl ?? GEMINI_OPENAI_BASE_URL,
      apiKey: this.config.apiKey,
      model: this.config.model,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      structuredOutput: this.config.structuredOutput,
      prompt,
      signal,
      providerName: this.providerName,
    });
  }
}

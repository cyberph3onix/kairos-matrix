/** Only the Gemini key getter is needed by the demo engine (copied from backend/src/config.ts). */
export function getGeminiApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || undefined;
}

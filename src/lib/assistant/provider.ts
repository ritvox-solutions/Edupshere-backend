import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

// Provider-agnostic on purpose: Groq, NVIDIA NIM, Together, Fireworks, and most
// other fast/free-tier inference hosts all expose an OpenAI-compatible chat
// completions endpoint, so switching providers is a 3-env-var change with no
// code change — no per-provider SDK to swap out.
let cachedModel: LanguageModel | null = null;

export function getAssistantModel(): LanguageModel {
  if (cachedModel) return cachedModel;

  const baseURL = process.env.ASSISTANT_BASE_URL;
  const apiKey = process.env.ASSISTANT_API_KEY;
  const modelId = process.env.ASSISTANT_MODEL;
  if (!baseURL || !apiKey || !modelId) {
    throw new Error("ASSISTANT_BASE_URL, ASSISTANT_API_KEY and ASSISTANT_MODEL must be set to use the assistant.");
  }

  const provider = createOpenAICompatible({ name: "assistant", baseURL, apiKey });
  cachedModel = provider(modelId);
  return cachedModel;
}

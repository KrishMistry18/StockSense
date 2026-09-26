import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type LanguageModel } from "ai";

/**
 * Correlates gateway requests so a run can be traced end to end. Only used by the
 * Lovable gateway, which echoes the run id back on the first response.
 */
function correlatedFetch() {
  let runId: string | undefined;
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (runId) headers.set("X-Lovable-AIG-Run-ID", runId);
    const response = await fetch(input, { ...init, headers });
    runId ??= response.headers.get("X-Lovable-AIG-Run-ID") ?? undefined;
    return response;
  };
}

// Derived from streamText's own signature so the shape cannot drift from the SDK.
type ProviderOptions = Parameters<typeof streamText>[0]["providerOptions"];
type ResolvedProvider = { model: LanguageModel; providerOptions?: ProviderOptions };

/**
 * Picks whichever AI provider is configured.
 *
 * OPENAI_API_KEY is checked first so the app can run on a backend of your own with no
 * dependency on Lovable. LOVABLE_API_KEY stays supported as a fallback for the managed
 * gateway. Set OPENAI_MODEL to override the model.
 */
function resolveProvider(): ResolvedProvider {
  const openaiKey = process.env['OPENAI_API_KEY'];
  if (openaiKey) {
    const provider = createOpenAI({ apiKey: openaiKey });
    return { model: provider(process.env['OPENAI_MODEL'] ?? "gpt-4o-mini") };
  }

  const lovableKey = process.env['LOVABLE_API_KEY'];
  if (lovableKey) {
    const provider = createOpenAI({
      baseURL: "https://ai.gateway.lovable.dev/v1",
      apiKey: lovableKey,
      headers: { "Lovable-API-Key": lovableKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
      fetch: correlatedFetch(),
    });
    return {
      model: provider.responses(process.env['LOVABLE_MODEL'] ?? "openai/gpt-6-astra"),
      providerOptions: { openai: { forceReasoning: true, reasoningEffort: "medium", reasoningSummary: "auto", store: false, include: ["reasoning.encrypted_content"] } },
    };
  }

  throw new Error("AI analysis is not configured. Set OPENAI_API_KEY in the server environment.");
}

const SYSTEM_PROMPT =
  "You are a careful inventory analyst. Use only supplied warehouse stock and movements. Identify at-risk SKUs first, explain why, and suggest specific replenishment quantities based on reorder points and recent net movement. Acknowledge that movements are not a demand forecast and never invent lead times or vendor details. Answer in short plain text with concise bullet points, maximum 250 words. Do not execute actions.";

export async function generateWarehouseAdvice(input: { warehouse: string; stock: unknown; movements: unknown }) {
  const { model, providerOptions } = resolveProvider();
  const result = streamText({
    model,
    ...(providerOptions ? { providerOptions } : {}),
    system: SYSTEM_PROMPT,
    prompt: `Warehouse: ${input.warehouse}\nCurrent stock by product (units are per product): ${JSON.stringify(input.stock)}\nRecent ledger movements (positive is stock in, negative is stock out): ${JSON.stringify(input.movements)}`,
  });
  const text = (await result.text).trim();
  if (!text) throw new Error("The analysis returned no advice. Please try again later.");
  return text;
}

import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

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

export async function generateWarehouseAdvice(input: { warehouse: string; stock: unknown; movements: unknown }) {
  const key = process.env['LOVABLE_API_KEY'];
  if (!key) throw new Error("AI analysis is not configured.");
  const provider = createOpenAI({
    baseURL: "https://ai.gateway.lovable.dev/v1",
    apiKey: key,
    headers: { "Lovable-API-Key": key, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    fetch: correlatedFetch(),
  });
  const result = streamText({
    model: provider.responses("openai/gpt-6-astra"),
    providerOptions: { openai: { forceReasoning: true, reasoningEffort: "medium", reasoningSummary: "auto", store: false, include: ["reasoning.encrypted_content"] } },
    system: "You are a careful inventory analyst. Use only supplied warehouse stock and movements. Identify at-risk SKUs first, explain why, and suggest specific replenishment quantities based on reorder points and recent net movement. Acknowledge that movements are not a demand forecast and never invent lead times or vendor details. Answer in short plain text with concise bullet points, maximum 250 words. Do not execute actions.",
    prompt: `Warehouse: ${input.warehouse}\nCurrent stock by product (units are per product): ${JSON.stringify(input.stock)}\nRecent ledger movements (positive is stock in, negative is stock out): ${JSON.stringify(input.movements)}`,
  });
  const text = (await result.text).trim();
  if (!text) throw new Error("The analysis returned no advice. Please try again later.");
  return text;
}
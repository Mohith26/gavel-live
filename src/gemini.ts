// Minimal Gemini generateContent client with JSON mode, retry/backoff and model fallback.
export interface GenOpts {
  apiKey: string;
  model: string;
  fallbackModel?: string;
  system?: string;
  user: string;
  schema?: unknown;        // responseSchema (JSON mode)
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface GenResult { text: string; model: string; attempts: number }

export class GeminiError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

export async function generate(o: GenOpts): Promise<GenResult> {
  const models = [o.model, ...(o.fallbackModel && o.fallbackModel !== o.model ? [o.fallbackModel] : [])];
  let attempts = 0, lastErr: Error | null = null;
  for (const model of models) {
    for (let i = 0; i < 3; i++) {
      attempts++;
      const body: Record<string, unknown> = {
        contents: [{ role: 'user', parts: [{ text: o.user }] }],
        generationConfig: {
          temperature: o.temperature ?? 0.1,
          maxOutputTokens: o.maxOutputTokens ?? 8192,
          ...(o.schema ? { responseMimeType: 'application/json', responseSchema: o.schema } : {}),
          // thinking off: a judge reading six passages does not need a scratchpad, and it was 10x the latency
          ...(/lite/.test(model) ? {} : { thinkingConfig: { thinkingBudget: 0 } }),
        },
      };
      if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
      let r: Response;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 25_000);
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': o.apiKey }, body: JSON.stringify(body), signal: ctl.signal,
        });
      } catch (e) { clearTimeout(timer); lastErr = new GeminiError(504, `${model} ${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message}`); await sleep(800); continue; }
      clearTimeout(timer);
      if (r.status === 429 || r.status >= 500) {
        lastErr = new GeminiError(r.status, `${model} ${r.status}`);
        const ra = +(r.headers.get('retry-after') ?? 0);
        await sleep(Math.min(12000, ra ? ra * 1000 : 2000 * (i + 1) * (i + 1)));
        continue;
      }
      if (!r.ok) { const t = await r.text(); throw new GeminiError(r.status, `${model} ${r.status}: ${t.slice(0, 300)}`); }
      const j = await r.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>; promptFeedback?: { blockReason?: string } };
      const text = j.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
      if (!text) { lastErr = new GeminiError(502, `${model} empty response ${j.promptFeedback?.blockReason ?? j.candidates?.[0]?.finishReason ?? ''}`); continue; }
      return { text, model, attempts };
    }
  }
  throw lastErr ?? new GeminiError(502, 'generation failed');
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

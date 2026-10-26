import type { Claim, Env, Result, SourceMeta, Turn } from './types';
import { BM25 } from './bm25';
import { generate } from './gemini';
import { JUDGE_SCHEMA, JUDGE_SYSTEM, SUPPORT_SCORE, buildJudgeUser, fmtTime, parseJudgeResponse } from './judge';

export type Progress = (event: string, data: Record<string, unknown>) => void;

const MAX_TRANSCRIPT_CHARS = 180_000;   // ~2.5 hours of speech; beyond that we sample evenly
const BATCH = 6;                        // claims per judge call
const CONCURRENCY = 3;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, speaker: { type: 'string', nullable: true }, anchor_seconds: { type: 'integer', nullable: true } },
        required: ['text'],
      },
    },
  },
  required: ['summary', 'claims'],
};

const SUMMARY_SYSTEM = `You write a bench report: a tight, factual briefing of a spoken recording, as a list of standalone claims that a second system will verify against the transcript.
Rules for claims:
- 12 to 20 claims for a long recording, 6 to 10 for a short one. Order them chronologically.
- Each claim is ONE sentence, specific and checkable: keep names, numbers, dates, units and quoted phrases exactly as spoken. Keep hedges ("might", "argues", "estimates").
- If the transcript identifies speakers, say who said it ("The host says...", "Smith argues..."). If speakers are unknown, say "The speaker..." and never invent a name.
- Cover the whole recording, not just the opening.
- anchor_seconds: your best estimate of the timestamp (in seconds) the claim is about, from the [t=mm:ss] markers.
Also write "summary": one paragraph, 80-140 words, plain prose.`;

function transcriptForPrompt(turns: Turn[]): string {
  let lines = turns.map(t => `[t=${fmtTime(t.start)}]${t.speaker ? ' ' + t.speaker + ':' : ''} ${t.text}`);
  let text = lines.join('\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    // keep every k-th turn so coverage stays even
    const k = Math.ceil(text.length / MAX_TRANSCRIPT_CHARS);
    lines = lines.filter((_, i) => i % k === 0);
    text = lines.join('\n');
  }
  return text;
}

function timeToTurn(turns: Turn[], sec: number | null): number | null {
  if (sec === null || !Number.isFinite(sec)) return null;
  let best = 0;
  for (let i = 0; i < turns.length; i++) { if (turns[i].start <= sec) best = i; else break; }
  return best;
}

export async function runPipeline(env: Env, apiKey: string, meta: SourceMeta, turns: Turn[], progress: Progress): Promise<Result> {
  const t0 = Date.now();
  let llmCalls = 0;
  const model = env.GEMINI_MODEL, fallback = env.GEMINI_FALLBACK_MODEL;

  progress('stage', { stage: 'summary', msg: `Writing claims from ${turns.length} turns` });
  const sum = await generate({ apiKey, model, fallbackModel: fallback, system: SUMMARY_SYSTEM, schema: SUMMARY_SCHEMA, temperature: 0.2, maxOutputTokens: 4096, timeoutMs: 75_000,
    user: `Title: ${meta.title}${meta.author ? `\nChannel/author: ${meta.author}` : ''}\nDuration: ${meta.duration ? fmtTime(meta.duration) : 'unknown'}\n\nTRANSCRIPT:\n${transcriptForPrompt(turns)}` });
  llmCalls++;
  let parsed: { title?: string; summary: string; claims: Array<{ text: string; speaker?: string | null; anchor_seconds?: number | null }> };
  try { parsed = JSON.parse(sum.text); } catch { parsed = JSON.parse(sum.text.replace(/```(?:json)?/g, '').trim()); }
  const claims: Claim[] = (parsed.claims ?? []).slice(0, 24).map((c, i): Claim => ({
    id: i + 1, text: String(c.text).trim(), speaker: c.speaker ?? null, anchor: typeof c.anchor_seconds === 'number' ? c.anchor_seconds : null,
    candidates: [], evidence: [], support: 'UNSUPPORTED' as const, severity: 'MAJOR' as const, attribution_ok: null, why: '', quote: '', score: 0, parse: 'strict' as const, flag_strict: true, flag_sensitive: true,
  })).filter(c => c.text.length > 10);
  if (!claims.length) throw new Error('The model returned no claims.');
  progress('claims', { count: claims.length, summary: parsed.summary, claims: claims.map(c => ({ id: c.id, text: c.text })) });

  progress('stage', { stage: 'retrieve', msg: 'Retrieving evidence (BM25 over turns)' });
  const index = new BM25(turns);
  for (const c of claims) c.candidates = index.search(c.text, 5, timeToTurn(turns, c.anchor));

  progress('stage', { stage: 'judge', msg: `Judging ${claims.length} claims in batches of ${BATCH}` });
  const batches: Claim[][] = [];
  for (let i = 0; i < claims.length; i += BATCH) batches.push(claims.slice(i, i + BATCH));
  let done = 0;
  const judged = new Map<number, ReturnType<typeof parseJudgeResponse>[number]>();
  const runBatch = async (b: Claim[]) => {
    const payload = b.map(claim => ({ claim, turns: claim.candidates.map(i => turns[i]) }));
    const r = await generate({ apiKey, model, fallbackModel: fallback, system: JUDGE_SYSTEM, schema: JUDGE_SCHEMA, temperature: 0, maxOutputTokens: 4096, timeoutMs: 40_000, user: buildJudgeUser(payload) });
    llmCalls++;
    for (const j of parseJudgeResponse(r.text)) judged.set(j.claim_id, j);
    done += b.length;
    progress('judged', { done, total: claims.length });
  };
  // bounded concurrency
  const queue = [...batches];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => { while (queue.length) await runBatch(queue.shift()!); }));

  // retry any claims the judge skipped, once, individually
  const missing = claims.filter(c => !judged.has(c.id));
  for (const c of missing.slice(0, 6)) { try { await runBatch([c]); } catch { /* leave as unjudged */ } }

  for (const c of claims) {
    const j = judged.get(c.id);
    if (!j) { c.support = 'UNSUPPORTED'; c.severity = 'MAJOR'; c.why = 'The judge returned no verdict for this claim.'; c.parse = 'scavenged'; }
    else {
      c.support = j.support; c.severity = j.severity; c.attribution_ok = j.attribution_ok; c.why = j.why; c.quote = j.quote; c.parse = j.parse;
      c.evidence = j.evidence.map(e => c.candidates[e - 1]).filter(e => e !== undefined);
      if (!c.evidence.length && c.support !== 'UNSUPPORTED') c.evidence = c.candidates.slice(0, 1);
    }
    c.score = SUPPORT_SCORE[c.support];
    const badAttr = c.attribution_ok === false;
    c.flag_strict = c.support === 'UNSUPPORTED' || c.support === 'CONTRADICTED' || badAttr;
    c.flag_sensitive = c.flag_strict || c.support === 'PARTIALLY_SUPPORTED';
  }

  const count = (f: (c: Claim) => boolean) => claims.filter(f).length;
  const result: Result = {
    version: env.RESULT_VERSION, source: meta, turns, summary: parsed.summary, claims, model: sum.model, createdAt: new Date().toISOString(),
    stats: {
      turns: turns.length, words: turns.reduce((a, t) => a + t.text.split(' ').length, 0), claims: claims.length,
      flagged_strict: count(c => c.flag_strict), flagged_sensitive: count(c => c.flag_sensitive),
      supported: count(c => c.support === 'SUPPORTED'), partial: count(c => c.support === 'PARTIALLY_SUPPORTED'), unsupported: count(c => c.support === 'UNSUPPORTED'), contradicted: count(c => c.support === 'CONTRADICTED'),
      parse_strict: count(c => c.parse === 'strict'), parse_repaired: count(c => c.parse === 'repaired'), parse_scavenged: count(c => c.parse === 'scavenged'),
      llm_calls: llmCalls, ms: Date.now() - t0,
    },
  };
  progress('stage', { stage: 'done', msg: `Done in ${(result.stats.ms / 1000).toFixed(1)}s` });
  return result;
}

// Judge a single user-supplied claim against an already-analyzed transcript.
export async function judgeOne(env: Env, apiKey: string, turns: Turn[], text: string): Promise<Claim> {
  const index = new BM25(turns);
  const claim: Claim = { id: 0, text, speaker: null, anchor: null, candidates: index.search(text, 6), evidence: [], support: 'UNSUPPORTED', severity: 'MAJOR', attribution_ok: null, why: '', quote: '', score: 0, parse: 'strict', flag_strict: true, flag_sensitive: true };
  if (!claim.candidates.length) { claim.why = 'No transcript passage shares vocabulary with this claim.'; return claim; }
  const r = await generate({ apiKey, model: env.GEMINI_MODEL, fallbackModel: env.GEMINI_FALLBACK_MODEL, system: JUDGE_SYSTEM, schema: JUDGE_SCHEMA, temperature: 0, maxOutputTokens: 2048, timeoutMs: 40_000, user: buildJudgeUser([{ claim, turns: claim.candidates.map(i => turns[i]) }]) });
  const j = parseJudgeResponse(r.text)[0];
  if (j) {
    claim.support = j.support; claim.severity = j.severity; claim.attribution_ok = j.attribution_ok; claim.why = j.why; claim.quote = j.quote; claim.parse = j.parse;
    claim.evidence = j.evidence.map(e => claim.candidates[e - 1]).filter(e => e !== undefined);
    if (!claim.evidence.length) claim.evidence = claim.candidates.slice(0, 1);
  } else claim.why = 'The judge returned no verdict.';
  claim.score = SUPPORT_SCORE[claim.support];
  claim.flag_strict = claim.support === 'UNSUPPORTED' || claim.support === 'CONTRADICTED' || claim.attribution_ok === false;
  claim.flag_sensitive = claim.flag_strict || claim.support === 'PARTIALLY_SUPPORTED';
  return claim;
}

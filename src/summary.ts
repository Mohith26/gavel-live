// Summary document: a general, visual briefing of the recording (overview, takeaways, sections with points,
// terms and numbers), where every point is run through the same BM25 + judge path as the bench report so it
// carries a timestamp, a verbatim quote and a support label. Built on demand from a cached Result.
import type { Claim, Env, Result, Support, Turn } from './types';
import { BM25 } from './bm25';
import { generate } from './gemini';
import { JUDGE_SCHEMA, JUDGE_SYSTEM, buildJudgeUser, fmtTime, parseJudgeResponse } from './judge';

export interface DocPoint {
  id: number;
  text: string;
  anchor: number | null;      // model's time hint (seconds)
  at: number | null;          // evidence turn start (seconds), after judging
  turn: number | null;        // evidence turn id
  quote: string;
  support: Support | 'UNJUDGED';
  why: string;
}
export interface DocSection { heading: string; start: number | null; end: number | null; gist: string; points: DocPoint[] }
export interface DocTerm { term: string; meaning: string; point: DocPoint }
export interface SummaryDoc {
  version: string;
  id: string;
  title: string;
  overview: string;
  takeaways: DocPoint[];
  sections: DocSection[];
  terms: DocTerm[];
  numbers: DocPoint[];
  stats: { points: number; supported: number; partial: number; unsupported: number; contradicted: number; llm_calls: number; ms: number };
  model: string;
  createdAt: string;
}

const MAX_CHARS = 180_000;
const BATCH = 6;
const CONCURRENCY = 3;

const DOC_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    overview: { type: 'string' },
    takeaways: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, anchor_seconds: { type: 'integer', nullable: true } }, required: ['text'] } },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string' },
          start_seconds: { type: 'integer', nullable: true },
          end_seconds: { type: 'integer', nullable: true },
          gist: { type: 'string' },
          points: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, anchor_seconds: { type: 'integer', nullable: true } }, required: ['text'] } },
        },
        required: ['heading', 'gist', 'points'],
      },
    },
    terms: { type: 'array', items: { type: 'object', properties: { term: { type: 'string' }, meaning: { type: 'string' }, anchor_seconds: { type: 'integer', nullable: true } }, required: ['term', 'meaning'] } },
    numbers: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, anchor_seconds: { type: 'integer', nullable: true } }, required: ['text'] } },
  },
  required: ['title', 'overview', 'takeaways', 'sections'],
};

const DOC_SYSTEM = `You write a visual summary document of a spoken recording (lecture, podcast, talk, interview) for someone who has not watched it. A second system will check every point against the transcript, so every point must be specific and verifiable.
Produce:
- title: a short descriptive title (not clickbait).
- overview: one paragraph, 90-150 words, plain prose, what the recording is about and where it ends up.
- takeaways: 4-6 one-sentence takeaways, the things worth remembering. Each must be a concrete statement that appears in the recording.
- sections: split the recording into 4-9 chronological sections. For each: heading (3-7 words), start_seconds and end_seconds from the [t=mm:ss] markers, gist (one sentence), and 2-5 points. Each point is ONE sentence stating something said in that section: keep names, numbers, dates, units and quoted phrases exactly as spoken; keep hedges ("might", "argues", "estimates"). If speakers are identified say who ("The host says..."); if not, say "The speaker..." and never invent a name.
- terms: up to 8 terms, names or concepts a newcomer would need, each with a one-line meaning AS EXPLAINED IN THE RECORDING (not from your own knowledge), with anchor_seconds.
- numbers: up to 8 specific figures, dates or quantities mentioned, each as one sentence with the number exactly as spoken, with anchor_seconds.
anchor_seconds is your best estimate of the timestamp the point is about, from the [t=mm:ss] markers. Cover the whole recording, not just the opening.`;

function transcriptForPrompt(turns: Turn[]): string {
  let lines = turns.map(t => `[t=${fmtTime(t.start)}]${t.speaker ? ' ' + t.speaker + ':' : ''} ${t.text}`);
  let text = lines.join('\n');
  if (text.length > MAX_CHARS) { const k = Math.ceil(text.length / MAX_CHARS); lines = lines.filter((_, i) => i % k === 0); text = lines.join('\n'); }
  return text;
}
function timeToTurn(turns: Turn[], sec: number | null): number | null {
  if (sec === null || !Number.isFinite(sec)) return null;
  let best = 0; for (let i = 0; i < turns.length; i++) { if (turns[i].start <= sec) best = i; else break; }
  return best;
}
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export type Progress = (event: string, data: Record<string, unknown>) => void;

export async function buildSummaryDoc(env: Env, apiKey: string, result: Result, progress: Progress): Promise<SummaryDoc> {
  const t0 = Date.now();
  const turns = result.turns; const meta = result.source;
  const model = env.GEMINI_MODEL, fallback = env.GEMINI_FALLBACK_MODEL;
  let llm = 0;

  progress('stage', { stage: 'write', msg: `Writing the document from ${turns.length} passages` });
  const gen = await generate({ apiKey, model, fallbackModel: fallback, system: DOC_SYSTEM, schema: DOC_SCHEMA, temperature: 0.2, maxOutputTokens: 8192, timeoutMs: 90_000,
    user: `Title: ${meta.title}${meta.author ? `\nChannel/author: ${meta.author}` : ''}\nDuration: ${meta.duration ? fmtTime(meta.duration) : 'unknown'}\n\nTRANSCRIPT:\n${transcriptForPrompt(turns)}` });
  llm++;
  let raw: any;
  try { raw = JSON.parse(gen.text); } catch { raw = JSON.parse(gen.text.replace(/```(?:json)?/g, '').trim()); }

  // Flatten every point into a judgeable item.
  let nextId = 1;
  const mk = (text: unknown, anchor: unknown): DocPoint | null => { const t = String(text ?? '').trim(); if (t.length < 8) return null; return { id: nextId++, text: t, anchor: num(anchor), at: null, turn: null, quote: '', support: 'UNJUDGED', why: '' }; };
  const takeaways = (raw.takeaways ?? []).map((p: any) => mk(p.text, p.anchor_seconds)).filter(Boolean).slice(0, 6) as DocPoint[];
  const sections: DocSection[] = (raw.sections ?? []).slice(0, 9).map((s: any) => ({
    heading: String(s.heading ?? '').trim().slice(0, 80), start: num(s.start_seconds), end: num(s.end_seconds), gist: String(s.gist ?? '').trim(),
    points: (s.points ?? []).map((p: any) => mk(p.text, p.anchor_seconds)).filter(Boolean).slice(0, 5) as DocPoint[],
  })).filter((s: DocSection) => s.heading && s.points.length);
  const terms: DocTerm[] = (raw.terms ?? []).slice(0, 8).map((t: any) => { const p = mk(`${String(t.term ?? '').trim()}: ${String(t.meaning ?? '').trim()}`, t.anchor_seconds); return p ? { term: String(t.term).trim().slice(0, 60), meaning: String(t.meaning).trim(), point: p } : null; }).filter(Boolean) as DocTerm[];
  const numbers = (raw.numbers ?? []).map((p: any) => mk(p.text, p.anchor_seconds)).filter(Boolean).slice(0, 8) as DocPoint[];
  const all: DocPoint[] = [...takeaways, ...sections.flatMap(s => s.points), ...terms.map(t => t.point), ...numbers];
  if (!sections.length || !all.length) throw new Error('The model returned an empty document.');
  progress('doc', { title: raw.title, sections: sections.map(s => s.heading), points: all.length });

  // Evidence: BM25 candidates, then the judge in batches (same as the bench report).
  progress('stage', { stage: 'evidence', msg: `Linking ${all.length} points to the transcript` });
  const index = new BM25(turns);
  const asClaim = (p: DocPoint): Claim => ({ id: p.id, text: p.text, speaker: null, anchor: p.anchor, candidates: index.search(p.text, 5, timeToTurn(turns, p.anchor)), evidence: [], support: 'UNSUPPORTED', severity: 'MAJOR', attribution_ok: null, why: '', quote: '', score: 0, parse: 'strict', flag_strict: true, flag_sensitive: true });
  const claims = all.map(asClaim);
  const batches: Claim[][] = []; for (let i = 0; i < claims.length; i += BATCH) batches.push(claims.slice(i, i + BATCH));
  const judged = new Map<number, ReturnType<typeof parseJudgeResponse>[number]>();
  let done = 0;
  const runBatch = async (b: Claim[]) => {
    const payload = b.map(claim => ({ claim, turns: claim.candidates.map(i => turns[i]) }));
    const r = await generate({ apiKey, model, fallbackModel: fallback, system: JUDGE_SYSTEM, schema: JUDGE_SCHEMA, temperature: 0, maxOutputTokens: 4096, timeoutMs: 40_000, user: buildJudgeUser(payload) });
    llm++;
    for (const j of parseJudgeResponse(r.text)) judged.set(j.claim_id, j);
    done += b.length; progress('judged', { done, total: claims.length });
  };
  const queue = [...batches];
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => { while (queue.length) { try { await runBatch(queue.shift()!); } catch { /* leave unjudged */ } } }));

  const byId = new Map(all.map(p => [p.id, p]));
  for (const c of claims) {
    const p = byId.get(c.id)!; const j = judged.get(c.id);
    let turnId: number | undefined;
    if (j) {
      p.support = j.support; p.why = j.why; p.quote = j.quote;
      turnId = j.evidence.map(e => c.candidates[e - 1]).filter(e => e !== undefined)[0];
    }
    if (turnId === undefined) turnId = c.candidates[0] ?? timeToTurn(turns, p.anchor) ?? undefined;
    if (turnId !== undefined) { p.turn = turnId; p.at = turns[turnId].start; }
  }
  // Section bounds: fall back to the points' evidence when the model's estimate is missing.
  for (const s of sections) {
    const ats = s.points.map(p => p.at).filter((x): x is number => x !== null);
    if (s.start === null && ats.length) s.start = Math.min(...ats);
    if (s.end === null && ats.length) s.end = Math.max(...ats);
  }

  const count = (f: (p: DocPoint) => boolean) => all.filter(f).length;
  const doc: SummaryDoc = {
    version: env.RESULT_VERSION, id: result.source.id, title: String(raw.title ?? result.source.title).trim().slice(0, 140), overview: String(raw.overview ?? '').trim(),
    takeaways, sections, terms, numbers,
    stats: { points: all.length, supported: count(p => p.support === 'SUPPORTED'), partial: count(p => p.support === 'PARTIALLY_SUPPORTED'), unsupported: count(p => p.support === 'UNSUPPORTED' || p.support === 'UNJUDGED'), contradicted: count(p => p.support === 'CONTRADICTED'), llm_calls: llm, ms: Date.now() - t0 },
    model: gen.model, createdAt: new Date().toISOString(),
  };
  progress('stage', { stage: 'done', msg: `Done in ${(doc.stats.ms / 1000).toFixed(1)}s` });
  return doc;
}

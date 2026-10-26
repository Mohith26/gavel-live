// The judge: prompt, output schema and the forgiving parser.
// Gavel's original parser silently dropped 75% of judge responses (evidence ids written
// as [E1, E3], unescaped quotes in the rationale) and defaulted severity to MAJOR.
// Gemini JSON mode avoids most of that, but the repair + scavenge path is kept and the
// parse path is recorded per claim so the UI can show how much was repaired.
import type { Claim, Support, Severity, Turn } from './types';

export const SUPPORT_SCORE: Record<Support, number> = { SUPPORTED: 1, PARTIALLY_SUPPORTED: 0.5, UNSUPPORTED: 0, CONTRADICTED: 0 };

export const JUDGE_SYSTEM = `You are a strict evidence judge for summaries of spoken recordings (lectures, podcasts, talks, interviews).
For each claim you are given up to 6 candidate transcript passages (E1..E6) with timestamps. Judge the claim ONLY against those passages.
Labels:
- SUPPORTED: every fact in the claim (names, numbers, dates, who said it, hedges, outcomes) is stated in the evidence.
- PARTIALLY_SUPPORTED: the gist is in the evidence but a detail is missing, overstated, or the hedge is dropped.
- UNSUPPORTED: nothing in the evidence establishes the claim.
- CONTRADICTED: the evidence says the opposite (negation, different number, different outcome, different party).
Attribution: if the claim says WHO said something, set attribution_ok to true only if the evidence shows that speaker saying it; false if a different speaker said it; null if the claim attributes nothing or speakers are unknown.
Severity of the error if any: NONE, MINOR (wording, dropped hedge, small detail), MAJOR (wrong number/name/outcome/speaker, fabricated).
evidence: the E-numbers (as integers 1..6) that actually support or contradict the claim. quote: a short verbatim fragment (max 25 words) copied from the evidence that is most relevant. why: one sentence.`;

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim_id: { type: 'integer' },
          support: { type: 'string', enum: ['SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED'] },
          severity: { type: 'string', enum: ['NONE', 'MINOR', 'MAJOR'] },
          evidence: { type: 'array', items: { type: 'integer' } },
          attribution_ok: { type: 'boolean', nullable: true },
          quote: { type: 'string' },
          why: { type: 'string' },
        },
        required: ['claim_id', 'support', 'severity', 'evidence', 'why'],
      },
    },
  },
  required: ['judgments'],
};

export function fmtTime(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(sec).padStart(2, '0');
}

export function buildJudgeUser(batch: Array<{ claim: Claim; turns: Turn[] }>): string {
  const parts: string[] = [];
  for (const { claim, turns } of batch) {
    parts.push(`CLAIM ${claim.id}: ${claim.text}`);
    turns.forEach((t, i) => parts.push(`  E${i + 1} [${fmtTime(t.start)}-${fmtTime(t.end)}${t.speaker ? ' ' + t.speaker : ''}]: ${t.text}`));
    parts.push('');
  }
  parts.push('Return JSON: {"judgments":[{claim_id, support, severity, evidence:[ints], attribution_ok, quote, why}, ...]} with one entry per CLAIM above.');
  return parts.join('\n');
}

export interface RawJudgment { claim_id: number; support: Support; severity: Severity; evidence: number[]; attribution_ok: boolean | null; quote: string; why: string; parse: Claim['parse'] }

const SUPPORTS: Support[] = ['SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED', 'CONTRADICTED'];
const SEVS: Severity[] = ['NONE', 'MINOR', 'MAJOR'];

function normalizeJ(j: any, parse: Claim['parse']): RawJudgment | null {
  if (!j || typeof j !== 'object') return null;
  const id = Number(j.claim_id ?? j.id ?? j.claim);
  if (!Number.isFinite(id)) return null;
  const sup = String(j.support ?? j.label ?? '').toUpperCase().replace(/[\s-]+/g, '_');
  const support = (SUPPORTS.find(s => sup.startsWith(s)) ?? (sup.includes('PARTIAL') ? 'PARTIALLY_SUPPORTED' : sup.includes('CONTRA') ? 'CONTRADICTED' : sup.includes('UNSUP') || sup.includes('NOT') ? 'UNSUPPORTED' : sup.includes('SUPPORT') ? 'SUPPORTED' : null));
  if (!support) return null;
  const sevRaw = String(j.severity ?? '').toUpperCase();
  let severity = SEVS.find(s => sevRaw.startsWith(s)) ?? (support === 'SUPPORTED' ? 'NONE' : support === 'PARTIALLY_SUPPORTED' ? 'MINOR' : 'MAJOR');
  if (support === 'SUPPORTED') severity = 'NONE';
  const evRaw = Array.isArray(j.evidence) ? j.evidence : typeof j.evidence === 'string' ? j.evidence.split(/[,\s]+/) : [];
  const evidence = evRaw.map((e: unknown) => Number(String(e).replace(/[^0-9]/g, ''))).filter((n: number) => Number.isFinite(n) && n >= 1 && n <= 6);
  const ao = j.attribution_ok;
  const attribution_ok = ao === true || ao === 'true' ? true : ao === false || ao === 'false' ? false : null;
  return { claim_id: id, support, severity, evidence: Array.from(new Set(evidence)) as number[], attribution_ok, quote: String(j.quote ?? '').slice(0, 300), why: String(j.why ?? j.rationale ?? '').slice(0, 400), parse };
}

function repairJson(s: string): string {
  return s.replace(/```(?:json)?/g, '').replace(/\bE(\d)\b/g, '$1').replace(/,\s*([\]}])/g, '$1').trim();
}

export function parseJudgeResponse(text: string): RawJudgment[] {
  // 1. strict
  try { const j = JSON.parse(text); const arr = Array.isArray(j) ? j : j.judgments; if (Array.isArray(arr)) return arr.map(x => normalizeJ(x, 'strict')).filter(Boolean) as RawJudgment[]; } catch { /* fallthrough */ }
  // 2. repaired
  try { const j = JSON.parse(repairJson(text)); const arr = Array.isArray(j) ? j : j.judgments; if (Array.isArray(arr)) return arr.map(x => normalizeJ(x, 'repaired')).filter(Boolean) as RawJudgment[]; } catch { /* fallthrough */ }
  // 3. scavenge object by object
  const out: RawJudgment[] = [];
  const objRe = /\{[^{}]*"claim_id"[^{}]*\}/g; let m: RegExpExecArray | null;
  while ((m = objRe.exec(text))) {
    const o: any = {};
    const grab = (k: string) => { const r = new RegExp(`"${k}"\\s*:\\s*("((?:[^"\\\\]|\\\\.)*)"|[^,}\\n]+)`).exec(m![0]); return r ? (r[2] ?? r[1]).trim() : undefined; };
    o.claim_id = grab('claim_id'); o.support = grab('support'); o.severity = grab('severity'); o.attribution_ok = grab('attribution_ok'); o.quote = grab('quote'); o.why = grab('why');
    const ev = /"evidence"\s*:\s*\[([^\]]*)\]/.exec(m[0]); o.evidence = ev ? ev[1] : '';
    const n = normalizeJ(o, 'scavenged'); if (n) out.push(n);
  }
  return out;
}

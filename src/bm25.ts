// Lexical retrieval. Gavel's ablation found BM25 alone scored as well as hybrid
// BM25 + dense (subset F1 0.8295 vs 0.8114), so the live tool uses BM25 only:
// no embedding calls, no vector store, and it runs inside the Worker.
import type { Turn } from './types';

const STOP = new Set('a an and are as at be but by for from has have he her his i if in into is it its of on or she so that the their there these they this to was we were what which who will with you your yeah okay like just um uh'.split(' '));

export function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9%$.' -]/g, ' ').split(/[\s.']+/).map(w => w.replace(/^-+|-+$/g, '')).filter(w => w.length > 1 && !STOP.has(w)).map(stem);
}
function stem(w: string): string {
  if (w.length <= 4) return w;
  return w.replace(/(ingly|edly|ing|ies|ied|ed|es|ly|s)$/, '');
}

export class BM25 {
  private df = new Map<string, number>();
  private docs: string[][] = [];
  private avg = 0;
  constructor(private turns: Turn[], private k1 = 1.4, private b = 0.75) {
    this.docs = turns.map(t => tokenize(t.text));
    for (const d of this.docs) for (const w of new Set(d)) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    this.avg = this.docs.reduce((a, d) => a + d.length, 0) / Math.max(1, this.docs.length);
  }
  search(query: string, k = 5, boostTurn: number | null = null): number[] {
    const q = tokenize(query); const N = this.docs.length; const scores = new Float64Array(N);
    for (const w of new Set(q)) {
      const df = this.df.get(w); if (!df) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < N; i++) {
        const d = this.docs[i]; let tf = 0; for (const x of d) if (x === w) tf++;
        if (!tf) continue;
        scores[i] += idf * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * d.length / this.avg));
      }
    }
    if (boostTurn !== null && boostTurn >= 0 && boostTurn < N) scores[boostTurn] += 1.5;
    const idx = Array.from({ length: N }, (_, i) => i).filter(i => scores[i] > 0).sort((a, b) => scores[b] - scores[a]).slice(0, k);
    if (boostTurn !== null && !idx.includes(boostTurn) && boostTurn >= 0 && boostTurn < N) idx.push(boostTurn);
    return idx.sort((a, b) => a - b);
  }
}

export interface Env {
  KV: KVNamespace;
  ASSETS: Fetcher;
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  GEMINI_FALLBACK_MODEL: string;
  DAILY_CAP: string;
  IP_HOURLY_CAP: string;
  RESULT_VERSION: string;
}

export interface Turn {
  id: number;
  start: number; // seconds
  end: number;   // seconds
  speaker: string | null;
  text: string;
}

export type Support = 'SUPPORTED' | 'PARTIALLY_SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED';
export type Severity = 'NONE' | 'MINOR' | 'MAJOR';

export interface Claim {
  id: number;
  text: string;
  speaker: string | null;
  anchor: number | null;       // seconds, model's hint
  candidates: number[];        // turn ids offered as evidence (retrieval)
  evidence: number[];          // turn ids the judge actually cited
  support: Support;
  severity: Severity;
  attribution_ok: boolean | null;
  why: string;
  quote: string;
  score: number;               // support score 0..1
  parse: 'strict' | 'repaired' | 'scavenged';
  flag_strict: boolean;
  flag_sensitive: boolean;
}

export interface SourceMeta {
  kind: 'youtube' | 'text';
  id: string;
  title: string;
  author: string | null;
  duration: number | null;     // seconds
  captionKind: 'manual' | 'asr' | 'pasted';
  language: string | null;
  url: string | null;
}

export interface Result {
  version: string;
  source: SourceMeta;
  turns: Turn[];
  summary: string;
  claims: Claim[];
  stats: {
    turns: number;
    words: number;
    claims: number;
    flagged_strict: number;
    flagged_sensitive: number;
    supported: number;
    partial: number;
    unsupported: number;
    contradicted: number;
    parse_strict: number;
    parse_repaired: number;
    parse_scavenged: number;
    llm_calls: number;
    ms: number;
  };
  model: string;
  createdAt: string;
}

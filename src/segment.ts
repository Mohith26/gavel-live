// Turn segmentation. Spoken proceedings (Gavel's original domain) have speaker turns;
// YouTube captions do not. We synthesize turns of 20-45 seconds, cutting at sentence
// ends once a turn is long enough, so every claim can cite a short, playable span.
import type { Turn } from './types';

export interface Cue { start: number; end: number; text: string; speaker?: string | null }

const SENT_END = /[.!?]["')\]]?$/;

// Adaptive turn length: short clips get short turns so the viewer can still point at a span.
export function segmentCues(cues: Cue[], defaultSpeaker: string | null): Turn[] {
  const total = cues.length ? cues[cues.length - 1].end - cues[0].start : 0;
  const TARGET_S = Math.min(32, Math.max(10, total / 25));
  const MIN_S = TARGET_S * 0.6, MAX_S = TARGET_S * 1.45;
  const turns: Turn[] = [];
  let buf: string[] = [], start = 0, end = 0, speaker: string | null = defaultSpeaker;
  const flush = () => {
    const text = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (text) turns.push({ id: turns.length, start: round(start), end: round(end), speaker, text });
    buf = [];
  };
  for (const c of cues) {
    const spk = c.speaker ?? defaultSpeaker;
    if (!buf.length) { start = c.start; speaker = spk; }
    if (buf.length && spk !== speaker) { flush(); start = c.start; speaker = spk; }
    buf.push(c.text); end = Math.max(end, c.end);
    const len = end - start;
    const sentenceEnd = SENT_END.test(c.text.trim());
    if (len >= MAX_S || (len >= TARGET_S && sentenceEnd) || (len >= MIN_S && sentenceEnd && buf.join(' ').length > 400)) flush();
  }
  flush();
  // merge tiny trailing fragments
  for (let i = turns.length - 1; i > 0; i--) {
    if (turns[i].text.split(' ').length < 8 && turns[i].speaker === turns[i - 1].speaker) {
      turns[i - 1].text += ' ' + turns[i].text; turns[i - 1].end = turns[i].end; turns.splice(i, 1);
    }
  }
  turns.forEach((t, i) => (t.id = i));
  return turns;
}

function round(x: number) { return Math.round(x * 10) / 10; }

// Pasted transcripts: SRT, WebVTT, "[mm:ss] text", "Name: text", or plain prose.
export function parsePastedTranscript(raw: string): { turns: Turn[]; hasTimes: boolean; hasSpeakers: boolean } {
  const text = raw.replace(/\r/g, '').trim();
  const cues: Cue[] = [];
  let hasTimes = false, hasSpeakers = false;

  const ts = (s: string) => { const p = s.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0]; };
  const srtRe = /(\d{1,2}:\d{2}:\d{2})[,.](\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2})[,.](\d{3})\s*\n([\s\S]*?)(?=\n\s*\n|\n\d+\s*\n|$)/g;
  let m: RegExpExecArray | null;
  if (/-->/.test(text)) {
    while ((m = srtRe.exec(text))) {
      const body = m[5].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const spk = body.match(/^([A-Z][\w .'-]{1,40}):\s/);
      cues.push({ start: ts(m[1]) + +m[2] / 1000, end: ts(m[3]) + +m[4] / 1000, text: spk ? body.slice(spk[0].length) : body, speaker: spk ? spk[1] : null });
      if (spk) hasSpeakers = true;
    }
    hasTimes = cues.length > 0;
  }
  if (!cues.length) {
    let lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    // YouTube's "Show transcript" panel copies as alternating lines: "12:30" then the text. Fold them.
    const tsOnly = /^(\d{1,2}:)?\d{1,2}:\d{2}$/;
    if (lines.length > 4 && lines.filter(l => tsOnly.test(l)).length >= lines.length * 0.4) {
      const folded: string[] = [];
      for (let i = 0; i < lines.length; i++) { if (tsOnly.test(lines[i]) && i + 1 < lines.length && !tsOnly.test(lines[i + 1])) { folded.push(`[${lines[i]}] ${lines[i + 1]}`); i++; } else if (!tsOnly.test(lines[i])) folded.push(lines[i]); }
      lines = folded;
    }
    let t = 0, lastT = 0;
    for (const line of lines) {
      let s = line, start: number | null = null, spk: string | null = null;
      const tm = s.match(/^[\[(]?(\d{1,2}:\d{2}(?::\d{2})?)[\])]?\s*/);
      if (tm) { start = ts(tm[1]); s = s.slice(tm[0].length); hasTimes = true; }
      const sm = s.match(/^([A-Z][\w .'-]{1,40}):\s+/);
      if (sm) { spk = sm[1]; s = s.slice(sm[0].length); hasSpeakers = true; }
      if (!s) continue;
      if (start === null) { start = lastT; }
      const words = s.split(/\s+/).length;
      const end = start + Math.max(2, words / 2.6); // ~155 wpm
      cues.push({ start, end, text: s, speaker: spk });
      lastT = end; t = end;
    }
  }
  const turns = hasSpeakers ? mergeBySpeaker(cues) : segmentCues(cues, null);
  return { turns, hasTimes, hasSpeakers };
}

function mergeBySpeaker(cues: Cue[]): Turn[] {
  const turns: Turn[] = [];
  for (const c of cues) {
    const last = turns.at(-1);
    if (last && last.speaker === (c.speaker ?? null) && c.end - last.start < 60) { last.text += ' ' + c.text; last.end = c.end; }
    else turns.push({ id: turns.length, start: c.start, end: c.end, speaker: c.speaker ?? null, text: c.text });
  }
  return turns;
}

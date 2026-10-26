import type { Env, Result, SourceMeta } from './types';
import { fetchYouTube, parseVideoId, innertubePlayer, CLIENT_ORDER, timedtextDirect, mirrorsFetch, fromCaptionsXml } from './youtube';
import { parsePastedTranscript } from './segment';
import { runPipeline, judgeOne } from './pipeline';
import { GeminiError } from './gemini';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (data: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

async function sha1(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function resultKey(env: Env, id: string) { return `res:${env.RESULT_VERSION}:${id}`; }

async function bump(env: Env, key: string, ttl: number): Promise<number> {
  const n = (+(await env.KV.get(key) ?? '0')) + 1;
  await env.KV.put(key, String(n), { expirationTtl: ttl });
  return n;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/healthz') return json({ ok: true, model: env.GEMINI_MODEL, version: env.RESULT_VERSION });

    if (p.startsWith('/api/result/') && req.method === 'GET') {
      const id = p.slice('/api/result/'.length);
      const r = await env.KV.get(resultKey(env, id));
      return r ? new Response(r, { headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=300' } }) : json({ error: 'not found' }, 404);
    }

    if (p === '/api/debug/yt' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? 'L2bxwnm7JG4';
      const out: Record<string, string> = {};
      for (const c of CLIENT_ORDER) { try { const pr = await innertubePlayer(id, c); const t = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []; out[c] = `${pr.playabilityStatus?.status} ${pr.playabilityStatus?.reason ?? ''} tracks=${t.length} title=${pr.videoDetails?.title ?? ''}`; } catch (e) { out[c] = 'ERR ' + (e as Error).message; } }
      try { const d = await timedtextDirect(id); out.timedtext = d ? `ok ${d.kind} ${d.xml.length}b` : 'none'; } catch (e) { out.timedtext = 'ERR ' + (e as Error).message; }
      const mlog: string[] = [];
      try { const m = await mirrorsFetch(id, s => mlog.push(s)); out.mirrors = (m ? `OK ${m.cues.length} cues ${m.kind} title=${m.title}` : 'none') + ' | ' + mlog.join(' | '); } catch (e) { out.mirrors = 'ERR ' + (e as Error).message; }
      return json(out);
    }

    if (p === '/api/recent' && req.method === 'GET') {
      const list = await env.KV.get('recent');
      return new Response(list ?? '[]', { headers: JSON_HEADERS });
    }

    if (p === '/api/check' && req.method === 'POST') {
      let b: { id?: string; claim?: string };
      try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
      if (!b.id || !b.claim || b.claim.trim().length < 8) return json({ error: 'need id and a claim' }, 400);
      const raw = await env.KV.get(resultKey(env, b.id)); if (!raw) return json({ error: 'no cached result for that id' }, 404);
      const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
      const byok = req.headers.get('x-gemini-key')?.trim() || null;
      const n = await bump(env, `chk:${ip}:${new Date().toISOString().slice(0, 13)}`, 3700);
      if (n > 30 && !byok) return json({ error: 'Rate limit: 30 checks per hour per IP. Add your own key to lift it.' }, 429);
      const result = JSON.parse(raw) as Result;
      try { const c = await judgeOne(env, byok || env.GEMINI_API_KEY, result.turns, b.claim.trim().slice(0, 400)); return json(c); }
      catch (e) { const err = e as Error; return json({ error: err instanceof GeminiError && err.status === 429 ? 'The model is rate-limited (free tier). Try again in a minute or add your own key.' : err.message }, 502); }
    }

    if (p === '/api/analyze' && req.method === 'POST') {
      return analyze(req, env, ctx);
    }

    if (p === '/how' || p === '/how/') {
      const r = await env.ASSETS.fetch(new Request(new URL('/how.html', req.url), { headers: req.headers }));
      return new Response(r.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
    }
    // share links: /v/<id> serves the app shell; the client fetches /api/result/<id>
    if (p.startsWith('/v/')) {
      const r = await env.ASSETS.fetch(new Request(new URL('/', req.url), { headers: req.headers }));
      return new Response(r.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

async function analyze(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: { url?: string; transcript?: string; title?: string; force?: boolean; captionsXml?: string; author?: string; duration?: number; captionKind?: 'manual' | 'asr' };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const byok = req.headers.get('x-gemini-key')?.trim() || null;
  const apiKey = byok || env.GEMINI_API_KEY;
  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';

  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const send = (event: string, data: unknown) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)).catch(() => {});

  const work = (async () => {
    try {
      let meta: SourceMeta, turns;
      let id: string;
      if (body.url) {
        const vid = parseVideoId(body.url);
        if (!vid) throw new Error('That does not look like a YouTube link.');
        id = vid;
        if (body.transcript && body.transcript.trim().length > 200) { /* url + pasted transcript: stored under the video id so the embed works */ }
      } else if (body.transcript && body.transcript.trim().length > 200) {
        id = 't_' + await sha1(body.transcript.trim());
      } else throw new Error('Give me a YouTube link or a transcript of at least 200 characters.');

      if (!body.force) {
        const cached = await env.KV.get(resultKey(env, id));
        if (cached) { await send('stage', { stage: 'cache', msg: 'Loaded from cache' }); await send('result', JSON.parse(cached)); return; }
      }

      // caps (cached hits above are free)
      const day = new Date().toISOString().slice(0, 10);
      const ipN = await bump(env, `ip:${ip}:${new Date().toISOString().slice(0, 13)}`, 3700);
      if (ipN > +env.IP_HOURLY_CAP && !byok) throw new Error(`Rate limit: ${env.IP_HOURLY_CAP} analyses per hour per IP. Add your own Gemini key to lift it.`);
      if (!byok) { const dN = await bump(env, `day:${day}`, 90_000); if (dN > +env.DAILY_CAP) throw new Error('The free daily budget is used up. Add your own Gemini key (it is never stored) to keep going.'); }

      await send('stage', { stage: 'fetch', msg: body.url ? 'Fetching captions from YouTube' : 'Parsing pasted transcript' });
      if (body.url && body.captionsXml) {
        const y = fromCaptionsXml(id, body.captionsXml, { title: body.title, author: body.author, duration: body.duration, captionKind: body.captionKind });
        meta = y.meta; turns = y.turns;
        await send('source', { ...meta, cues: y.cues, turns: turns.length });
      } else if (body.url && body.transcript && body.transcript.trim().length > 200) {
        const t = parsePastedTranscript(body.transcript);
        turns = t.turns;
        meta = { kind: 'youtube', id, title: (body.title || `YouTube ${id}`).slice(0, 120), author: body.author ?? null, duration: body.duration ?? (turns.at(-1)?.end ?? null), captionKind: 'pasted', language: null, url: `https://www.youtube.com/watch?v=${id}` };
        await send('source', { ...meta, turns: turns.length, hasTimes: t.hasTimes, hasSpeakers: t.hasSpeakers });
      } else if (body.url) {
        let y;
        try { y = await fetchYouTube(id, m => { void send('stage', { stage: 'fetch', msg: 'Fetching captions: ' + m }); }); }
        catch (e) { throw new Error((e as Error).message + ' TIP: on the YouTube page, open "...more" then "Show transcript", select all, copy, and paste it below with the link.'); }
        meta = y.meta; turns = y.turns;
        await send('source', { ...meta, cues: y.cues, turns: turns.length });
      } else {
        const t = parsePastedTranscript(body.transcript!);
        turns = t.turns;
        meta = { kind: 'text', id, title: (body.title || 'Pasted transcript').slice(0, 120), author: null, duration: turns.at(-1)?.end ?? null, captionKind: 'pasted', language: null, url: null };
        await send('source', { ...meta, turns: turns.length, hasTimes: t.hasTimes, hasSpeakers: t.hasSpeakers });
      }
      if (turns.length < 2) throw new Error('Transcript too short to analyze.');
      if (turns.length > 900) turns = turns.filter((_, i) => i % Math.ceil(turns.length / 900) === 0).map((t, i) => ({ ...t, id: i }));

      const result: Result = await runPipeline(env, apiKey, meta, turns, (event, data) => { void send(event, data); });
      await env.KV.put(resultKey(env, id), JSON.stringify(result), { expirationTtl: 60 * 60 * 24 * 45 });
      ctx.waitUntil(updateRecent(env, result));
      await send('result', result);
    } catch (e) {
      const err = e as Error;
      const msg = err instanceof GeminiError ? (err.status === 429 ? 'The model is rate-limited right now (free tier). Try again in a minute or add your own Gemini key.' : `Model error: ${err.message}`) : err.message;
      await send('error', { message: msg });
    } finally {
      await writer.close().catch(() => {});
    }
  })();
  ctx.waitUntil(work);

  return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
}

async function updateRecent(env: Env, r: Result) {
  if (r.source.kind !== 'youtube') return;
  const list: Array<{ id: string; title: string; author: string | null; claims: number; flagged: number; at: string }> = JSON.parse((await env.KV.get('recent')) ?? '[]');
  const next = [{ id: r.source.id, title: r.source.title, author: r.source.author, claims: r.stats.claims, flagged: r.stats.flagged_strict, at: r.createdAt }, ...list.filter(x => x.id !== r.source.id)].slice(0, 12);
  await env.KV.put('recent', JSON.stringify(next));
}

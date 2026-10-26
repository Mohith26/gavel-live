// YouTube caption retrieval through the InnerTube player endpoint (ANDROID client),
// which returns caption track URLs without a signature. Falls back to the watch page.
import type { SourceMeta, Turn } from './types';
import { segmentCues, type Cue } from './segment';

const INNERTUBE_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';

export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[2];
    }
  } catch { /* not a url */ }
  return null;
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  videoDetails?: { title?: string; author?: string; lengthSeconds?: string };
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Array<{ baseUrl: string; languageCode: string; kind?: string; name?: { simpleText?: string } }> } };
}

export const CLIENTS: Record<string, { body: Record<string, unknown>; headers: Record<string, string> }> = {
  ANDROID: { body: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30 }, headers: { 'user-agent': ANDROID_UA, 'x-youtube-client-name': '3', 'x-youtube-client-version': '20.10.38' } },
  IOS: { body: { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82' }, headers: { 'user-agent': 'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)', 'x-youtube-client-name': '5', 'x-youtube-client-version': '20.10.4' } },
  TV_EMBEDDED: { body: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0' }, headers: { 'user-agent': 'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15', 'x-youtube-client-name': '85', 'x-youtube-client-version': '2.0' } },
  WEB_EMBEDDED: { body: { clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20250310.01.00' }, headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'x-youtube-client-name': '56', 'x-youtube-client-version': '1.20250310.01.00', origin: 'https://www.youtube.com', referer: 'https://www.youtube.com/' } },
  MWEB: { body: { clientName: 'MWEB', clientVersion: '2.20250311.03.00' }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'x-youtube-client-name': '2', 'x-youtube-client-version': '2.20250311.03.00' } },
  ANDROID_VR: { body: { clientName: 'ANDROID_VR', clientVersion: '1.61.48', deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32, osName: 'Android', osVersion: '12L' }, headers: { 'user-agent': 'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip', 'x-youtube-client-name': '28', 'x-youtube-client-version': '1.61.48' } },
};

export async function innertubePlayer(videoId: string, client = 'ANDROID'): Promise<PlayerResponse> {
  const c = CLIENTS[client] ?? CLIENTS.ANDROID;
  const embed = client === 'TV_EMBEDDED' || client === 'WEB_EMBEDDED';
  const r = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${INNERTUBE_KEY}&prettyPrint=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...c.headers },
    body: JSON.stringify({ context: { client: { ...c.body, hl: 'en', gl: 'US' }, ...(embed ? { thirdParty: { embedUrl: 'https://www.google.com/' } } : {}) }, videoId, contentCheckOk: true, racyCheckOk: true }),
  });
  if (!r.ok) throw new Error(`innertube ${client} ${r.status}`);
  return r.json();
}

export async function timedtextDirect(videoId: string): Promise<{ xml: string; lang: string; kind: 'manual' | 'asr' } | null> {
  // Unsigned timedtext endpoint. Works for some tracks without a signature; try manual then ASR.
  for (const [q, kind] of [[`v=${videoId}&lang=en`, 'manual'], [`v=${videoId}&lang=en&kind=asr`, 'asr']] as const) {
    const r = await fetch(`https://www.youtube.com/api/timedtext?${q}&fmt=srv3`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const xml = r.ok ? await r.text() : '';
    if (xml.includes('<p')) return { xml, lang: 'en', kind };
  }
  return null;
}

async function watchPageFallback(videoId: string): Promise<PlayerResponse> {
  const r = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'accept-language': 'en' } });
  const html = await r.text();
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\});\s*(?:var|<\/script>)/s);
  if (!m) throw new Error('no player response on watch page');
  return JSON.parse(m[1]);
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

// format=3 XML: <p t="ms" d="ms">text</p>, with optional <s> word spans for ASR tracks
function parseTimedText(xml: string): Cue[] {
  const cues: Cue[] = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const t = +(attrs.match(/\bt="(\d+)"/)?.[1] ?? 0);
    const d = +(attrs.match(/\bd="(\d+)"/)?.[1] ?? 0);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    cues.push({ start: t / 1000, end: (t + d) / 1000, text });
  }
  return cues;
}

export interface YouTubeFetch { meta: SourceMeta; turns: Turn[]; cues: number }

// Seed path: captions XML fetched elsewhere (e.g. from a residential IP) pushed in with the request.
export function fromCaptionsXml(videoId: string, xml: string, meta: Partial<SourceMeta>): YouTubeFetch {
  const cues = parseTimedText(xml);
  if (!cues.length) throw new Error('captions XML had no cues');
  const turns = segmentCues(cues, null);
  return { cues: cues.length, turns, meta: { kind: 'youtube', id: videoId, title: meta.title ?? `YouTube ${videoId}`, author: meta.author ?? null, duration: meta.duration ?? cues.at(-1)!.end, captionKind: meta.captionKind ?? 'manual', language: meta.language ?? 'en', url: `https://www.youtube.com/watch?v=${videoId}` } };
}

export const CLIENT_ORDER = ['ANDROID', 'IOS', 'ANDROID_VR', 'TV_EMBEDDED', 'WEB_EMBEDDED', 'MWEB'];

// Public mirrors that expose captions as WebVTT / JSON. Tried in order; any one that works is enough.
export const INVIDIOUS = ['https://yewtu.be', 'https://inv.nadeko.net', 'https://invidious.nerdvpn.de', 'https://iv.ggtyler.dev', 'https://invidious.privacyredirect.com', 'https://inv.tux.pizza'];
export const PIPED = ['https://pipedapi.kavin.rocks', 'https://pipedapi.adminforge.de', 'https://api.piped.yt', 'https://pipedapi.r4fo.com'];

function parseVtt(vtt: string): Cue[] {
  const cues: Cue[] = [];
  const ts = (s: string) => { const [hms, ms] = s.split('.'); const p = hms.split(':').map(Number); const base = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; return base + (+(ms ?? 0)) / 1000; };
  const blocks = vtt.replace(/\r/g, '').split(/\n\n+/);
  let last = '';
  for (const b of blocks) {
    const m = b.match(/(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})/);
    if (!m) continue;
    const text = b.slice(b.indexOf('\n', b.indexOf('-->')) + 1).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text || text === last) continue; // auto captions repeat lines
    last = text;
    cues.push({ start: ts(m[1]), end: ts(m[2]), text });
  }
  return cues;
}

export async function mirrorsFetch(videoId: string, log?: (m: string) => void): Promise<{ cues: Cue[]; title: string | null; author: string | null; duration: number | null; kind: 'manual' | 'asr'; lang: string } | null> {
  const withTimeout = (p: Promise<Response>, ms = 6000) => Promise.race([p, new Promise<Response>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  for (const base of INVIDIOUS) {
    try {
      const r = await withTimeout(fetch(`${base}/api/v1/captions/${videoId}`, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } }));
      if (!r.ok) { log?.(`${base}: ${r.status}`); continue; }
      const raw = await r.json() as { captions?: Array<{ label?: string; language_code?: string; languageCode?: string; url: string }> };
      const caps = (raw.captions ?? []).map(c => ({ label: c.label ?? '', language_code: c.language_code ?? c.languageCode ?? '', url: c.url }));
      if (!caps.length) { log?.(`${base}: no captions`); continue; }
      const en = caps.filter(c => c.language_code.startsWith('en'));
      const pick = en.find(c => !/auto/i.test(c.label)) ?? en[0] ?? caps[0];
      const v = await withTimeout(fetch(base + pick.url, { headers: { 'user-agent': 'Mozilla/5.0' } }), 8000);
      if (!v.ok) { log?.(`${base}: vtt ${v.status}`); continue; }
      const cues = parseVtt(await v.text()); if (!cues.length) continue;
      let title: string | null = null, author: string | null = null, duration: number | null = null;
      try { const m = await withTimeout(fetch(`${base}/api/v1/videos/${videoId}?fields=title,author,lengthSeconds`, { headers: { accept: 'application/json' } }), 5000); if (m.ok) { const mj = await m.json() as any; title = mj.title ?? null; author = mj.author ?? null; duration = mj.lengthSeconds ?? null; } } catch { /* optional */ }
      log?.(`${base}: ok ${cues.length} cues`);
      return { cues, title, author, duration, kind: /auto/i.test(pick.label) ? 'asr' : 'manual', lang: pick.language_code };
    } catch (e) { log?.(`${base}: ${(e as Error).message}`); }
  }
  // youtubetranscript.com: unofficial, returns timedtext XML
  try {
    const r = await withTimeout(fetch(`https://youtubetranscript.com/?server_vid2=${videoId}`, { headers: { 'user-agent': 'Mozilla/5.0', accept: '*/*' } }), 8000);
    const xml = r.ok ? await r.text() : '';
    if (xml.includes('<text')) {
      const cues: Cue[] = []; const re = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g; let m: RegExpExecArray | null;
      while ((m = re.exec(xml))) { const text = decodeEntities(m[3].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(); if (text) cues.push({ start: +m[1], end: +m[1] + +m[2], text }); }
      if (cues.length) { log?.(`youtubetranscript.com: ok ${cues.length} cues`); return { cues, title: null, author: null, duration: null, kind: 'asr', lang: 'en' }; }
    }
    log?.(`youtubetranscript.com: ${r.status} ${xml.slice(0, 60).replace(/\s+/g, ' ')}`);
  } catch (e) { log?.(`youtubetranscript.com: ${(e as Error).message}`); }
  for (const base of PIPED) {
    try {
      const r = await withTimeout(fetch(`${base}/streams/${videoId}`, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } }));
      if (!r.ok) { log?.(`${base}: ${r.status}`); continue; }
      const j = await r.json() as { title?: string; uploader?: string; duration?: number; subtitles?: Array<{ url: string; code: string; autoGenerated: boolean }> };
      const subs = j.subtitles ?? []; if (!subs.length) { log?.(`${base}: no subtitles`); continue; }
      const en = subs.filter(s => s.code.startsWith('en'));
      const pick = en.find(s => !s.autoGenerated) ?? en[0] ?? subs[0];
      const v = await withTimeout(fetch(pick.url, { headers: { 'user-agent': 'Mozilla/5.0' } }), 8000);
      if (!v.ok) { log?.(`${base}: vtt ${v.status}`); continue; }
      const cues = parseVtt(await v.text()); if (!cues.length) continue;
      log?.(`${base}: ok ${cues.length} cues`);
      return { cues, title: j.title ?? null, author: j.uploader ?? null, duration: j.duration ?? null, kind: pick.autoGenerated ? 'asr' : 'manual', lang: pick.code };
    } catch (e) { log?.(`${base}: ${(e as Error).message}`); }
  }
  return null;
}

export async function fetchYouTube(videoId: string, log?: (m: string) => void): Promise<YouTubeFetch> {
  let pr: PlayerResponse = {};
  let tracks: NonNullable<NonNullable<PlayerResponse['captions']>['playerCaptionsTracklistRenderer']>['captionTracks'] = [];
  let lastStatus = '';
  // YouTube's bot check on datacenter IPs is intermittent, so the cascade is tried in rounds.
  outer: for (let round = 0; round < 3; round++) {
    for (const client of ['ANDROID', 'IOS', 'ANDROID_VR', 'MWEB']) {
      try {
        const p = await innertubePlayer(videoId, client);
        const t = p.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
        lastStatus = `${client}: ${p.playabilityStatus?.status ?? '?'} ${p.playabilityStatus?.reason ?? ''} tracks=${t.length}`;
        log?.(lastStatus);
        if (p.videoDetails?.title && !pr.videoDetails) pr = p;
        if (t.length) { pr = p; tracks = t; break outer; }
        if (p.playabilityStatus?.status === 'OK' || p.playabilityStatus?.status === 'UNPLAYABLE') { /* genuinely no captions on this client; keep trying others once */ }
      } catch (e) { lastStatus = `${client}: ${(e as Error).message}`; log?.(lastStatus); }
    }
    await new Promise(r => setTimeout(r, 500 * (round + 1)));
  }
  if (!tracks.length) {
    try { const alt = await watchPageFallback(videoId); tracks = alt.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []; log?.(`watch page: ${alt.playabilityStatus?.status ?? '?'} tracks=${tracks.length}`); if (!pr.videoDetails || tracks.length) pr = alt; } catch (e) { log?.(`watch page: ${(e as Error).message}`); }
  }
  if (!tracks.length) {
    const mir = await mirrorsFetch(videoId, log);
    if (mir) {
      const turns = segmentCues(mir.cues, null);
      const meta: SourceMeta = { kind: 'youtube', id: videoId, title: mir.title ?? pr.videoDetails?.title ?? `YouTube ${videoId}`, author: mir.author ?? pr.videoDetails?.author ?? null, duration: mir.duration ?? (mir.cues.at(-1)?.end ?? null), captionKind: mir.kind, language: mir.lang, url: `https://www.youtube.com/watch?v=${videoId}` };
      return { meta, turns, cues: mir.cues.length };
    }
    const direct = await timedtextDirect(videoId);
    if (direct) {
      log?.(`timedtext direct: ok (${direct.kind})`);
      const cues = parseTimedText(direct.xml);
      const turns = segmentCues(cues, null);
      const meta: SourceMeta = { kind: 'youtube', id: videoId, title: pr.videoDetails?.title ?? `YouTube ${videoId}`, author: pr.videoDetails?.author ?? null, duration: pr.videoDetails?.lengthSeconds ? +pr.videoDetails.lengthSeconds : (cues.at(-1)?.end ?? null), captionKind: direct.kind, language: direct.lang, url: `https://www.youtube.com/watch?v=${videoId}` };
      return { meta, turns, cues: cues.length };
    }
    const why = pr.playabilityStatus?.status && pr.playabilityStatus.status !== 'OK' ? ` (YouTube said: ${pr.playabilityStatus.reason ?? pr.playabilityStatus.status})` : '';
    throw new Error(`Could not get captions for this video${why}. Paste a transcript instead.`);
  }
  // prefer manual English, then ASR English, then any manual, then any
  const en = tracks.filter(t => t.languageCode.toLowerCase().startsWith('en'));
  const pick = en.find(t => !t.kind) ?? en.find(t => t.kind === 'asr') ?? tracks.find(t => !t.kind) ?? tracks[0];
  const r = await fetch(pick.baseUrl, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`caption fetch ${r.status}`);
  const xml = await r.text();
  const cues = parseTimedText(xml);
  if (!cues.length) throw new Error('Caption track was empty. Paste a transcript instead.');
  const turns = segmentCues(cues, null);
  const meta: SourceMeta = {
    kind: 'youtube', id: videoId,
    title: pr.videoDetails?.title ?? `YouTube ${videoId}`,
    author: pr.videoDetails?.author ?? null,
    duration: pr.videoDetails?.lengthSeconds ? +pr.videoDetails.lengthSeconds : (cues.at(-1)?.end ?? null),
    captionKind: pick.kind === 'asr' ? 'asr' : 'manual',
    language: pick.languageCode, url: `https://www.youtube.com/watch?v=${videoId}`,
  };
  return { meta, turns, cues: cues.length };
}

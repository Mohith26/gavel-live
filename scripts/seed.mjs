// Seed the cache for the example videos by fetching captions from this machine
// (YouTube does not bot-check residential IPs) and pushing the XML to the Worker.
// usage: node scripts/seed.mjs https://gavel.mohithgajjela.com id1 id2 ...
const base = process.argv[2];
const ids = process.argv.slice(3);
const KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';
for (const id of ids) {
  const r = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${KEY}&prettyPrint=false`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip' }, body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en' } }, videoId: id, contentCheckOk: true, racyCheckOk: true }) });
  const j = await r.json();
  const tracks = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!tracks.length) { console.log(id, 'NO TRACKS', j?.playabilityStatus); continue; }
  const en = tracks.filter(t => t.languageCode.startsWith('en'));
  const pick = en.find(t => !t.kind) ?? en.find(t => t.kind === 'asr') ?? tracks[0];
  const xml = await (await fetch(pick.baseUrl)).text();
  const body = { url: `https://www.youtube.com/watch?v=${id}`, captionsXml: xml, title: j.videoDetails?.title, author: j.videoDetails?.author, duration: +j.videoDetails?.lengthSeconds, captionKind: pick.kind === 'asr' ? 'asr' : 'manual', force: process.argv.includes('--force') };
  console.log(`\n== ${id} ${body.title} (${body.duration}s, ${body.captionKind}, ${xml.length} bytes)`);
  const t0 = Date.now();
  const res = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event: (.*)$/m.exec(chunk)?.[1]; const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? 'null');
    if (ev === 'result') console.log(`   done ${((Date.now() - t0) / 1000).toFixed(0)}s: ${data.stats.claims} claims, ${data.stats.flagged_strict} flagged strict, ${data.stats.flagged_sensitive} sensitive, ${data.stats.turns} turns, parse repaired ${data.stats.parse_repaired + data.stats.parse_scavenged}, calls ${data.stats.llm_calls}`);
    else if (ev === 'error') console.log('   ERROR', data.message); else if (ev === 'stage' && data.stage !== 'fetch') console.log(`   [${((Date.now() - t0) / 1000).toFixed(0)}s] ${data.msg}`); } }
}

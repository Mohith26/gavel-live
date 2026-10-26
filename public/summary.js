/* Summary document page: /s/<id>. Loads (or builds) the doc, renders it, links every point to its evidence. */
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

const id = decodeURIComponent(location.pathname.slice(3));
const S = { doc: null, result: null, player: null, playerReady: false, selected: null };
const SUP = { SUPPORTED: 'ok', PARTIALLY_SUPPORTED: 'warn', UNSUPPORTED: 'bad', CONTRADICTED: 'bad', UNJUDGED: 'neutral' };
const SUPLBL = { SUPPORTED: 'Supported', PARTIALLY_SUPPORTED: 'Partly supported', UNSUPPORTED: 'Not found in the transcript', CONTRADICTED: 'Contradicted by the transcript', UNJUDGED: 'Not judged' };

$('#reportLink').href = '/v/' + id; $('#reportLink2').href = '/v/' + id;
$('#printBtn').onclick = () => window.print();
$('#shareBtn').onclick = async () => { await navigator.clipboard.writeText(location.origin + '/s/' + id).catch(() => {}); $('#shareBtn').textContent = 'Copied'; setTimeout(() => $('#shareBtn').textContent = 'Copy link', 1400); };

async function main() {
  const r = await fetch('/api/result/' + id);
  if (!r.ok) { showErr('No saved analysis for this recording. Check it on the home page first.'); return; }
  S.result = await r.json();
  const force = new URLSearchParams(location.search).get('force') === '1';
  if (!force) { const s = await fetch('/api/summary/' + id); if (s.ok) { render(await s.json()); return; } }
  build(force);
}
async function build(force) {
  setStep('write', 'active');
  const headers = { 'content-type': 'application/json' }; const key = localStorage.getItem('gavel.key'); if (key) headers['x-gemini-key'] = key;
  let res; try { res = await fetch('/api/summarize', { method: 'POST', headers, body: JSON.stringify({ id, force }) }); } catch (e) { showErr('Network error: ' + e.message); return; }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); handleEvent(chunk); } }
}
function handleEvent(chunk) {
  const ev = /^event: (.*)$/m.exec(chunk)?.[1]; const dataLine = /^data: (.*)$/m.exec(chunk)?.[1]; if (!ev || !dataLine) return;
  const data = JSON.parse(dataLine);
  if (ev === 'stage') { if (data.stage === 'cache') return; setStep(data.stage, data.stage === 'done' ? 'done' : 'active'); $('#progNote').textContent = data.msg; }
  else if (ev === 'doc') { setStep('write', 'done'); $('#progTitle').textContent = data.title; const box = $('#progDoc'); box.innerHTML = ''; data.sections.forEach((h, i) => { const d = el('div', '', esc(h)); d.style.animationDelay = (i * 60) + 'ms'; box.appendChild(d); }); $('#progNote').textContent = `${data.points} points to link`; }
  else if (ev === 'judged') { setStep('evidence', 'active'); $('#progNote').textContent = `Linked ${data.done} of ${data.total} points`; }
  else if (ev === 'error') showErr(data.message);
  else if (ev === 'doc_result') setTimeout(() => render(data), 250);
}
function setStep(stage, state) { const s = document.querySelector(`.step[data-stage="${stage}"]`); if (!s) return; document.querySelectorAll('.step.active').forEach(x => { if (x !== s) x.className = 'step done'; }); s.className = 'step ' + state; }
function showErr(msg) { const b = $('#progErr'); b.textContent = msg; b.classList.remove('hidden'); document.querySelectorAll('.step.active').forEach(x => x.className = 'step err'); }

/* render */
function point(p, opts = {}) {
  const cls = SUP[p.support] || 'neutral';
  const d = el('div', 'pt ' + cls + (opts.cls ? ' ' + opts.cls : '')); d.dataset.id = p.id;
  d.innerHTML = `<span class="sup-dot ${cls}" title="${esc(SUPLBL[p.support] || '')}"></span>
    <div class="pt-body">${opts.lead ? `<b class="pt-lead">${esc(opts.lead)}</b> ` : ''}<span class="pt-text">${esc(opts.text ?? p.text)}</span>
    ${p.at !== null ? `<button class="ts" type="button" data-at="${p.at}">${fmt(p.at)}</button>` : ''}</div>`;
  d.onclick = e => { select(p); if (e.target.closest('.ts')) seek(p.at, true); };
  return d;
}
function render(doc) {
  S.doc = doc;
  $('#progress').classList.add('hidden'); $('#doc').classList.remove('hidden');
  const src = S.result.source;
  document.title = doc.title + ' · Gavel Live';
  $('#dMeta').textContent = [src.author, src.duration ? fmt(src.duration) : null, src.title !== doc.title ? src.title : null].filter(Boolean).join(' · ');
  $('#dTitle').textContent = doc.title; $('#dOverview').textContent = doc.overview;
  const st = doc.stats;
  $('#dStats').innerHTML = `<span><b>${st.points}</b> points</span><span><i class="sup-dot ok"></i><b>${st.supported}</b> supported</span><span><i class="sup-dot warn"></i><b>${st.partial}</b> partly</span><span><i class="sup-dot bad"></i><b>${st.unsupported + st.contradicted}</b> not found</span><span class="muted">${st.llm_calls} model calls · ${(st.ms / 1000).toFixed(0)}s</span>`;

  const tk = $('#dTakeaways'); tk.innerHTML = ''; doc.takeaways.forEach((p, i) => { const li = el('li'); li.appendChild(point(p, { lead: String(i + 1).padStart(2, '0') })); tk.appendChild(li); });

  // timeline: proportional bar of sections
  const tl = $('#dTimeline'); tl.innerHTML = ''; tl.classList.toggle('hidden', doc.sections.length < 2);
  const dur = src.duration || Math.max(...doc.sections.map(s => s.end || 0), 1);
  doc.sections.forEach((s, i) => { const a = s.start ?? 0; const nextStart = doc.sections[i + 1]?.start; const b = (s.end !== null && s.end > a) ? s.end : (nextStart !== null && nextStart !== undefined && nextStart > a ? nextStart : dur); const seg = el('button', 'tl-seg', `<span>${esc(s.heading)}</span>`); seg.type = 'button'; seg.style.left = (100 * a / dur) + '%'; seg.style.width = Math.max(2, 100 * (b - a) / dur) + '%'; seg.title = `${s.heading} · ${fmt(a)}–${fmt(b)}`; seg.onclick = () => { document.getElementById('sec-' + i).scrollIntoView({ block: 'start', behavior: 'smooth' }); seek(a, false); }; tl.appendChild(seg); });

  const sc = $('#dSections'); sc.innerHTML = '';
  doc.sections.forEach((s, i) => {
    const d = el('section', 'sec'); d.id = 'sec-' + i;
    d.innerHTML = `<div class="sec-head"><span class="sec-n">${i + 1}</span><div><h3>${esc(s.heading)}</h3><p class="gist">${esc(s.gist)}</p></div><button class="ts sec-ts" type="button" data-at="${s.start ?? 0}">${s.start !== null ? fmt(s.start) : ''}${s.end !== null && s.end > (s.start ?? 0) ? ' – ' + fmt(s.end) : ''}</button></div>`;
    d.querySelector('.sec-ts').onclick = () => seek(s.start ?? 0, true);
    const pts = el('div', 'sec-points'); s.points.forEach(p => pts.appendChild(point(p))); d.appendChild(pts);
    sc.appendChild(d);
  });

  if (doc.terms.length) { const t = $('#dTerms'); t.innerHTML = ''; doc.terms.forEach(x => t.appendChild(point(x.point, { lead: x.term, text: x.meaning, cls: 'term' }))); } else $('#dTermsSec').classList.add('hidden');
  if (doc.numbers.length) { const n = $('#dNumbers'); n.innerHTML = ''; doc.numbers.forEach(p => { const li = el('li'); li.appendChild(point(p)); n.appendChild(li); }); } else $('#dNumbersSec').classList.add('hidden');

  setupPlayer();
  // reveal on scroll
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .15 });
  document.querySelectorAll('.sec, .doc-sec > h2, .takeaways li').forEach(x => io.observe(x));
}

function select(p) {
  S.selected = p.id;
  document.querySelectorAll('.pt').forEach(x => x.classList.toggle('selected', +x.dataset.id === p.id));
  const card = $('#evCard'); const t = p.turn !== null ? S.result.turns[p.turn] : null;
  const cls = SUP[p.support] || 'neutral';
  card.innerHTML = `<div class="ev-head"><span class="pill ${cls}">${esc(SUPLBL[p.support])}</span>${t ? `<button class="ts" type="button">${fmt(t.start)}</button>` : ''}</div>
    <p class="ev-point">${esc(p.text)}</p>
    ${p.quote ? `<p class="ev-quote">“${esc(p.quote)}”</p>` : ''}
    ${t ? `<p class="ev-passage"><span class="muted">${t.speaker ? esc(t.speaker) + ' · ' : ''}${fmt(t.start)}–${fmt(t.end)}</span><br>${highlight(t.text, p.quote)}</p>` : '<p class="ev-empty">No passage was linked.</p>'}
    ${p.why ? `<p class="ev-why"><b>Why:</b> ${esc(p.why)}</p>` : ''}
    ${t ? `<button class="btn ghost sm" id="evPlay" type="button">Play this passage ▸</button>` : ''}`;
  const b = card.querySelector('#evPlay'); if (b) b.onclick = () => seek(t.start, true);
  const tsb = card.querySelector('.ts'); if (tsb && t) tsb.onclick = () => seek(t.start, true);
  if (window.innerWidth < 980) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function highlight(text, quote) {
  const e = esc(text); if (!quote) return e;
  const q = esc(quote.replace(/^["“”']+|["“”'.]+$/g, '')).trim(); if (q.length < 6) return e;
  const i = e.toLowerCase().indexOf(q.toLowerCase()); if (i < 0) return e;
  return e.slice(0, i) + '<mark>' + e.slice(i, i + q.length) + '</mark>' + e.slice(i + q.length);
}

/* player */
function setupPlayer() {
  const box = $('#player'); box.innerHTML = '';
  if (S.result.source.kind !== 'youtube') { box.innerHTML = '<div class="no-audio">Pasted transcript: no audio. Timestamps come from the file or are estimated.</div>'; return; }
  box.classList.add('has-video');
  const mount = el('div'); box.appendChild(mount);
  const make = () => { S.player = new YT.Player(mount, { videoId: S.result.source.id, playerVars: { rel: 0, modestbranding: 1 }, events: { onReady: () => { S.playerReady = true; } } }); };
  if (window.YT && YT.Player) make(); else window.onYouTubeIframeAPIReady = make;
}
function seek(sec, play) { if (sec === null || sec === undefined) return; if (!S.player || !S.playerReady) { if (S.result.source.kind === 'youtube') window.open(`https://www.youtube.com/watch?v=${S.result.source.id}&t=${Math.max(0, Math.floor(sec - 1))}s`, '_blank'); return; } S.player.seekTo(Math.max(0, sec - 0.5), true); if (play) S.player.playVideo(); }

main();

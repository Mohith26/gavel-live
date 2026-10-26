/* Gavel Live client. No framework; state is one object, render is explicit. */
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

const EXAMPLES = [
  { id: 'kCc8FmEb1nY', label: 'Karpathy: Let\'s build GPT', kind: 'lecture · 1h56' },
  { id: 'L2bxwnm7JG4', label: 'What is Ocean Acidification?', kind: 'explainer · 1:43' },
  { id: 'aircAruvnKk', label: '3Blue1Brown: But what is a neural network?', kind: 'lecture · 18m' },
  { id: 'zjkBMFhNj_g', label: 'Karpathy: Intro to LLMs', kind: 'talk · 59m' },
  { id: 'L_Guz73e6fw', label: 'Lex Fridman with Sam Altman', kind: 'podcast · 2h24' },
];

const S = { userClaims: [], result: null, op: localStorage.getItem('gavel.op') || 'strict', selected: null, onlyFlagged: false, follow: true, player: null, playerReady: false, tick: null, es: null };

/* ---------- key ---------- */
const keyDlg = $('#keyDlg');
$('#keyBtn').onclick = () => { $('#keyInput').value = localStorage.getItem('gavel.key') || ''; keyDlg.showModal(); };
$('#keySave').onclick = e => { e.preventDefault(); const v = $('#keyInput').value.trim(); if (v) localStorage.setItem('gavel.key', v); keyDlg.close(); };
$('#keyClear').onclick = () => { localStorage.removeItem('gavel.key'); $('#keyInput').value = ''; keyDlg.close(); };

/* ---------- input ---------- */
$('#form').onsubmit = e => { e.preventDefault(); const u = $('#url').value.trim(); if (u) analyze({ url: u }); };
$('#pasteToggle').onclick = () => $('#pasteBox').classList.toggle('hidden');
$('#pasteGo').onclick = () => { const t = $('#pasteText').value; if (t.trim().length < 200) return alert('Paste at least a few paragraphs.'); analyze({ transcript: t, title: $('#pasteTitle').value }); };
$('#rerun').onclick = () => { if (!S.result) return; const src = S.result.source; analyze(src.kind === 'youtube' ? { url: src.url, force: true } : { transcript: S.lastTranscript || '', title: src.title, force: true }); };
$('#share').onclick = async () => { if (!S.result) return; const link = location.origin + '/v/' + S.result.source.id; await navigator.clipboard.writeText(link).catch(() => {}); $('#share').textContent = 'COPIED'; setTimeout(() => $('#share').textContent = 'COPY SHARE LINK', 1400); };

const exWrap = $('#examples');
for (const ex of EXAMPLES) { const b = el('button', '', `${esc(ex.label)}<small>${esc(ex.kind)}</small>`); b.type = 'button'; b.onclick = () => { $('#url').value = 'https://www.youtube.com/watch?v=' + ex.id; analyze({ url: $('#url').value }); }; exWrap.appendChild(b); }

fetch('/api/recent').then(r => r.json()).then(list => {
  if (!list.length) return; $('#recent').classList.remove('hidden');
  for (const r of list) { const b = el('button', '', `${esc(r.title).slice(0, 60)}<small>${r.flagged}/${r.claims} flagged</small>`); b.type = 'button'; b.onclick = () => loadShared(r.id); $('#recentChips').appendChild(b); }
}).catch(() => {});

/* ---------- analyze (SSE over fetch) ---------- */
async function analyze(body) {
  if (body.transcript) S.lastTranscript = body.transcript;
  showProgress(body.url ? body.url : (body.title || 'Pasted transcript'));
  $('#go').disabled = true;
  const headers = { 'content-type': 'application/json' };
  const key = localStorage.getItem('gavel.key'); if (key) headers['x-gemini-key'] = key;
  let res;
  try { res = await fetch('/api/analyze', { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch (e) { logErr('Network error: ' + e.message); $('#go').disabled = false; return; }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); handleEvent(chunk); }
  }
  $('#go').disabled = false;
}
function handleEvent(chunk) {
  const ev = /^event: (.*)$/m.exec(chunk)?.[1]; const dataLine = /^data: (.*)$/m.exec(chunk)?.[1]; if (!ev || !dataLine) return;
  const data = JSON.parse(dataLine);
  if (ev === 'stage') logStage(data.stage, data.msg);
  else if (ev === 'source') { $('#progTitle').textContent = data.title + (data.author ? ' · ' + data.author : ''); logStage('source', `${data.turns} turns from ${data.cues ?? '?'} caption cues (${data.captionKind}${data.language ? ', ' + data.language : ''})`); }
  else if (ev === 'claims') { logStage('claims', `${data.count} claims drafted`); const box = $('#progClaims'); box.innerHTML = ''; data.claims.forEach((c, i) => { const d = el('div', '', `<span class="mono" style="color:var(--muted)">${String(c.id).padStart(2, '0')}</span>  ${esc(c.text)}`); d.style.animationDelay = (i * 60) + 'ms'; box.appendChild(d); }); }
  else if (ev === 'judged') logStage('judge', `Judged ${data.done} / ${data.total}`);
  else if (ev === 'error') logErr(data.message);
  else if (ev === 'result') { logStage('done', 'Done'); setTimeout(() => render(data), 250); }
}
function showProgress(title) { $('#progress').classList.remove('hidden'); $('#result').classList.add('hidden'); $('#progLog').innerHTML = ''; $('#progClaims').innerHTML = ''; $('#progTitle').textContent = title; $('#progKicker').textContent = 'WORKING'; $('#progress').scrollIntoView({ block: 'start' }); }
function logStage(stage, msg) {
  const log = $('#progLog'); log.querySelectorAll('li.active').forEach(li => li.classList.replace('active', 'done'));
  let li = log.querySelector(`li[data-stage="${stage}"]`);
  if (!li) { li = el('li'); li.dataset.stage = stage; log.appendChild(li); }
  li.textContent = msg; li.classList.remove('done'); li.classList.add(stage === 'done' ? 'done' : 'active');
}
function logErr(msg) { const li = el('li', 'err', esc(msg)); $('#progLog').appendChild(li); $('#progKicker').textContent = 'STOPPED'; }

async function loadShared(id) {
  showProgress('Loading ' + id); logStage('cache', 'Loading cached result');
  const r = await fetch('/api/result/' + id); if (!r.ok) return logErr('No cached result for ' + id + '. Analyze it from the home page.');
  render(await r.json());
}
if (location.pathname.startsWith('/v/')) loadShared(location.pathname.slice(3));

/* ---------- render ---------- */
function render(result) {
  S.result = result; S.selected = null; S.userClaims = [];
  $('#progress').classList.add('hidden'); $('#result').classList.remove('hidden');
  const src = result.source, st = result.stats;
  $('#rKicker').textContent = `${src.kind === 'youtube' ? 'YOUTUBE' : 'TRANSCRIPT'} · ${src.author ? src.author.toUpperCase() + ' · ' : ''}${src.duration ? fmt(src.duration) : ''} · ${src.captionKind.toUpperCase()} CAPTIONS · ${result.model.toUpperCase()}`;
  $('#rTitle').textContent = src.title; $('#rSummary').textContent = result.summary;
  $('#srcMeta').textContent = `${st.turns} turns · ${st.words.toLocaleString()} words`;
  history.replaceState(null, '', '/v/' + src.id);
  renderStats(); renderOp(); renderTurns(); renderClaims(); setupPlayer();
  $('#result').scrollIntoView({ block: 'start' });
}
function flagged(c) { return S.op === 'strict' ? c.flag_strict : c.flag_sensitive; }
function renderStats() {
  const st = S.result.stats; const n = S.result.claims.filter(flagged).length;
  $('#rStats').innerHTML = `<div class="flag"><b>${n}</b>flagged (${S.op})</div><div><b>${st.supported}</b>supported</div><div><b>${st.partial}</b>partial</div><div><b>${st.unsupported}</b>unsupported</div><div><b>${st.contradicted}</b>contradicted</div><div><b>${st.parse_repaired + st.parse_scavenged}</b>verdicts repaired</div>`;
  $('#claimCount').textContent = `${st.claims} claims · ${st.llm_calls} model calls · ${(st.ms / 1000).toFixed(0)}s`;
}
function renderOp() { $('#opToggle').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.op === S.op)); }
$('#opToggle').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.op = b.dataset.op; localStorage.setItem('gavel.op', S.op); renderOp(); renderStats(); renderClaims(); };
$('#onlyFlagged').onchange = e => { S.onlyFlagged = e.target.checked; renderClaims(); };
$('#followAudio').onchange = e => { S.follow = e.target.checked; };

function renderTurns() {
  const box = $('#turns'); box.innerHTML = '';
  for (const t of S.result.turns) {
    const d = el('div', 'turn'); d.dataset.id = t.id;
    d.innerHTML = `<div class="turn-meta">${t.speaker ? `<span class="spk">${esc(t.speaker)}</span>` : ''}<span>${fmt(t.start)}</span></div><p>${esc(t.text)}</p>`;
    d.onclick = () => seek(t.start);
    box.appendChild(d);
  }
}
function renderClaims() {
  const box = $('#claims'); box.innerHTML = '';
  const turns = S.result.turns;
  for (const c of [...S.userClaims, ...S.result.claims]) {
    const isF = flagged(c); if (S.onlyFlagged && !isF) continue;
    const d = el('div', 'claim' + (isF ? ' flagged' : '') + (c.user ? ' user' : '') + (S.selected === c.id ? ' selected' : '')); d.dataset.id = c.id;
    const ev = c.evidence.map(i => turns[i]).filter(Boolean);
    const at = ev.length ? fmt(ev[0].start) : (c.candidates.length ? fmt(turns[c.candidates[0]].start) : '');
    d.innerHTML = `
      <div class="meta"><span>${c.user ? 'YOUR CLAIM' : 'CLAIM ' + String(c.id).padStart(2, '0')}</span>${c.speaker ? `<span>${esc(c.speaker).toUpperCase()}</span>` : ''}<span>${at ? 'AT ' + at : ''}</span>${c.parse !== 'strict' ? `<span>PARSE ${c.parse.toUpperCase()}</span>` : ''}</div>
      <p class="text">${esc(c.text)}</p>
      <div class="badges">
        ${isF ? '<span class="badge flag">FLAGGED</span>' : ''}
        <span class="badge ${c.support}">${c.support.replace('_', ' ')}</span>
        <span class="badge">${c.severity}</span>
        <span class="badge">SCORE ${c.score.toFixed(2)}</span>
        ${c.attribution_ok === false ? '<span class="badge attr">MISATTRIBUTED</span>' : c.attribution_ok === true ? '<span class="badge attr">ATTRIBUTION OK</span>' : ''}
      </div>
      ${c.why ? `<p class="why"><span class="mono" style="font-size:10px;letter-spacing:.12em;color:var(--muted)">JUDGE RATIONALE</span><br>${esc(c.why)}</p>` : ''}
      ${c.quote ? `<p class="quote">"${esc(c.quote)}"</p>` : ''}
      <button class="ev-btn" type="button">${ev.length ? 'HEAR EVIDENCE' : 'HEAR NEAREST PASSAGE'} ▸</button>`;
    d.onclick = e => { select(c.id); if (e.target.closest('.ev-btn')) playEvidence(c); };
    box.appendChild(d);
  }
}
function select(id) {
  S.selected = id;
  document.querySelectorAll('.claim').forEach(x => x.classList.toggle('selected', +x.dataset.id === id));
  const c = [...S.userClaims, ...S.result.claims].find(x => x.id === id); if (!c) return;
  const evSet = new Set(c.evidence.length ? c.evidence : c.candidates.slice(0, 1));
  document.querySelectorAll('.turn').forEach(t => { const tid = +t.dataset.id; t.classList.toggle('evidence', evSet.has(tid)); t.classList.toggle('primary', tid === (c.evidence[0] ?? c.candidates[0])); });
  const first = document.querySelector('.turn.primary'); if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function playEvidence(c) { const turns = S.result.turns; const t = turns[c.evidence[0] ?? c.candidates[0]]; if (t) seek(t.start, true); }

/* ---------- player ---------- */
function setupPlayer() {
  const box = $('#player'); box.innerHTML = '';
  if (S.player) { try { S.player.destroy(); } catch {} S.player = null; S.playerReady = false; }
  clearInterval(S.tick);
  if (S.result.source.kind !== 'youtube') { box.innerHTML = '<div style="padding:18px;color:var(--muted);font-family:var(--mono);font-size:12px">Pasted transcript: no audio. Timestamps are from the file or estimated at 155 wpm.</div>'; box.style.aspectRatio = 'auto'; return; }
  box.style.aspectRatio = '16/9';
  const mount = el('div'); box.appendChild(mount);
  const make = () => { S.player = new YT.Player(mount, { videoId: S.result.source.id, playerVars: { rel: 0, modestbranding: 1 }, events: { onReady: () => { S.playerReady = true; }, onStateChange: () => {} } }); S.tick = setInterval(followTick, 500); };
  if (window.YT && YT.Player) make(); else window.onYouTubeIframeAPIReady = make;
}
function seek(sec, play = false) {
  if (!S.player || !S.playerReady) return;
  S.player.seekTo(Math.max(0, sec - 0.5), true); if (play) S.player.playVideo();
}
function followTick() {
  if (!S.follow || !S.player || !S.playerReady || !S.result) return;
  let t; try { t = S.player.getCurrentTime(); } catch { return; }
  const turns = S.result.turns; let cur = null;
  for (const x of turns) { if (x.start <= t) cur = x; else break; }
  document.querySelectorAll('.turn').forEach(d => d.classList.toggle('playing', cur && +d.dataset.id === cur.id));
  if (cur && S.player.getPlayerState && S.player.getPlayerState() === 1) { const d = document.querySelector('.turn.playing'); if (d && !isVisible(d, $('#turns'))) d.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}
function isVisible(elm, scroller) { const a = elm.getBoundingClientRect(), b = scroller.getBoundingClientRect(); return a.top >= b.top && a.bottom <= b.bottom; }

/* ---------- keyboard ---------- */
document.addEventListener('keydown', e => {
  if (!S.result || e.target.matches('input,textarea')) return;
  const vis = [...S.userClaims, ...S.result.claims].filter(c => !S.onlyFlagged || flagged(c)); if (!vis.length) return;
  const idx = vis.findIndex(c => c.id === S.selected);
  if (e.key === 'j' || e.key === 'J') { const n = vis[Math.min(vis.length - 1, idx + 1)]; select(n.id); document.querySelector(`.claim[data-id="${n.id}"]`)?.scrollIntoView({ block: 'nearest' }); }
  else if (e.key === 'k' || e.key === 'K') { const n = vis[Math.max(0, idx - 1)]; select(n.id); document.querySelector(`.claim[data-id="${n.id}"]`)?.scrollIntoView({ block: 'nearest' }); }
  else if (e.key === 'e' || e.key === 'E') { const c = vis[idx]; if (c) playEvidence(c); }
  else if (e.key === ' ' && S.player && S.playerReady) { e.preventDefault(); S.player.getPlayerState() === 1 ? S.player.pauseVideo() : S.player.playVideo(); }
});

/* ---------- check your own claim ---------- */
$('#checkForm').onsubmit = async e => {
  e.preventDefault(); if (!S.result) return;
  const text = $('#checkInput').value.trim(); if (text.length < 8) return;
  const btn = $('#checkGo'); btn.disabled = true; btn.textContent = 'JUDGING';
  const headers = { 'content-type': 'application/json' }; const key = localStorage.getItem('gavel.key'); if (key) headers['x-gemini-key'] = key;
  try {
    const r = await fetch('/api/check', { method: 'POST', headers, body: JSON.stringify({ id: S.result.source.id, claim: text }) });
    const j = await r.json();
    if (!r.ok) { alert(j.error || 'Check failed'); return; }
    j.user = true; j.id = -(S.userClaims.length + 1);
    S.userClaims.unshift(j); $('#checkInput').value = '';
    renderClaims(); select(j.id);
  } catch (err) { alert('Check failed: ' + err.message); }
  finally { btn.disabled = false; btn.textContent = 'VERIFY'; }
};

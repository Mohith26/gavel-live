/* Gavel Live client. No framework; one state object, explicit render. */
const $ = (s, el = document) => el.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };

const EXAMPLES = [
  { id: 'kCc8FmEb1nY', label: "Karpathy: Let's build GPT from scratch", kind: 'Lecture · 1h 56m' },
  { id: 'L_Guz73e6fw', label: 'Lex Fridman with Sam Altman', kind: 'Podcast · 2h 24m' },
  { id: 'aircAruvnKk', label: '3Blue1Brown: But what is a neural network?', kind: 'Lecture · 18m' },
  { id: 'zjkBMFhNj_g', label: 'Karpathy: Intro to Large Language Models', kind: 'Talk · 59m' },
  { id: 'L2bxwnm7JG4', label: 'What is Ocean Acidification?', kind: 'Explainer · 1m 43s' },
];

const WANT_DOC = 'gavel.wantDoc';
$('#wantDoc').checked = localStorage.getItem(WANT_DOC) === '1';
$('#wantDoc').onchange = e => localStorage.setItem(WANT_DOC, e.target.checked ? '1' : '0');
const S = { result: null, userClaims: [], sensitive: localStorage.getItem('gavel.sensitive') === '1', selected: null, onlyFlagged: false, follow: true, player: null, playerReady: false, tick: null, lastTranscript: '' };

/* settings */
const keyDlg = $('#keyDlg');
$('#keyBtn').onclick = () => { $('#keyInput').value = localStorage.getItem('gavel.key') || ''; keyDlg.showModal(); };
$('#keySave').onclick = e => { e.preventDefault(); const v = $('#keyInput').value.trim(); if (v) localStorage.setItem('gavel.key', v); keyDlg.close(); };
$('#keyClear').onclick = () => { localStorage.removeItem('gavel.key'); $('#keyInput').value = ''; keyDlg.close(); };

/* input */
$('#form').onsubmit = e => { e.preventDefault(); const u = $('#url').value.trim(); const t = $('#pasteText').value.trim(); if (u && t.length > 200) analyze({ url: u, transcript: t, title: $('#pasteTitle').value }); else if (u) analyze({ url: u }); };
$('#pasteToggle').onclick = () => $('#pasteBox').classList.toggle('hidden');
$('#pasteGo').onclick = () => { const t = $('#pasteText').value; const u = $('#url').value.trim(); if (t.trim().length < 200) return alert('Paste at least a few paragraphs.'); analyze(u ? { url: u, transcript: t, title: $('#pasteTitle').value } : { transcript: t, title: $('#pasteTitle').value }); };
$('#rerun').onclick = () => { if (!S.result) return; const src = S.result.source; analyze(src.kind === 'youtube' && src.captionKind !== 'pasted' ? { url: src.url, force: true } : { url: src.url || undefined, transcript: S.lastTranscript, title: src.title, force: true }); };
$('#share').onclick = async () => { if (!S.result) return; await navigator.clipboard.writeText(location.origin + '/v/' + S.result.source.id).catch(() => {}); $('#share').textContent = 'Copied'; setTimeout(() => $('#share').textContent = 'Copy link', 1400); };

function exampleCard(id, title, kind, onClick) {
  const b = el('button', 'card', `<img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt=""><div class="body"><p class="t">${esc(title)}</p><div class="k">${esc(kind)}</div></div>`);
  b.type = 'button'; b.onclick = onClick; return b;
}
for (const ex of EXAMPLES) $('#examples').appendChild(exampleCard(ex.id, ex.label, ex.kind, () => loadShared(ex.id, 'https://www.youtube.com/watch?v=' + ex.id)));
fetch('/api/recent').then(r => r.json()).then(list => {
  const fresh = list.filter(r => !EXAMPLES.some(e => e.id === r.id)); if (!fresh.length) return;
  $('#recent').classList.remove('hidden');
  for (const r of fresh.slice(0, 5)) $('#recentChips').appendChild(exampleCard(r.id, r.title, `${r.flagged} of ${r.claims} flagged`, () => loadShared(r.id)));
}).catch(() => {});

/* analyze (SSE over fetch) */
async function analyze(body) {
  if (body.transcript) S.lastTranscript = body.transcript;
  S.autoDoc = $('#wantDoc').checked;
  showProgress(body.url ? 'Checking the video' : (body.title || 'Checking the transcript'));
  $('#go').disabled = true;
  const headers = { 'content-type': 'application/json' };
  const key = localStorage.getItem('gavel.key'); if (key) headers['x-gemini-key'] = key;
  let res;
  try { res = await fetch('/api/analyze', { method: 'POST', headers, body: JSON.stringify(body) }); }
  catch (e) { showErr('Network error: ' + e.message); $('#go').disabled = false; return; }
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
  if (ev === 'stage') { if (data.stage === 'cache') return; setStep(data.stage === 'done' ? 'judge' : data.stage, data.stage === 'done' ? 'done' : 'active'); if (data.stage === 'done') markAllDone(); $('#progNote').textContent = data.msg.replace(/^Fetching captions: /, ''); }
  else if (ev === 'source') { $('#progTitle').textContent = data.title; setStep('fetch', 'done'); $('#progNote').textContent = `${data.turns} passages` + (data.captionKind ? ` from ${data.captionKind === 'asr' ? 'auto-generated' : data.captionKind} captions` : ''); }
  else if (ev === 'claims') { setStep('summary', 'done'); const box = $('#progClaims'); box.innerHTML = ''; data.claims.forEach((c, i) => { const d = el('div', '', esc(c.text)); d.style.animationDelay = (i * 50) + 'ms'; box.appendChild(d); }); }
  else if (ev === 'judged') { setStep('judge', 'active'); $('#progNote').textContent = `Judged ${data.done} of ${data.total} claims`; }
  else if (ev === 'error') showErr(data.message);
  else if (ev === 'result') setTimeout(() => render(data), 300);
}
function showProgress(title) { $('#progress').classList.remove('hidden'); $('#result').classList.add('hidden'); $('#progErr').classList.add('hidden'); $('#progClaims').innerHTML = ''; $('#progNote').textContent = ''; $('#progTitle').textContent = title; $('#progKicker').textContent = ''; document.querySelectorAll('.step').forEach(s => s.className = 'step'); setStep('fetch', 'active'); $('#progress').scrollIntoView({ block: 'start' }); }
function setStep(stage, state) { const s = document.querySelector(`.step[data-stage="${stage}"]`); if (!s) return; document.querySelectorAll('.step.active').forEach(x => { if (x !== s) x.className = 'step done'; }); s.className = 'step ' + state; }
function markAllDone() { document.querySelectorAll('.step').forEach(s => s.className = 'step done'); }
function showErr(msg) { const b = $('#progErr'); b.textContent = msg; b.classList.remove('hidden'); document.querySelectorAll('.step.active').forEach(x => x.className = 'step err'); }

async function loadShared(id, fallbackUrl) {
  showProgress('Loading saved result');
  const r = await fetch('/api/result/' + id);
  if (r.ok) return render(await r.json());
  if (fallbackUrl) return analyze({ url: fallbackUrl });
  showErr('No saved result for ' + id + '. Paste the link on the home page to check it.');
}
if (location.pathname.startsWith('/v/')) loadShared(location.pathname.slice(3));

/* render */
const LABEL = { SUPPORTED: ['Supported', 'ok'], PARTIALLY_SUPPORTED: ['Partly supported', 'partial'], UNSUPPORTED: ['Not supported', 'bad'], CONTRADICTED: ['Contradicted', 'bad'] };
function flagged(c) { return S.sensitive ? c.flag_sensitive : c.flag_strict; }

function render(result) {
  S.result = result; S.selected = null; S.userClaims = [];
  $('#progress').classList.add('hidden'); $('#result').classList.remove('hidden');
  const src = result.source, st = result.stats;
  const cap = src.captionKind === 'asr' ? 'auto-generated captions' : src.captionKind === 'pasted' ? 'pasted transcript' : 'captions';
  $('#rMeta').textContent = [src.author, src.duration ? fmt(src.duration) : null, cap, `${st.turns} passages`, `${st.words.toLocaleString()} words`].filter(Boolean).join(' · ');
  $('#rTitle').textContent = src.title; $('#rSummary').textContent = result.summary;
  $('#srcMeta').textContent = src.kind === 'youtube' ? 'click a passage to jump there' : 'timestamps estimated';
  $('#sensitive').checked = S.sensitive;
  history.replaceState(null, '', '/v/' + src.id);
  renderScore(); renderTurns(); renderClaims(); setupPlayer();
  $('#docBtn').href = '/s/' + src.id;
  fetch('/api/summary/' + src.id, { method: 'HEAD' }).then(r => { $('#docBtn').textContent = r.ok ? 'Summary document ▸' : 'Build a summary document ▸'; }).catch(() => {});
  if (S.autoDoc) { S.autoDoc = false; location.href = '/s/' + src.id; return; }
  $('#result').scrollIntoView({ block: 'start' });
}
function renderScore() {
  const st = S.result.stats, all = S.result.claims; const n = all.filter(flagged).length;
  const pct = k => (100 * k / Math.max(1, all.length)).toFixed(1) + '%';
  $('#rScore').innerHTML = `<div class="big">${n}<small>of ${all.length} claims flagged</small></div>
    <div class="bar"><span style="width:${pct(st.supported)};background:var(--ok)"></span><span style="width:${pct(st.partial)};background:var(--warn)"></span><span style="width:${pct(st.unsupported + st.contradicted)};background:var(--bad)"></span></div>
    <div class="legend"><span><i style="background:var(--ok)"></i>${st.supported} supported</span><span><i style="background:var(--warn)"></i>${st.partial} partly</span><span><i style="background:var(--bad)"></i>${st.unsupported} unsupported</span><span><i style="background:var(--bad)"></i>${st.contradicted} contradicted</span></div>
    <div class="foot">${st.llm_calls} model calls · ${(st.ms / 1000).toFixed(0)}s · ${st.parse_repaired + st.parse_scavenged} verdicts needed repair</div>`;
  $('#claimCount').textContent = `${all.length} claims`;
}
$('#sensitive').onchange = e => { S.sensitive = e.target.checked; localStorage.setItem('gavel.sensitive', S.sensitive ? '1' : '0'); renderScore(); renderClaims(); };
$('#onlyFlagged').onchange = e => { S.onlyFlagged = e.target.checked; renderClaims(); };
$('#followAudio').onchange = e => { S.follow = e.target.checked; };

function renderTurns() {
  const box = $('#turns'); box.innerHTML = '';
  for (const t of S.result.turns) {
    const d = el('div', 'turn'); d.dataset.id = t.id;
    d.innerHTML = `<div class="turn-meta">${t.speaker ? `<span class="spk">${esc(t.speaker)}</span>` : ''}<span>${fmt(t.start)}</span></div><p>${esc(t.text)}</p>`;
    d.onclick = () => seek(t.start, true);
    box.appendChild(d);
  }
}
function renderClaims() {
  const box = $('#claims'); box.innerHTML = '';
  const turns = S.result.turns;
  for (const c of [...S.userClaims, ...S.result.claims]) {
    const isF = flagged(c); if (S.onlyFlagged && !isF) continue;
    const [lbl, cls] = LABEL[c.support] || ['Unknown', 'neutral'];
    const d = el('div', 'claim' + (isF ? ' flagged' : c.support === 'PARTIALLY_SUPPORTED' ? ' partial' : '') + (c.user ? ' user' : '') + (S.selected === c.id ? ' selected' : '')); d.dataset.id = c.id;
    const ev = c.evidence.map(i => turns[i]).filter(Boolean);
    const at = ev.length ? fmt(ev[0].start) : (c.candidates.length ? fmt(turns[c.candidates[0]].start) : '');
    d.innerHTML = `
      <div class="label"><b>${c.user ? 'Your claim' : 'Claim ' + c.id}</b>${c.speaker ? `<span>· ${esc(c.speaker)}</span>` : ''}${at ? `<span>· at ${at}</span>` : ''}</div>
      <p class="text">${esc(c.text)}</p>
      <div class="pills">
        ${isF ? '<span class="pill bad">Flagged</span>' : ''}
        <span class="pill ${cls}">${lbl}</span>
        ${c.severity !== 'NONE' ? `<span class="pill neutral">${c.severity === 'MAJOR' ? 'Major issue' : 'Minor issue'}</span>` : ''}
        ${c.attribution_ok === false ? '<span class="pill bad">Wrong speaker</span>' : c.attribution_ok === true ? '<span class="pill info">Speaker confirmed</span>' : ''}
        ${c.parse !== 'strict' ? '<span class="pill neutral">verdict repaired</span>' : ''}
      </div>
      ${c.why ? `<p class="why"><b>Why:</b> ${esc(c.why)}</p>` : ''}
      ${c.quote ? `<p class="quote">"${esc(c.quote)}"</p>` : ''}
      <button class="ev-btn" type="button">${ev.length ? 'Play the evidence' : 'Play the nearest passage'} ▸</button>`;
    d.onclick = e => { select(c.id); if (e.target.closest('.ev-btn')) playEvidence(c); };
    box.appendChild(d);
  }
  if (!box.children.length) box.innerHTML = '<p style="padding:20px;color:var(--muted);font-size:14px">Nothing flagged at this setting. Turn on "Also flag partial support" to see borderline claims.</p>';
}
function select(id) {
  S.selected = id;
  document.querySelectorAll('.claim').forEach(x => x.classList.toggle('selected', +x.dataset.id === id));
  const c = [...S.userClaims, ...S.result.claims].find(x => x.id === id); if (!c) return;
  const evSet = new Set(c.evidence.length ? c.evidence : c.candidates.slice(0, 1));
  const primary = c.evidence[0] ?? c.candidates[0];
  document.querySelectorAll('.turn').forEach(t => { const tid = +t.dataset.id; t.classList.toggle('evidence', evSet.has(tid)); t.classList.toggle('primary', tid === primary); });
  const first = document.querySelector('.turn.primary'); if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function playEvidence(c) { const t = S.result.turns[c.evidence[0] ?? c.candidates[0]]; if (t) seek(t.start, true); }

/* player */
function setupPlayer() {
  const box = $('#player'); box.innerHTML = '';
  if (S.player) { try { S.player.destroy(); } catch {} S.player = null; S.playerReady = false; }
  clearInterval(S.tick);
  if (S.result.source.kind !== 'youtube') { box.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px;background:var(--surface2)">No audio for a pasted transcript. Timestamps come from the file, or are estimated at 155 words per minute.</div>'; box.style.aspectRatio = 'auto'; box.style.background = 'transparent'; return; }
  box.style.aspectRatio = '16/9'; box.style.background = '#000';
  const mount = el('div'); box.appendChild(mount);
  const make = () => { S.player = new YT.Player(mount, { videoId: S.result.source.id, playerVars: { rel: 0, modestbranding: 1 }, events: { onReady: () => { S.playerReady = true; } } }); S.tick = setInterval(followTick, 500); };
  if (window.YT && YT.Player) make(); else window.onYouTubeIframeAPIReady = make;
}
function seek(sec, play = false) { if (!S.player || !S.playerReady) return; S.player.seekTo(Math.max(0, sec - 0.5), true); if (play) S.player.playVideo(); }
function followTick() {
  if (!S.follow || !S.player || !S.playerReady || !S.result) return;
  let t; try { t = S.player.getCurrentTime(); } catch { return; }
  let cur = null; for (const x of S.result.turns) { if (x.start <= t) cur = x; else break; }
  document.querySelectorAll('.turn').forEach(d => d.classList.toggle('playing', cur && +d.dataset.id === cur.id));
  if (cur && S.player.getPlayerState && S.player.getPlayerState() === 1) { const d = document.querySelector('.turn.playing'); if (d && !isVisible(d, $('#turns'))) d.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}
function isVisible(elm, scroller) { const a = elm.getBoundingClientRect(), b = scroller.getBoundingClientRect(); return a.top >= b.top && a.bottom <= b.bottom; }

/* keyboard */
document.addEventListener('keydown', e => {
  if (!S.result || e.target.matches('input,textarea')) return;
  const vis = [...S.userClaims, ...S.result.claims].filter(c => !S.onlyFlagged || flagged(c)); if (!vis.length) return;
  const idx = vis.findIndex(c => c.id === S.selected);
  const go = n => { select(n.id); document.querySelector(`.claim[data-id="${n.id}"]`)?.scrollIntoView({ block: 'nearest' }); };
  if (e.key === 'j' || e.key === 'J') go(vis[Math.min(vis.length - 1, idx + 1)]);
  else if (e.key === 'k' || e.key === 'K') go(vis[Math.max(0, idx - 1)]);
  else if (e.key === 'e' || e.key === 'E') { const c = vis[idx]; if (c) playEvidence(c); }
  else if (e.key === ' ' && S.player && S.playerReady) { e.preventDefault(); S.player.getPlayerState() === 1 ? S.player.pauseVideo() : S.player.playVideo(); }
});

/* check your own claim */
$('#checkForm').onsubmit = async e => {
  e.preventDefault(); if (!S.result) return;
  const text = $('#checkInput').value.trim(); if (text.length < 8) return;
  const btn = $('#checkGo'); btn.disabled = true; btn.textContent = 'Judging';
  const headers = { 'content-type': 'application/json' }; const key = localStorage.getItem('gavel.key'); if (key) headers['x-gemini-key'] = key;
  try {
    const r = await fetch('/api/check', { method: 'POST', headers, body: JSON.stringify({ id: S.result.source.id, claim: text }) });
    const j = await r.json();
    if (!r.ok) { alert(j.error || 'Check failed'); return; }
    j.user = true; j.id = -(S.userClaims.length + 1);
    S.userClaims.unshift(j); $('#checkInput').value = '';
    renderClaims(); select(j.id); $('#claims').scrollTop = 0;
  } catch (err) { alert('Check failed: ' + err.message); }
  finally { btn.disabled = false; btn.textContent = 'Verify'; }
};

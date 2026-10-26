const base = process.argv[2] || 'https://gavel.mohithgajjela.com';
const url = process.argv[3] || 'https://www.youtube.com/watch?v=L2bxwnm7JG4';
const t0 = Date.now();
const r = await fetch(base + '/api/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, force: process.argv.includes('--force') }) });
console.log('status', r.status, r.headers.get('content-type'));
const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', result = null;
while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
  let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
    const ev = /^event: (.*)$/m.exec(chunk)?.[1]; const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? 'null');
    if (ev === 'result') result = data; else if (ev === 'claims') console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] claims:`, data.count); else console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] ${ev}:`, JSON.stringify(data).slice(0, 160)); } }
if (result) {
  console.log('\n==', result.source.title, '|', result.stats);
  for (const c of result.claims) console.log(`${String(c.id).padStart(2)} ${c.flag_strict ? 'FLAG' : '    '} ${c.support.padEnd(19)} ${c.severity.padEnd(5)} ev=${JSON.stringify(c.evidence)} p=${c.parse}\n     ${c.text}\n     why: ${c.why}`);
}

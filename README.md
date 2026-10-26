# Gavel Live

**Paste a YouTube lecture, podcast or talk. Get a claim-by-claim report you can audit against the audio.**

Live: https://gavel.mohithgajjela.com
Benchmark it is calibrated on: https://mohithgajjela.com/field-03-gavel (code: https://github.com/Mohith26/gavel)

Gavel Live is the product end of the Gavel benchmark. The benchmark measured how well a judge model can tell whether a sentence about a spoken proceeding is supported by the transcript, using 1,064 claims with planted errors and an exact ledger. This tool runs that same judge on any recording with captions:

1. **Turns.** Captions are cut into 20 to 45 second turns at sentence boundaries (shorter for short clips), so every claim cites a short, playable span. Pasted transcripts keep their speakers and timestamps (SRT, WebVTT, `[mm:ss] Speaker: text`, or YouTube's "Show transcript" panel copied as alternating lines).
2. **Claims.** One model call writes 6 to 20 standalone claims that keep names, numbers and hedges exactly as spoken, plus a one-paragraph summary. Each claim carries the model's timestamp guess.
3. **Evidence.** BM25 over the turns, five candidates per claim, plus the turn at the timestamp guess. No embeddings: in the benchmark ablation lexical retrieval alone scored as well as hybrid (subset F1 0.8295 vs 0.8114), so there is no vector index to run or pay for.
4. **Judge.** Claims are judged in batches of six, each against only its candidates: SUPPORTED, PARTIALLY_SUPPORTED, UNSUPPORTED or CONTRADICTED, with severity, cited evidence, an attribution check, a verbatim quote and a one-sentence rationale. Gemini JSON mode plus the forgiving parser ported from the benchmark (the original strict parser silently dropped 75% of verdicts and defaulted severity). Each verdict records whether it parsed strictly, was repaired, or was scavenged, and the UI shows the count.
5. **Operating point.** Same verdicts, two thresholds, with the benchmark's measured numbers on the toggle. STRICT flags unsupported, contradicted or misattributed claims (precision 0.997, FPR 0.003, recall 0.44). SENSITIVE also flags partial support (recall 0.97, FPR 0.72).
6. **Check your own claim.** Type any statement about the recording; it is retrieved and judged live and the video jumps to the evidence.

Everything else: click a claim to highlight and seek to its evidence, "follow audio" highlights the turn being played, J/K/E/space keyboard, results cached 45 days and shareable at `/v/<videoId>`, a "recently analyzed" strip, bring-your-own Gemini key (kept in localStorage, sent per request, never stored).

## Stack

One Cloudflare Worker (TypeScript, no framework, no runtime dependencies), KV for results and rate counters, static assets for the UI, Gemini `generateContent` with `thinkingBudget: 0` (thinking was 10x the latency for a judge that only reads six passages) and a 25 to 75 s per-call timeout with model fallback. Progress streams to the browser as server-sent events from the same request.

```
src/index.ts      routes: /api/analyze (SSE), /api/check, /api/result/:id, /api/recent, /v/:id, /healthz
src/youtube.ts    InnerTube caption fetch (client cascade with retry rounds), watch-page fallback, mirror fallback, captions-XML seed path
src/segment.ts    turn segmentation; pasted-transcript parsers
src/bm25.ts       tokenizer + BM25
src/gemini.ts     generateContent client: JSON mode, timeout, backoff, fallback model
src/judge.ts      judge prompt, response schema, forgiving parser
src/pipeline.ts   summary -> claims -> retrieve -> judge -> decision rules -> stats; judgeOne for user claims
public/           index.html, styles.css, app.js
scripts/smoke.mjs end-to-end run against a deployment
scripts/seed.mjs  fetch captions from a residential IP and push them to the Worker (YouTube bot-checks datacenter IPs)
```

## Known limits

- **YouTube blocks datacenter IPs intermittently** ("Sign in to confirm you're not a bot"). The Worker retries a client cascade in rounds and falls back to mirrors; when all of that fails the UI tells you to paste the transcript from YouTube's "Show transcript" panel together with the link, which still embeds the video. The example videos are pre-seeded from a residential IP with `scripts/seed.mjs`.
- **Free-tier model quotas.** `gemini-3.5-flash` allows 20 requests per day per project on the free tier; the deployment runs `gemini-3-flash-preview` with `gemini-3.5-flash-lite` as fallback and caps the shared key at `DAILY_CAP` analyses per day and `IP_HOURLY_CAP` per IP. Your own key lifts the caps. Paid tier is the real fix.
- Auto-generated captions have no speakers, so attribution is only checked when the transcript names them.
- The judge sees retrieved passages, not the whole recording, so omissions are not an error it can see. That is the next extension (planted-omission benchmark + coverage check).
- Not medical or legal advice. No clinical data.

## Run

```
npm install
printf "GEMINI_API_KEY=...\n" > .dev.vars
npx wrangler dev --port 8790
node scripts/smoke.mjs http://localhost:8790 https://www.youtube.com/watch?v=L2bxwnm7JG4
npx wrangler deploy
```

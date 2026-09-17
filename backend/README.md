# ResearchGap Agent Backend

Express API on Azure App Service that fronts **Azure OpenAI** (`gpt-4.1-mini`) for the
ResearchGap AI assistant. The static site's chat widget (`../script.js`) calls it directly — no
separate frontend project is involved; see the root `README.md` for the full picture of what's
deployed where.

**Compliance note**: the 2,799-patent corpus (`data/patents.json`, this folder's own copy) is an
input to this repo's deterministic computation (`corpus.js`, `retrieval.js`, `scoring.js`), never
a knowledge source fed to the model. Don't upload `patents.json` as an Azure AI Foundry knowledge
file — `systemPrompt.js` already instructs the model to treat every number as the backend's job
and only cite public sources it actually searched for.

## Local setup

```bash
cd backend
npm install
cp .env.example .env   # fill in your Azure OpenAI endpoint/key/deployment
npm run dev
```

Health check: `GET http://localhost:8080/api/health`
Chat endpoint: `POST http://localhost:8080/api/chat` with body `{ "message": "...", "history": [...] }` (or `{ "history": [...including the latest turn] }`), returns `{ "reply": "...", "tool_calls": [...], "usage": {...} }`. `tool_calls` is a full trace of every tool the model invoked this turn (name, args, result) — useful for debugging, the frontend mostly uses it to pull out a completed `compute_patentability` result and render the White-Space section from it. `usage` is the real Azure OpenAI token count for the turn (`prompt_tokens`/`completion_tokens`/`total_tokens`).

`lang` (`"en"` default, or `"zh"`) can be passed in the body of `/api/chat`, `/api/patentability`,
and `/api/sensitivity` to switch the system prompt language and every score-note/label string.

## Tool-calling (`server.js` + `tools.js`)

`/api/chat` gives the model two tools and loops up to `MAX_TOOL_ROUNDS` (4) times, executing each
tool call server-side and feeding the result back, before returning the final text reply. This is
what enforces "backend decides, AI explains" — the model can't compute a score itself, it can
only call `compute_patentability` and relay what comes back.

- **`compute_patentability`** — wraps `patentability.js`. For upload-mode text, it auto-detects
  the cutoff year (`features.detectCutoffYear` — first-page copyright/publication/conference-year
  patterns checked against citation-stripped text, falling back to plain year frequency, so a
  cited earlier work doesn't win over the paper's own year) and technical features
  (`features.extractFeatures` — word-boundary + case-sensitive-acronym matching against a
  canonical 17-feature SDN/NFV/5G/6G/cloud-native taxonomy) and scores directly in one shot
  whenever it finds *any* real signal — it only stops to ask the user when detection is genuinely
  empty. It also runs its own in-corpus prior-art search (`retrieval.js`) and real per-year
  literature counts (`literature.js` → OpenAlex) before scoring, so Novelty and Temporal have real
  data without depending on the model to search first. `server.js` additionally extracts the real
  uploaded document text straight from the request body and overrides whatever the model passed
  as the `text` argument, rather than trusting the model to relay a large block of text into a
  function-call argument verbatim.
- **`search_prior_art`** — queries **Semantic Scholar + Crossref + arXiv** in parallel
  (`Promise.allSettled`, so one source failing doesn't blank the others) for literature — all
  free, keyless, no registration — **plus a real general-web/patent-office search** (`webSearch.js`)
  via Azure OpenAI's Responses API `web_search` tool (Bing-grounded), which can reach Google
  Patents, USPTO, EPO, and general engineering sources. This replaces the old standalone Bing
  Search v7 dependency (retired by Microsoft in August 2025, removed rather than left silently
  failing) with its real, current successor — no new Azure resource, no Entra ID: it's a second,
  isolated call to the *same* Azure OpenAI resource's `/openai/v1/responses` endpoint using the
  *same* `AZURE_OPENAI_API_KEY`. Costs ~$0.014 per web search call (billed as "Grounding with
  Bing Search" on the Azure invoice) — negligible next to the per-analysis token cost. Web
  results are informational only (for the model to cite in prose); they never feed
  `computeScore()` — in-corpus retrieval (`compute_patentability`'s own `prior_art[]`, via
  `retrieval.js`) remains the sole, backend-controlled source for the Novelty score itself.

`server.js` also keyword-detects whether the latest user turn is asking about POS/scoring vs.
white-space specifically, and for the white-space case renders the technology-combination table
**deterministically from the tool's JSON** rather than trusting the model's own formatting —
`gpt-4.1-mini` was observed (reproducibly) re-answering with the wrong table otherwise.

## Patentability score

`scoring.js` implements the four-factor POS formula:

```
POS = 100 × (0.40·Novelty + 0.25·Crowding + 0.20·Temporal + 0.15·Regional)
```

- **Novelty** — `0.5 × (1 − max feature overlap with the top-5 in-corpus prior art)` `+`
  `0.5 × (share of case features unmatched in any of that prior art)`. Prior art and the
  feature-overlap match are both computed by `retrieval.js`'s deterministic BM25 search — never
  supplied by the model. Falls back to a disclosed neutral 0.5 only if retrieval genuinely finds
  nothing comparable before the cutoff.
- **Crowding** — percentile rank of (cutoff-filtered patents matching ≥2 of the case's own
  features) among the hit-counts of every pairwise feature-taxonomy combination — a
  feature-combination density, not a whole-IPC-group population cap.
- **Temporal** — growth of real per-year literature counts (`literature.js` → OpenAlex,
  auto-fetched before scoring so this rarely falls back to neutral) over the 5 years ending at
  the cutoff, halved if matched-set patent filings in that window already outnumber the
  literature.
- **Regional** — target-jurisdiction gap plus applicant HHI concentration, both computed over the
  same feature-matched set as Crowding; the family-gap term is disclosed as an approximation
  (jurisdiction presence, not true patent-family linkage — the corpus has no family ID).

An out-of-scope gate (`scoring.outOfScopeReason`) refuses to score text with fewer than 2
in-scope matched features, or whose dominant classification isn't one of the corpus's known
sub-technology groups — returning a reason instead of a diluted number.

Two modes via `POST /api/patentability` (also reachable mid-conversation via the
`compute_patentability` tool):
- `{"mode":"corpus","patent_id":"<publication_number>"}` — cutoff = that patent's filing date.
- `{"mode":"upload","text":"...", "publication_year"?, "features"?, "target_jurisdiction"?}` —
  omitting `publication_year`/`features` triggers auto-detection, not a hard stop.

`POST /api/sensitivity` takes the same body, and instead of the score returns a report of how the
grade would change under each of the four weights shifted ±5%/±10% (rescaling the other three
proportionally) — a robustness check the frontend/team can show alongside a headline score.

Run `npm test` for the full suite (`node --test`, 22 tests across `smoke.test.js` and
`fixtures.test.js`) — cutoff filtering, auto-detection, the "backend always recomputes even if
the caller injects a score or a prior-art claim" guarantees, prompt-injection resistance, and
acceptance criteria against 7 real fixture documents in `fixtures/` (distinct topics score
distinctly and reproducibly, a mature/well-established technique scores lower Novelty than
genuinely novel fixtures, off-domain/nonsense input is never scored, a citation-year trap still
resolves to the paper's own year).

## Session document storage

`POST /api/session/document` stores uploaded document text server-side against a `session_id`
(in-memory, auto-expiring) so a long multi-turn conversation doesn't need to keep re-sending the
full document text on every turn; `/api/chat` and `/api/patentability` both accept an optional
`session_id` to look it up. This is purely an optimization — callers that don't use it still work
unmodified, sending the document text directly as before. Nothing is written to a database or
kept past the session TTL.

## Deploying

The backend is a **self-contained deployable unit** — its own copy of `data/patents.json`, no
dependency on anything outside this folder. It targets Azure App Service, Linux, Node 22-LTS.
App settings (`AZURE_OPENAI_ENDPOINT`/`_API_KEY`/`_DEPLOYMENT`/`_API_VERSION`, `ALLOWED_ORIGIN`,
`DEFAULT_LANG`, `DEFAULT_TARGET_JURISDICTION`) are set on the hosting platform, never committed —
`.env` is git-ignored. CORS should be locked to the actual frontend origin, not `*`.

## Cost control

- `MAX_HISTORY_MESSAGES` in `server.js` caps how much conversation history gets sent per request
  (bounds both token cost and context-window risk).
- `gpt-4.1-mini` (Global Standard deployment) was chosen for cost/availability over larger models.
- All literature/retrieval sources (Semantic Scholar/Crossref/arXiv/OpenAlex, in-corpus BM25) are
  free and keyless, so they add no extra API cost — only a small amount of added latency per
  analysis.

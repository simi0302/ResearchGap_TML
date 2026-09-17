# ResearchGap Agent Backend

Express API on **Azure App Service** (`researchgap-agent-api`, live at
https://researchgap-agent-api.azurewebsites.net) that fronts **Azure OpenAI** (`gpt-4.1-mini`)
for the ResearchGap AI assistant. The static site's chat widget (`../script.js`) calls it
directly — no separate frontend project is involved; see the root `README.md` for the full
picture of what's deployed where.

**Compliance note**: the 2,799-patent corpus (`data/patents.json`, this folder's own copy) is an
input to this repo's deterministic computation (`corpus.js`, `scoring.js`), never a knowledge
source fed to the model. Don't upload `patents.json` as an Azure AI Foundry knowledge file —
`systemPrompt.js` already instructs the model to treat every number as the backend's job and only
cite public sources it actually searched for.

## Local setup

```bash
cd backend
npm install
cp .env.example .env   # fill in your Azure OpenAI endpoint/key/deployment
npm run dev
```

Health check: `GET http://localhost:8080/api/health`
Chat endpoint: `POST http://localhost:8080/api/chat` with body `{ "message": "...", "history": [...] }` (or `{ "history": [...including the latest turn] }`), returns `{ "reply": "...", "tool_calls": [...], "usage": {...} }`. `tool_calls` is a full trace of every tool the model invoked this turn (name, args, result) — useful for debugging, the frontend mostly uses it to pull out a completed `compute_patentability` result and render the White-Space section from it.

## Tool-calling (`server.js` + `tools.js`)

`/api/chat` gives the model two tools and loops up to `MAX_TOOL_ROUNDS` (4) times, executing each
tool call server-side and feeding the result back, before returning the final text reply. This is
what enforces "backend decides, AI explains" — the model can't compute a score itself, it can
only call `compute_patentability` and relay what comes back.

- **`compute_patentability`** — wraps `patentability.js`. For upload-mode text, it auto-detects
  the cutoff year (`features.pickCutoffYear` — most-frequent-year heuristic over the real text)
  and technical features (`features.extractFeatures` — keyword match against a ~110-term
  SDN/NFV/5G/6G/cloud-native vocabulary, each mapped to whichever real IPC group co-occurs with
  it most often in the corpus) and scores directly in one shot whenever it finds *any* real
  signal — it only stops to ask the user when detection is genuinely empty. Before returning, it
  also auto-enriches the Temporal factor with a real literature search (see below) if the caller
  didn't already supply `literature[]`. `server.js` additionally extracts the real uploaded
  document text straight from the request body and overrides whatever the model passed as the
  `text` argument, rather than trusting the model to relay a large block of text into a
  function-call argument verbatim.
- **`search_prior_art`** — literature search queries **Semantic Scholar + Crossref + arXiv** in
  parallel (`Promise.allSettled`, so one source failing doesn't blank the others) — all free,
  keyless, no registration. Patents/general-web search needs `BING_SEARCH_KEY` (`.env.example`);
  until that's set it returns `{"unavailable": true, "reason": "..."}` and the tool result
  explicitly tells the model to report that honestly rather than guess a patent number.

`server.js` also keyword-detects whether the latest user turn is asking about POS/win-rate vs.
white-space specifically, and for the white-space case renders the technology-combination table
**deterministically from the tool's JSON** rather than trusting the model's own formatting —
gpt-4.1-mini was observed (reproducibly) re-answering with the wrong table otherwise.

## Patentability score

`scoring.js` implements the four-factor POS formula:

```
POS = 100 × (0.40·Novelty + 0.25·Crowding + 0.20·Temporal + 0.15·Regional)
```

- **Novelty** — needs `prior_art` (from `search_prior_art`, each entry with `matched_features`);
  without it, falls back to a disclosed neutral 0.5.
- **Crowding** — always computed from the real corpus (same-subtech hit count within 200-patent
  normalization).
- **Temporal** — needs `literature` ([{year, ...}]); `tools.js` now auto-searches this before
  scoring if the model didn't supply it, so this rarely falls back to neutral in practice.
- **Regional** — always computed (target-jurisdiction hit count + applicant HHI concentration),
  with its family-gap term disclosed as an approximation (jurisdiction presence, not true
  patent-family linkage — the corpus has no family ID).

Two modes via `POST /api/patentability` (also reachable mid-conversation via the
`compute_patentability` tool):
- `{"mode":"corpus","patent_id":"<publication_number>"}` — cutoff = that patent's filing date.
- `{"mode":"upload","text":"...", "publication_year"?, "features"?, "prior_art"?, "literature"?}` —
  omitting `publication_year`/`features` triggers auto-detection (see above), not a hard stop.

Run `npm test` for the smoke-test suite (`node --test`, 9 tests) — cutoff filtering, auto-
detection, the "backend always recomputes even if the caller injects a score" guarantee, and that
Crowding/Regional are never silently neutral.

## Deploying to Azure App Service

Already live; redeploying after a code change:
```bash
az webapp up --name researchgap-agent-api --resource-group ResearchGap_TML --sku F1
```
(Linux, Node 22-LTS, region `southeastasia`. `backend/` is a self-contained deploy unit — its own
copy of `data/patents.json`, no dependency on anything outside this folder. App settings
`AZURE_OPENAI_ENDPOINT`/`_API_KEY`/`_DEPLOYMENT`/`_API_VERSION` and `ALLOWED_ORIGIN` are set via
`az webapp config appsettings set`, never committed.)

## Cost control

- `MAX_HISTORY_MESSAGES` in `server.js` caps how much conversation history gets sent per request
  (bounds both token cost and context-window risk).
- `gpt-4.1-mini` (Global Standard deployment) was chosen for cost/availability over larger models —
  see the Azure OpenAI deployment in the linked Azure resource for current quota/cost.
- Literature auto-search (Semantic Scholar/Crossref/arXiv) is free and keyless, so it adds no
  extra API cost — only a small amount of added latency per analysis.

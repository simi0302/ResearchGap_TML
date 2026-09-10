# ResearchGap Agent Backend

Thin Express API on Azure App Service that fronts Azure AI Foundry (Azure OpenAI in Foundry Models)
for the ResearchGap AI assistant. This is the piece `frontend/src/lib/agent.ts` calls via
`VITE_AGENT_API_URL`.

**Compliance note** (see the team's HackMD 作戰計畫): the 2,799-patent corpus is an input to this
repo's static computation pipeline (`frontend/scripts/extract_fixtures.py` → `sdnFixtures.ts`), not
a knowledge source for this agent. Don't upload `patents.json`/the CSV as an Azure AI Foundry
knowledge file — `systemPrompt.js` already instructs the model to treat exact numbers as the
backend's job and only cite public sources.

## Local setup

```bash
cd backend
npm install
cp .env.example .env   # fill in your Azure OpenAI endpoint/key/deployment
npm run dev
```

Health check: `GET http://localhost:8080/api/health`
Chat endpoint: `POST http://localhost:8080/api/chat` with body `{ "history": [...], "context"?: {...} }`, returns `{ "reply": "...", "tool_calls": [...] }`. `context`, if present, is injected as an extra system message so the model explains/cites it rather than inventing numbers — pass it the JSON from `/api/patentability`. `tool_calls` is a trace of every tool the model invoked this turn (name, args, result) — handy for debugging, the frontend can ignore it.

## Tool-calling (server.js + tools.js)

`/api/chat` gives the model two tools (OpenAI/Azure-compatible `tools` function-calling) and loops
up to `MAX_TOOL_ROUNDS` (4) times, executing each tool call server-side and feeding the result back,
before returning the final text reply. This is what actually enforces "backend decides, AI explains"
once a real model is connected — the model can't compute a score itself, it can only call
`compute_patentability` and relay what comes back.

- **`compute_patentability`** — calls `patentability.js` directly. Fully functional right now, no
  external credentials needed (pure local computation against `patents.json`).
- **`search_prior_art`** — searches for prior art. The literature half calls the free, keyless
  Semantic Scholar Graph API and works today. The patents/web half needs `BING_SEARCH_KEY`
  (`.env.example`) — until that's set it returns `{"unavailable": true, "reason": "..."}` and the
  tool result explicitly tells the model to report that honestly rather than guess a patent number.

Verified end-to-end (see git history / session notes) by pointing `AZURE_OPENAI_ENDPOINT` at a
scripted local mock that requests `compute_patentability` then replies with the real returned score
— confirms the request→tool-call→execute→feed-back→final-reply loop works before any real Azure
credentials exist. Swapping in the real Azure OpenAI endpoint requires no code changes.

## Patentability score (ResearchGap_Agent_Skill_v2.md §④/§⑤)

`POST /api/patentability` — computes the "可專利性初判分數" and cutoff-filtered corpus stats.
Never calls the model; pure computation against `frontend/public/data/patents.json`. See
`corpus.js` (cutoff filtering, data-driven 12-subtech taxonomy from real IPC codes, density/HHI),
`features.js` (keyword-heuristic feature extraction, not an LLM), `scoring.js` (the five-factor
formula), and `patentability.js` (request orchestration + the Stage 0 confirmation gate).

Two modes:
- `{"mode":"corpus","patent_id":"<publication_number>"}` — cutoff = that patent's filing date.
- `{"mode":"upload","text":"...","publication_year"?:2022,"features"?:[...],"prior_art"?:[...],"literature"?:[...]}` —
  omit `publication_year` or `features` to get a `needs_confirmation` response (candidate years /
  extracted features) instead of a score — the caller (Agent or frontend) must get the user to
  confirm before resubmitting with those fields filled in, per the skill's "Stage 0" rule.

`novelty` and `feature_uniqueness` need `prior_art` (the Agent's web-search results, each entry
carrying `matched_features: ["F1", ...]`); `literature_maturity` needs `literature` (`[{year, ...}]`).
Without them these factors fall back to a neutral 0.5 with a note — they are never guessed.
`prior_art_density` and `applicant_concentration` are always computed from the real corpus.

Run `npm test` for the smoke-test suite (mirrors §⑧ of the skill doc).

**Not yet wired**: nothing in `ChatPage.tsx` calls `/api/patentability` or passes its result as
`/api/chat`'s `context` yet — that frontend integration (an upload UI, or a "score this patent"
button that calls `/api/patentability` then forwards the JSON into `/api/chat`) is still open work.

## Deploying to Azure App Service

1. Create an Azure OpenAI resource inside your Azure AI Foundry project, deploy a chat model
   (e.g. `gpt-4o-mini` or whatever fits the NT$12,000 credit budget), note the endpoint, deployment
   name, and an API key.
2. Create an Azure App Service (Node 18+ runtime).
3. Set the app settings (environment variables) to match `.env.example`: `AZURE_OPENAI_ENDPOINT`,
   `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION`, `ALLOWED_ORIGIN`
   (set this to the deployed frontend's real origin, not `*`, once you know it).
4. Deploy this `backend/` folder (zip deploy, GitHub Actions, or `az webapp up` all work — pick
   whichever your team is already comfortable with).
5. Put the resulting App Service URL + `/api/chat` into the frontend's `VITE_AGENT_API_URL`
   (`frontend/.env`), rebuild, redeploy the frontend.

## Cost control

- `MAX_HISTORY_MESSAGES` in `server.js` caps how much conversation history gets sent per request
  (bounds both token cost and context-window risk). Lower it if the credit runs low.
- Pick a smaller/cheaper Azure OpenAI model for the demo unless quality testing says otherwise —
  this is a competition demo with limited concurrent users, not production traffic.

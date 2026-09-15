# ResearchGap

**Patent & Literature White-Space Analysis Platform** — cross-analyzes patents and academic
literature so researchers can gauge how crowded a technology area is and spot underexplored
"white-space" opportunities before committing to a research direction or patent filing.
Pilot domain: **SDN / NFV / network slicing**.

專利與學術文獻白地分析平台，協助研究人員在投入研究或申請專利前，快速掌握技術主題的競爭密度，
找出尚未被充分探索的「白地」方向。原型以 SDN／NFV／network slicing 為驗證案例。

🔗 **Live demo:** _fill in after enabling GitHub Pages — Settings → Pages → Deploy from branch (`main` / root)_

---

## What's in this repo

This repo holds two different things at two different stages of readiness:

| | What it is | Status |
|---|---|---|
| **`/` (root)** | A dependency-free static prototype — the marketing/demo page. Plain HTML/CSS/JS, no build step. Patent search is real (client-side search over `data/patents.json`, the same 2,799-patent corpus, with Google Patents links); AI chat runs on local canned responses until a backend URL is configured. | Deployable today via GitHub Pages. |
| **`frontend/`** | The real product UI — React 18 + TypeScript + Vite, backed by a real 2,799-patent dataset. | Functional locally (`npm run dev`); not yet deployed. |
| **`backend/`** | An Express API that fronts Azure OpenAI for the AI assistant, with real tool-calling (function calling) so the model can request a computed score or a web search instead of guessing one. | Code complete and unit-tested; not yet deployed, and not yet holding real Azure credentials. |

## Tech stack

**Static prototype (`/`)**
- Vanilla HTML5 / CSS3 (Flexbox + Grid, CSS keyframe animations) / JavaScript (ES6+)
- No framework, no build tooling, no external CDN dependencies
- `IntersectionObserver` for scroll-reveal animations and nav scrollspy
- Real client-side patent search: `data/patents.json` (a copy of the same 2,799-patent corpus
  `frontend/` uses) is fetched once and filtered entirely in the browser — no backend, no
  database. Requires being served over http(s); opening `index.html` via `file://` blocks the
  fetch under Chrome's CORS rules, see "Running locally" below.

**Frontend (`frontend/`)**
- [React 18](https://react.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Vite](https://vitejs.dev/) (dev server + build)
- [ECharts](https://echarts.apache.org/) for data visualization
- [react-router-dom](https://reactrouter.com/) for client-side routing
- Builds to a pure static bundle (`npm run build` → `dist/`) — deployable to any static host

**Backend (`backend/`)**
- [Node.js](https://nodejs.org/) + [Express](https://expressjs.com/)
- [Azure OpenAI](https://learn.microsoft.com/azure/ai-services/openai/) chat completions with
  **function calling / tool-calling** — the model can only report a score via the
  `compute_patentability` tool (pure local computation, no LLM involved in the math) or search
  for prior art via `search_prior_art` ([Semantic Scholar](https://www.semanticscholar.org/product/api)
  Graph API for literature — free, no key required; Bing Web Search for patents/web — optional,
  degrades to an honest "unavailable" response without a key)
- Node's built-in test runner (`node --test`) for the scoring-engine test suite

**Data pipeline**
- A self-built corpus of 2,799 SDN/NFV/network-slicing patents, sourced from a public patent
  database, checked into `frontend/public/data/patents.json`
- IPC-code-driven "sub-technology" taxonomy computed at load time from the real corpus (not a
  hand-picked category list) — see `backend/corpus.js`

## Architecture principle: the backend decides, the AI only explains

Every quantitative number the AI assistant states — the white-space score, density stats,
applicant concentration — is computed deterministically by `backend/scoring.js` from real data.
The model is never allowed to invent or recompute a number; it can only call
`compute_patentability` and relay what comes back verbatim. This is enforced at two levels:
the system prompt (`backend/systemPrompt.js`) instructs it explicitly, and structurally the tool
is the *only* source of those numbers in the conversation.

## Repo structure

```
.
├── index.html, styles.css, script.js, logo.png   # static prototype (deploy target for Pages)
├── data/patents.json                             # copy of the corpus, for the static prototype's real search
├── frontend/                                     # React + TypeScript + Vite app
│   ├── src/{pages,components,data,lib}
│   └── public/data/patents.json                  # the 2,799-patent corpus
└── backend/                                       # Express API
    ├── server.js            # routes + Azure OpenAI tool-calling loop
    ├── tools.js              # compute_patentability / search_prior_art tool implementations
    ├── corpus.js              # cutoff filtering, sub-technology taxonomy, density/HHI stats
    ├── scoring.js             # five-factor patentability score formula
    ├── patentability.js       # request orchestration + Stage-0 confirmation gate
    ├── features.js            # keyword-heuristic feature extraction (upload mode)
    ├── systemPrompt.js        # the agent's system instructions
    └── smoke.test.js          # `npm test`
```

## Running locally

**Static prototype** — no install needed, but must be served (not opened via `file://`) for the
patent search to work, since that fetches `data/patents.json`:
```bash
python3 -m http.server 8000   # or any static file server
```
Opening `index.html` directly still works for everything else (layout, animations, AI demo chat) —
only the patent search silently comes back empty without a server.

**Frontend**
```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
```

**Backend**
```bash
cd backend
npm install
cp .env.example .env   # fill in Azure OpenAI + (optionally) Bing Search credentials
npm run dev             # http://localhost:8080
npm test                 # run the scoring-engine test suite
```

## Deployment status

- ✅ Static prototype — ready for GitHub Pages today.
- ⏳ `frontend/` — ready to deploy once hosted (Vercel/Netlify/Azure Static Web Apps/GitHub Pages
  with a build step all work; `npm run build` → deploy `dist/`).
- ⏳ `backend/` — code-complete, but GitHub Pages cannot run it (static hosting only). Needs Azure
  App Service (or similar) once Azure credentials are approved. Once deployed, point the
  frontend's `VITE_AGENT_API_URL` (or the static prototype's `AGENT_API_URL` in `script.js`) at it.

## Compliance note

This project is entered in a track with an anonymity requirement (no institution name, logo, or
advisor name in the submitted materials). `frontend/src/components/Layout.tsx` gates a
school-name footer line behind `VITE_SHOW_SCHOOL_BRANDING` for a *separate* track that requires
it — set that env var to `false` when building for the anonymity-required track.

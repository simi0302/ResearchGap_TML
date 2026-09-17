# ResearchGap

**Patent & Literature White-Space Analysis Platform** — cross-analyzes patents and academic
literature so researchers can gauge how crowded a technology area is and spot underexplored
"white-space" opportunities before committing to a research direction or patent filing.
Pilot domain: **SDN / NFV / network slicing** (2,799 real patents).

專利與學術文獻白地分析平台，協助研究人員在投入研究或申請專利前，快速掌握技術主題的競爭密度，
找出尚未被充分探索的「白地」方向。原型以 SDN／NFV／network slicing 為驗證案例（真實母體 2,799 筆專利）。

🔗 **Live site:** https://simi0302.github.io/ResearchGap_TML/
🔗 **Live API health check:** https://researchgap-agent-api.azurewebsites.net/api/health

---

## What's actually deployed

The **root of this repo (`index.html` / `script.js` / `styles.css` / `data/`) is the real,
deployed product** — a dependency-free static site with a live AI backend behind it. There is no
separate build step and no framework: what's in `index.html` is what's live on GitHub Pages.

| Piece | What it is | Where it runs |
|---|---|---|
| **Frontend** (`/` root) | Static HTML/CSS/JS. Real client-side patent search, a real click-to-explore White-Space Matrix, and an AI Assistant chat wired to the live backend. | **GitHub Pages**, deployed from `master` / root. |
| **Backend** (`backend/`) | Express API in front of Azure OpenAI, with function/tool-calling so the model can only report numbers a deterministic backend function computed — never its own. | **Azure App Service** (Linux, Node 22-LTS, F1/free tier). |
| **Data** | A static JSON file of 2,799 real patents — see [Data, and why there's no database](#data-and-why-theres-no-database) below. | Committed to the repo, fetched by both the frontend and the backend. |
| `frontend/` (React + TypeScript + Vite) | An early scaffold from before the project pivoted to a dependency-free static site. **Not deployed, not part of the live product.** Kept for history; safe to ignore when reviewing what's actually running. | Not deployed anywhere. |

## Tech stack

**Frontend — vanilla, no framework, no build step**
- HTML5 / CSS3 (Flexbox + Grid, CSS keyframe animations, `prefers-reduced-motion`-aware) / JavaScript (ES6+)
- [pdf.js](https://mozilla.github.io/pdf.js/) (loaded from a CDN) for client-side PDF text extraction on upload — the extracted text never leaves the browser except as part of the user's own chat message
- `IntersectionObserver` for scroll-reveal animations, nav scrollspy, and an auto-drawn White-Space Matrix scroll hint on narrow viewports
- **Real client-side patent search** — `data/patents.json` (2,799 patents) is fetched once and filtered entirely in the browser. No backend round-trip, no database query.
- **Real client-side White-Space Matrix** — a 4×4 click-to-explore grid (rows/columns = the corpus's 8 most frequent IPC classification groups) computed from the same fetched JSON, with row/column labels grounded in real IPC classification scope (not algorithm-guessed words). Clicking a cell shows its real patent count and evidence.
- Requires being served over http(s) — opening `index.html` via `file://` blocks the `fetch()` of `data/patents.json` under Chrome's CORS rules (search/matrix silently return nothing; everything else still works).

**Backend — Node.js + Express, deployed on Azure App Service**
- [Azure OpenAI](https://learn.microsoft.com/azure/ai-services/openai/) (`gpt-4.1-mini`) chat completions with **function calling / tool-calling** — the model can only report a score via the `compute_patentability` tool (pure local computation, no LLM involved in the math) or search for prior art/literature via `search_prior_art`.
- `search_prior_art`'s literature search queries three independent, free, **keyless** sources in parallel — [Semantic Scholar](https://www.semanticscholar.org/product/api), [Crossref](https://api.crossref.org/), and [arXiv](https://arxiv.org/help/api/) — so real citations (including most IEEE Xplore/ACM-indexed papers, via DOI) work with zero API keys. The patents/general-web half needs an optional `BING_SEARCH_KEY`; without one it returns an honest "unavailable" note instead of fabricating results.
- `compute_patentability` auto-detects the cutoff year and technical features directly from an uploaded document's real text (deterministic keyword/regex matching against real content — not a model guess), auto-enriches its Temporal factor with a real literature search before returning, and — when asked for POS or white-space specifically — is rendered as a table deterministically by the backend rather than left to the model's own formatting.
- Node's built-in test runner (`node --test`, `backend/smoke.test.js`) — 9 tests covering the scoring engine, cutoff filtering, and anti-fabrication guarantees.

## Data, and why there's no database

There is **no SQL/NoSQL database** in this project, by design. The corpus is a single static
JSON file (`data/patents.json`, mirrored at `backend/data/patents.json` for the backend's own
copy): **2,799 real SDN/NFV/network-slicing patents**, sourced from GPSS (台灣專利檢索系統) and
public patent-office data, extracted 2026-06-03. Jurisdiction breakdown: US 1,836 · EP 690 ·
JP 135 · TW 128 · SG 7 · MY 3.

Every derived statistic — the IPC-code-driven "sub-technology" taxonomy, patent density,
applicant concentration (HHI), the White-Space Matrix's cross-tab counts — is computed
**deterministically at request time** from that flat file (see `backend/corpus.js` and the
client-side port in `script.js`), not pre-aggregated in a database and not cached. This keeps
every number reproducible and traceable back to the same source file, which matters for the
project's core anti-fabrication guarantee below.

## Architecture principle: the backend decides, the AI only explains

Every quantitative number the AI assistant states — the POS (Patentability Opportunity Score)
and its four sub-scores, patent density, applicant concentration, white-space counts — is
computed deterministically by `backend/scoring.js` / `backend/corpus.js` from the real corpus.
**The model is never allowed to invent or recompute a number**; it can only call
`compute_patentability` and relay what comes back. This is enforced at two levels: the system
prompt (`backend/systemPrompt.js`) instructs it explicitly, and structurally the tool is the
*only* source of those numbers in the conversation — verified in `backend/smoke.test.js`
("caller cannot inject a score — the field is silently ignored, backend always recomputes").

### POS formula (four factors, `backend/scoring.js`)

```
POS = 100 × (0.40·Novelty + 0.25·Crowding + 0.20·Temporal + 0.15·Regional)
```

Crowding and Regional's concentration half are always computed from the real corpus. Novelty
needs real prior-art matches (`search_prior_art`, feature-overlap judgment) and Temporal needs
real literature-year data (now auto-searched, see above) — when either genuinely isn't available,
that factor falls back to an explicit, disclosed neutral value of 0.5 rather than a guess.

## Repo structure

```
.
├── index.html, styles.css, script.js, logo.png   # the deployed static site
├── data/patents.json                             # the 2,799-patent corpus (frontend copy)
├── backend/                                       # Express API — live on Azure App Service
│   ├── server.js            # routes, Azure OpenAI tool-calling loop, per-turn table steering
│   ├── tools.js              # compute_patentability / search_prior_art tool implementations
│   ├── corpus.js              # cutoff filtering, sub-technology taxonomy, density/HHI stats
│   ├── scoring.js             # four-factor POS formula
│   ├── patentability.js       # request orchestration, auto-detection, Stage-0 confirmation gate
│   ├── features.js            # keyword-heuristic feature/cutoff-year extraction (upload mode)
│   ├── systemPrompt.js        # the agent's system instructions
│   ├── data/patents.json      # the backend's own copy of the corpus (self-contained deploy unit)
│   └── smoke.test.js          # `npm test`
└── frontend/                                       # unused React scaffold — see table above
```

## Running locally

**Static site** — no install needed, but must be served (not opened via `file://`) for search
and the White-Space Matrix to work, since both fetch `data/patents.json`:
```bash
python3 -m http.server 8000   # or any static file server
```

**Backend**
```bash
cd backend
npm install
cp .env.example .env   # fill in Azure OpenAI credentials (+ optional Bing Search key)
npm run dev             # http://localhost:8080
npm test                 # run the 9-test smoke suite
```

## Deployment

- **Frontend**: GitHub Pages, deployed from `master` / root. No build step — push to `master` and
  it's live within a minute or two.
- **Backend**: Azure App Service (`researchgap-agent-api`, resource group `ResearchGap_TML`,
  region `southeastasia`, Linux, Node 22-LTS, F1/free SKU). Deployed via `az webapp up` from the
  `backend/` folder — a self-contained deployable unit (its own copy of `data/patents.json`, no
  dependency on anything outside `backend/`). App settings (`AZURE_OPENAI_*`, `ALLOWED_ORIGIN`)
  are set via `az webapp config appsettings set`, never committed — `.env` is git-ignored.
  CORS is locked to the GitHub Pages origin, not `*`.

## Known limitations (disclosed honestly, not hidden)

- **Patent/general-web search** (Google Patents, USPTO/EPO/JPO full-text search) needs a Bing
  Search API key, which is not currently configured — the AI assistant reports this honestly
  rather than fabricating results. Academic literature search (Semantic Scholar/Crossref/arXiv)
  works fully without any key.
- **Regional factor's family-gap term** is an approximation (jurisdiction presence in the corpus,
  not true patent-family linkage — the corpus has no family ID) and is disclosed as such in the
  score's own note text, not just here.
- **Novelty factor** needs the model to actually call `search_prior_art` and judge feature overlap
  against what it finds; if it doesn't, Novelty stays at a disclosed neutral 0.5 rather than a
  fabricated number.

## Compliance note

This project is entered in a track with an anonymity requirement (no institution name, logo, or
advisor name in the submitted materials). The deployed site and this README contain none.

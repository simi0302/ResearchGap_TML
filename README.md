# ResearchGap

**Patent & Literature White-Space Analysis Platform** — cross-analyzes patents and academic
literature so researchers can gauge how crowded a technology area is and spot underexplored
"white-space" opportunities before committing to a research direction or patent filing.
Pilot domain: **SDN / NFV / network slicing** (2,799 real patents).

---

## What's actually deployed

The **root of this repo (`index.html` / `script.js` / `styles.css` / `data/`) is the real,
deployed product** — a dependency-free static site with a live AI backend behind it. There is no
separate build step and no framework: what's in `index.html` is what's live.

| Piece | What it is | Where it runs |
|---|---|---|
| **Frontend** (`/` root) | Static HTML/CSS/JS. Real client-side patent search, a real click-to-explore White-Space Matrix, and an AI Assistant chat wired to the live backend. | Static hosting (GitHub Pages). |
| **Backend** (`backend/`) | Express API in front of Azure OpenAI, with function/tool-calling so the model can only report numbers a deterministic backend function computed — never its own. | Azure App Service (Linux, Node 22-LTS). |
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
- [Azure OpenAI](https://learn.microsoft.com/azure/ai-services/openai/) (`gpt-4.1-mini`) chat completions with **function calling / tool-calling** — the model can only report a score via the `compute_patentability` tool (pure local computation, no LLM involved in the math) or search supporting academic literature via `search_prior_art`.
- **In-corpus prior-art retrieval is fully backend-side**: `retrieval.js` runs a deterministic BM25 search over the corpus (title + abstract, cutoff-filtered), and the feature-overlap between a case and each matched patent is computed by the backend's own word-boundary text matcher — never supplied or judged by the model.
- `search_prior_art`'s literature search queries three independent, free, **keyless** sources in parallel (`literature.js`) — [Semantic Scholar](https://www.semanticscholar.org/product/api), [Crossref](https://api.crossref.org/), and [arXiv](https://arxiv.org/help/api/) — so real citations (including most IEEE Xplore/ACM-indexed papers, via DOI) work with zero API keys. Real per-year publication counts (for the Temporal factor) come from [OpenAlex](https://openalex.org/), also free/keyless. `search_prior_art` also runs a real general-web/patent-office search (`webSearch.js`) via Azure OpenAI's Responses API `web_search` tool — Bing-grounded, reaching Google Patents/USPTO/EPO and general engineering sources, billed per call (~$0.014/search) on the same Azure OpenAI resource already in use, no separate resource or credential needed. This replaced the old standalone Bing Search v7 dependency, which Microsoft retired in August 2025.
- `compute_patentability` auto-detects the cutoff year (first-page copyright/publication/conference patterns, checked against citation-stripped text so a cited earlier work doesn't win) and technical features (a canonical 17-feature SDN/NFV/5G/6G/cloud-native taxonomy, matched with word-boundary + case-sensitive-acronym rules) directly from an uploaded document's real text — deterministic extraction, never a model guess — and scores in one shot whenever there's real signal to work with. Out-of-scope input (too few matched features, or a dominant classification the corpus doesn't recognize) is refused with a reason instead of returned as a diluted score.
- Node's built-in test runner (`node --test`) — 22 tests across `backend/smoke.test.js` and `backend/fixtures.test.js`, covering the scoring engine, cutoff filtering, anti-fabrication guarantees, and acceptance criteria on 7 real fixture documents (distinct topics score distinctly, a mature/well-established technique scores lower Novelty than genuinely novel work, off-domain/nonsense input is never scored, a citation-year trap still resolves to the paper's own year).

## Data, and why there's no database

There is **no SQL/NoSQL database** in this project, by design. The corpus is a single static
JSON file (`data/patents.json`, mirrored at `backend/data/patents.json` for the backend's own
copy): **2,799 real SDN/NFV/network-slicing patents**, sourced from GPSS (台灣專利檢索系統) and
public patent-office data, extracted 2026-06-03. Jurisdiction breakdown: US 1,836 · EP 690 ·
JP 135 · TW 128 · SG 7 · MY 3.

Every derived statistic — the IPC-code-driven "sub-technology" taxonomy, patent density,
applicant concentration (HHI), the White-Space Matrix's cross-tab counts, in-corpus prior-art
retrieval — is computed **deterministically at request time** from that flat file (see
`backend/corpus.js`, `backend/retrieval.js`, and the client-side port in `script.js`), not
pre-aggregated in a database and not cached. This keeps every number reproducible and traceable
back to the same source file, which matters for the project's core anti-fabrication guarantee
below.

## Architecture principle: the backend decides, the AI only explains

Every quantitative number the AI assistant states — the POS (Patentability Opportunity Score)
and its four sub-scores, patent density, applicant concentration, white-space counts — is
computed deterministically by `backend/scoring.js` / `backend/corpus.js` / `backend/retrieval.js`
from the real corpus. **The model is never allowed to invent, recompute, or supply an input to a
number**; it can only call `compute_patentability` and relay what comes back. This holds without
exception, including the prior-art feature-overlap matching that Novelty depends on, which used
to be supplied through the model and now runs entirely in the backend. This is enforced at two
levels: the system prompt (`backend/systemPrompt.js`) instructs the model explicitly, and
structurally the tool is the *only* source of those numbers in the conversation — verified by
automated tests confirming a caller-supplied score or prior-art claim is silently ignored and the
backend always recomputes from real data.

### POS formula (four factors, `backend/scoring.js`)

```
POS = 100 × (0.40·Novelty + 0.25·Crowding + 0.20·Temporal + 0.15·Regional)
```

- **Novelty** — `0.5 × (1 − max feature overlap with the top-5 in-corpus prior art)` `+`
  `0.5 × (share of case features not found in any of that prior art)`. Prior art comes from
  `retrieval.js`'s own BM25 search, never the model.
- **Crowding** — the percentile rank of (cutoff-filtered patents matching ≥2 of the case's own
  features) among the hit-counts of every pairwise combination of the known feature taxonomy —
  a feature-combination density, not a whole-IPC-group population cap.
- **Temporal** — growth of real per-year literature counts (OpenAlex) over the 5 years ending at
  the cutoff, halved if matched-set patent filings in that window already outnumber the
  literature.
- **Regional** — `0.5 × (the target jurisdiction has no matching filing in the same matched set)`
  `+` `0.5 × (1 − applicant HHI ÷ 10,000, computed over that matched set)`.

Each factor falls back to an explicit, disclosed neutral value of 0.5 only in the genuine edge
case where no real supporting data exists at all — flagged in the response, never presented as a
confident number.

## Repo structure

```
.
├── index.html, styles.css, script.js, logo.png   # the deployed static site
├── data/patents.json                             # the 2,799-patent corpus (frontend copy)
├── backend/                                       # Express API
│   ├── server.js            # routes, Azure OpenAI tool-calling loop, per-turn table steering
│   ├── tools.js              # compute_patentability / search_prior_art tool implementations
│   ├── corpus.js              # cutoff filtering, sub-technology taxonomy, density/HHI stats
│   ├── retrieval.js           # deterministic in-corpus BM25 prior-art search
│   ├── literature.js          # Semantic Scholar / Crossref / arXiv / OpenAlex, all free/keyless
│   ├── webSearch.js            # real general-web/patent-office search (Azure OpenAI Responses API)
│   ├── scoring.js             # four-factor POS formula
│   ├── patentability.js       # request orchestration, auto-detection, out-of-scope gate
│   ├── features.js            # canonical feature taxonomy, keyword/cutoff-year extraction
│   ├── systemPrompt.js        # the agent's system instructions (English default, `lang=zh` for Chinese)
│   ├── i18n.js                 # bilingual score-note/label strings
│   ├── fixtures/               # real test documents used by fixtures.test.js
│   ├── data/patents.json      # the backend's own copy of the corpus (self-contained deploy unit)
│   ├── smoke.test.js          # `npm test`
│   └── fixtures.test.js       # acceptance tests against the real fixture documents
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
cp .env.example .env   # fill in Azure OpenAI credentials
npm run dev             # http://localhost:8080
npm test                 # run the full test suite (22 tests)
```

Then point the frontend's `AGENT_API_URL` (in `script.js`) at your local backend to test the
chat widget end to end.

## Known limitations (disclosed honestly, not hidden)

- **Patent-office / Google Patents / general-web search** is real (via `search_prior_art`'s
  `webSearch.js`, Bing-grounded through Azure OpenAI's Responses API), but is informational only
  — it supports the model's prose citations and is never used to compute the Novelty score.
  The Novelty score itself always comes from the backend's own deterministic search over the
  internal 2,799-patent corpus (`retrieval.js`), never from the model's web findings. IEEE Xplore
  specifically isn't directly integrated (it requires an institutional API key with separate
  approval); Crossref surfaces many IEEE-indexed papers by DOI as a partial substitute.
- **Regional factor's family-gap term** is an approximation (jurisdiction presence in the
  matched-feature set, not true patent-family linkage — the corpus has no family ID) and is
  disclosed as such in the score's own note text, not just here.
- **Claim-level legal analysis is out of scope.** Novelty is a feature-level technical
  comparison against corpus prior art, not a claim-by-claim legal novelty or inventive-step
  judgment — that remains a patent attorney's job.

## Compliance note

This project is entered in a track with an anonymity requirement (no institution name, logo, or
advisor name in the submitted materials). This README and the deployed site contain none.

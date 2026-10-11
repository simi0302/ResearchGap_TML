// pdf.js is only needed once someone attaches a PDF, so it is loaded on demand instead of
// blocking the first paint (it was the largest render-blocking resource on mobile). The build is
// pinned by Subresource Integrity exactly as the old <script> tag was.
const PDFJS_SRC = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_SRI = "sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ==";
let pdfjsPromise = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = PDFJS_SRC;
      el.integrity = PDFJS_SRI;
      el.crossOrigin = "anonymous";
      el.referrerPolicy = "no-referrer";
      el.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        resolve(window.pdfjsLib);
      };
      el.onerror = () => {
        pdfjsPromise = null;
        reject(new Error("the PDF reader could not be loaded — check your connection and try again"));
      };
      document.head.appendChild(el);
    });
  }
  return pdfjsPromise;
}
const menuBtn = document.getElementById("menuBtn");
// scoped to the hero topbar specifically — the sticky site-nav header also has a
// ".nav", and it comes first in document order, so an unscoped ".nav" query here
// would silently toggle the wrong (hidden-on-mobile) nav instead of the hamburger's.
const nav = document.querySelector(".topbar .nav");

menuBtn.addEventListener("click", () => {
  nav.classList.toggle("open");
  menuBtn.setAttribute("aria-expanded", nav.classList.contains("open"));
});

function closeMenu() {
  nav.classList.remove("open");
  menuBtn.setAttribute("aria-expanded", "false");
}
document.querySelectorAll(".nav a").forEach(a => {
  a.addEventListener("click", closeMenu);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && nav.classList.contains("open")) {
    closeMenu();
    menuBtn.focus();
  }
});

const backToTop = document.getElementById("backToTop");
const scrollProgress = document.getElementById("scrollProgress");
const siteNav = document.getElementById("siteNav");

// Scroll effects run at most once per frame, and the page height is cached (refreshed by a
// ResizeObserver) instead of being read on every scroll event — reading scrollHeight there
// forced a synchronous layout on each event. The progress bar moves with transform only.
let docHeight = document.documentElement.scrollHeight;
let viewHeight = window.innerHeight;
new ResizeObserver(() => {
  docHeight = document.documentElement.scrollHeight;
  viewHeight = window.innerHeight;
}).observe(document.body);
let scrollQueued = false;
function onScrollFrame() {
  scrollQueued = false;
  const y = window.scrollY;
  const pastFold = y > viewHeight * 0.6;
  // hide near the very bottom so it doesn't sit on top of the footer's caption text
  const nearBottom = y + viewHeight > docHeight - 140;
  backToTop.classList.toggle("visible", pastFold && !nearBottom);
  siteNav.classList.toggle("visible", y > viewHeight * 0.7);
  const scrollable = docHeight - viewHeight;
  const k = scrollable > 0 ? Math.min(1, Math.max(0, y / scrollable)) : 0;
  scrollProgress.style.transform = `scaleX(${k})`;
}
window.addEventListener("scroll", () => {
  if (!scrollQueued) {
    scrollQueued = true;
    requestAnimationFrame(onScrollFrame);
  }
}, { passive: true });
window.addEventListener("resize", () => { viewHeight = window.innerHeight; }, { passive: true });
backToTop.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// scoped to .try-row specifically — .chat-suggestion buttons in the AI Assistant
// panel also carry the shared ".tag" class for visual styling, and a bare ".tag"
// query here would hijack their clicks into the hero search box too.
document.querySelectorAll(".try-row .tag").forEach(tag => {
  tag.addEventListener("click", () => {
    document.getElementById("keyword").value = tag.textContent.trim();
    document.getElementById("searchForm").requestSubmit();
  });
});

/* ===== Real patent corpus: fetched once, searched entirely client-side —
   no backend, no database. See data/patents.json (2,799 real SDN/NFV/network-
   slicing patents). Requires being served over http(s); opening this file
   directly (file://) blocks the fetch under Chrome's CORS rules — see README. */
let patentCorpus = null;
let corpusLoadError = null;
// Low fetch priority unless a shared link is about to search: on a slow phone connection the
// ~470 KB corpus otherwise competes with the first paint (header logo, styles) for bandwidth.
const patentCorpusPromise = fetch("data/patents.json", {
  priority: new URLSearchParams(location.search).has("q") ? "high" : "low",
})
  .then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .then(data => { patentCorpus = data; })
  .catch(err => {
    corpusLoadError = err;
    console.error("Failed to load patent corpus:", err);
  });

// Keyword matching lives in query-match.js (shared with the backend): synonyms, per-concept
// AND, word boundaries for short terms, and relevance ranking — see that file's header.
function searchCorpus({ keyword, yearStart, yearEnd, jurisdiction, patentType }) {
  if (!patentCorpus || !patentType) return [];
  const concepts = keyword.trim() ? QueryMatch.parseQuery(keyword) : [];
  const scores = new Map();
  const startY = yearStart ? parseInt(yearStart, 10) : null;
  const endY = yearEnd ? parseInt(yearEnd, 10) : null;
  return patentCorpus
    .filter(p => {
      if (jurisdiction !== "All" && p.jurisdiction !== jurisdiction) return false;
      if (startY || endY) {
        if (!p.publication_date) return false;
        const y = parseInt(p.publication_date.slice(0, 4), 10);
        if (startY && y < startY) return false;
        if (endY && y > endY) return false;
      }
      if (concepts.length) {
        const score = QueryMatch.scorePatent(concepts, p, keyword);
        if (!score) return false;
        scores.set(p, score);
      }
      return true;
    })
    .sort((a, b) =>
      (scores.get(b) || 0) - (scores.get(a) || 0) ||
      (b.publication_date || "").localeCompare(a.publication_date || ""));
}

/* ===== Search extras: how the query was understood, AI-suggested related terms, and live
   academic papers. Each async response checks searchToken so a slow reply from an older
   search never overwrites a newer one. */
const SEARCH_API_BASE = "https://researchgap-agent-api.azurewebsites.net";
let searchToken = 0;

function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  options?.signal?.addEventListener("abort", () => ctrl.abort());
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function resetSearchExtras() {
  document.getElementById("queryInterpretation").hidden = true;
  document.getElementById("aiSuggest").hidden = true;
  document.getElementById("paperResults").hidden = true;
  document.getElementById("landscapePanel").hidden = true;
  document.getElementById("patentBlock").hidden = false;
}

function renderQueryInterpretation(keyword, results) {
  const el = document.getElementById("queryInterpretation");
  const concepts = keyword ? QueryMatch.parseQuery(keyword) : [];
  if (!concepts.length) { el.hidden = true; return; }
  const parts = concepts.map((c) => {
    const extra = c.fromDictionary ? c.variants.filter((v) => v !== QueryMatch.normalize(c.label)) : [];
    const syn = extra.length
      ? ` <span class="qi-syn">+ ${extra.slice(0, 2).map(escapeHtml).join(", ")}${extra.length > 2 ? ` +${extra.length - 2}` : ""}</span>`
      : "";
    return `<span class="qi-term">${escapeHtml(c.label)}${syn}</span>`;
  });
  const viaSynonyms = results.filter((p) => !QueryMatch.literalMatch(p, keyword)).length;
  el.innerHTML = `<span class="qi-label">Searched as <span class="zh">搜尋條件</span></span>
    ${parts.join(' <span class="qi-and">AND</span> ')}
    ${viaSynonyms ? `<span class="qi-gain">${viaSynonyms.toLocaleString()} found only via synonyms <span class="zh">筆僅靠同義詞找到</span></span>` : ""}`;
  el.hidden = false;
}

async function loadAiSuggestions(keyword, token) {
  const el = document.getElementById("aiSuggest");
  el.hidden = false;
  el.innerHTML = `<p class="ai-suggest__head"><span class="ai-badge">AI</span> Finding related terms… <span class="zh">AI 正在找相關詞…</span></p>`;
  try {
    const res = await fetchWithTimeout(`${SEARCH_API_BASE}/api/expand-query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: keyword }),
    }, 30000);
    if (token !== searchToken) return;
    if (!res.ok) { el.hidden = true; return; }
    const data = await res.json();
    if (token !== searchToken) return;
    const terms = Array.isArray(data.terms) ? data.terms : [];
    if (!terms.length) {
      el.innerHTML = `<p class="ai-suggest__head"><span class="ai-badge">AI</span> No AI-suggested term matched the corpus. <span class="zh">AI 提出的相關詞在語料庫中皆查無結果。</span></p>`;
      return;
    }
    const proposed = Number(data.proposed) || terms.length;
    el.innerHTML = `
      <p class="ai-suggest__head"><span class="ai-badge">AI</span> Related terms <span class="zh">相關詞</span></p>
      <div class="ai-suggest__chips">${terms.map((t) =>
        `<button type="button" class="ai-chip" data-term="${escapeHtml(String(t.term))}">${escapeHtml(String(t.term))} <span class="ai-chip__count">${Number(t.count).toLocaleString()}</span></button>`
      ).join("")}</div>
      <p class="ai-suggest__note">AI suggested ${proposed} terms; after removing synonyms of each other and terms with no match in the ${Number(data.corpus_size || 2799).toLocaleString()}-patent corpus, the backend kept ${terms.length} (number = matching patents).
        <span class="zh">AI 提出 ${proposed} 個詞，後端去除彼此同義與語料庫查無結果的詞後保留 ${terms.length} 個（數字＝符合的專利數）。</span></p>`;
  } catch {
    if (token === searchToken) el.hidden = true;
  }
}

document.getElementById("aiSuggest").addEventListener("click", (e) => {
  const chip = e.target.closest(".ai-chip");
  if (!chip) return;
  document.getElementById("keyword").value = chip.dataset.term;
  document.getElementById("searchForm").requestSubmit();
});

async function loadPaperResults(keyword, { start, end }, token) {
  const el = document.getElementById("paperResults");
  const query = QueryMatch.englishQuery(QueryMatch.parseQuery(keyword)) || keyword;
  el.hidden = false;
  const head = `<div class="results-head">
      <h4>Academic papers <span class="zh">學術文獻</span></h4>
      <span class="paper-source">Knowledge base + live · Semantic Scholar, Crossref, arXiv</span>
    </div>`;
  const countryNote = document.getElementById("country").value !== "All"
    ? `<p class="paper-note">The country filter applies to patents only. <span class="zh">國家條件僅適用於專利。</span></p>` : "";
  el.innerHTML = `${head}${countryNote}<div class="results-loading">Searching the knowledge base and paper databases for “${escapeHtml(query)}” — about 10–15 s… <span class="zh">查詢論文資料庫中，約需 10–15 秒…</span></div>`;
  const unavailable = (extra) => `<div class="results-empty">Paper search is unavailable right now${extra || ""}.
      <br><small>論文搜尋暫時無法使用。</small></div>`;
  try {
    const res = await fetchWithTimeout(`${SEARCH_API_BASE}/api/literature`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, year_start: start || undefined, year_end: end || undefined }),
    }, 45000);
    if (token !== searchToken) return;
    const data = res.ok ? await res.json() : null;
    if (token !== searchToken) return;
    const papers = Array.isArray(data?.papers) ? data.papers : null;
    let body;
    if (!papers) {
      body = unavailable(res.status === 429 ? " (too many requests — wait a minute)" : "");
    } else if (!papers.length) {
      body = `<div class="results-empty">No papers found for “${escapeHtml(query)}” in this year range.
        <br><small>此年份範圍內查無相關論文。</small></div>`;
    } else {
      const kb = data.knowledge_base;
      const fromKb = papers.filter((p) => p.from === "knowledge_base").length;
      const kbNote = kb
        ? `<p class="paper-note kb-note"><span class="kb-dot" aria-hidden="true"></span><span>${fromKb} from the knowledge base · ${papers.length - fromKb} live${kb.added ? ` · <strong>${kb.added} new</strong> saved to the knowledge base (now ${Number(kb.kb_total).toLocaleString()} records)` : ""}.
            <span class="zh">知識庫 ${fromKb} 筆・即時 ${papers.length - fromKb} 筆${kb.added ? `・本次新增 <strong>${kb.added}</strong> 筆寫回知識庫（共 ${Number(kb.kb_total).toLocaleString()} 筆）` : ""}。</span></span></p>`
        : "";
      if (kb?.added) loadKnowledgeStats();
      const PAPERS_SHOWN = 6;
      const paperHighlight = highlightRegexFor(keyword);
      body = `${kbNote}<div class="results-list paper-list${papers.length > PAPERS_SHOWN ? " is-collapsed" : ""}">${papers.map((p) => `
        <article class="result-card paper-card">
          <div class="result-head"><span class="result-jurisdiction">${escapeHtml(p.source || "Paper")}</span>${p.from === "knowledge_base" ? `<span class="kb-tag">Knowledge base <span class="zh">知識庫</span></span>` : ""}<span>${p.year ? escapeHtml(String(p.year)) : "year unknown"}</span></div>
          <h5>${highlightText(p.title || "(untitled)", paperHighlight)}</h5>
          ${p.venue ? `<p class="result-meta">${escapeHtml(p.venue)}</p>` : ""}
          ${p.url ? `<a class="result-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">View paper <span aria-hidden="true">↗</span></a>` : ""}
        </article>`).join("")}</div>${papers.length > PAPERS_SHOWN ? `<button type="button" class="page-btn paper-more">Show all ${papers.length} papers <span class="zh">顯示全部 ${papers.length} 篇</span></button>` : ""}`;
    }
    el.innerHTML = `${head}${countryNote}${body}`;
    el.querySelector(".paper-more")?.addEventListener("click", (ev) => {
      el.querySelector(".paper-list").classList.remove("is-collapsed");
      ev.currentTarget.remove();
    });
  } catch {
    if (token === searchToken) el.innerHTML = `${head}${countryNote}${unavailable()}`;
  }
}

/* ===== Topic landscape: the same deterministic numbers the assistant's topic_landscape tool
   uses (POST /api/landscape) — corpus patents vs knowledge-base papers per year, applicant
   concentration, and the research-to-patent ratio. */
function fmtPct(v) {
  return v == null ? "—" : `${v > 0 ? "+" : ""}${v}%`;
}
function landscapeBars(patentsByYear, papersByYear) {
  const years = Object.keys(patentsByYear);
  const maxP = Math.max(1, ...years.map((y) => patentsByYear[y]));
  const maxR = Math.max(1, ...years.map((y) => papersByYear[y] || 0));
  return `<div class="ls-bars" role="img" aria-label="Patents and papers per year">${years.map((y) => `
    <div class="ls-col" title="${y}: ${patentsByYear[y]} patents, ${papersByYear[y] || 0} papers">
      <div class="ls-pair">
        <i class="ls-bar ls-bar--patent" style="height:${Math.round((patentsByYear[y] / maxP) * 100)}%"></i>
        <i class="ls-bar ls-bar--paper" style="height:${Math.round(((papersByYear[y] || 0) / maxR) * 100)}%"></i>
      </div>
      <span>${String(y).slice(2)}</span>
    </div>`).join("")}</div>`;
}
async function loadLandscape(keyword, { end }, token) {
  const el = document.getElementById("landscapePanel");
  el.hidden = true;
  try {
    // One retry: a backend waking from idle can drop or stall the first request.
    const request = () => fetchWithTimeout(`${SEARCH_API_BASE}/api/landscape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: keyword, cutoff_year: end ? Number(end) : undefined }),
    }, 20000);
    let res = await request().catch(() => null);
    if (token !== searchToken) return;
    if (!res || res.status >= 500) res = await request();
    if (token !== searchToken || !res.ok) return;
    const d = await res.json();
    if (token !== searchToken || !d.patents) return;
    const top = d.patents.top_applicants?.[0];
    const ratio = d.research_to_patent_ratio_last5;
    el.innerHTML = `
      <div class="ls-head">
        <h4>Topic landscape <span class="zh">主題全景</span></h4>
        <button type="button" class="pill-btn small ls-ask" data-q="${escapeHtml(`Is ${keyword} a crowded area? Who is patenting it?`)}">Ask the AI about this <span class="zh">問 AI</span> →</button>
      </div>
      <div class="ls-grid">
        <div class="ls-stat"><strong>${d.patents.matched.toLocaleString()}</strong><span>corpus patents <span class="zh">語料庫專利</span></span><small>${d.patents.share_of_corpus_pct}% of N=2,799 · 5-yr ${fmtPct(d.patents.growth_last5_vs_prev5_pct)}</small></div>
        <div class="ls-stat"><strong>${d.papers.matched.toLocaleString()}</strong><span>knowledge-base papers <span class="zh">知識庫論文</span></span><small>5-yr ${fmtPct(d.papers.growth_last5_vs_prev5_pct)}</small></div>
        <div class="ls-stat"><strong>${ratio == null ? "—" : ratio}</strong><span>papers per patent, last 5 yrs <span class="zh">近五年論文／專利比</span></span><small>${ratio == null ? "no patents in this window" : ratio >= 5 ? "research ahead of filings" : "filings keep pace"}</small></div>
        <div class="ls-stat"><strong>${d.patents.applicant_hhi ?? "—"}</strong><span>applicant HHI <span class="zh">申請人集中度</span></span><small>${top ? `${escapeHtml(d.patents.applicant_concentration)} · top: ${escapeHtml(top.name)} ${top.share_pct}%` : "no applicants"}</small></div>
      </div>
      ${landscapeBars(d.patents.by_year, d.papers.by_year)}
      <p class="ls-legend"><i class="ls-key ls-bar--patent"></i>Patents per year <span class="zh">每年專利</span> <i class="ls-key ls-bar--paper"></i>Papers per year <span class="zh">每年論文</span> <span class="ls-scale">(each scaled to its own maximum <span class="zh">各自以最大值為基準</span>)</span></p>
      <p class="ls-src">Computed by the backend — the same numbers the AI assistant cites. <span class="zh">由後端計算，與 AI 助手引用的數字相同。</span></p>`;
    el.hidden = false;
  } catch {
    if (token === searchToken) el.hidden = true;
  }
}

/* ===== Knowledge base size (RAG write-back), shown on the dashboard and in the chat greeting. */
async function loadKnowledgeStats() {
  try {
    const res = await fetchWithTimeout(`${SEARCH_API_BASE}/api/knowledge/stats`, {}, 15000);
    if (!res.ok) return;
    const st = await res.json();
    if (!st.total) return;
    const pill = document.getElementById("kbPill");
    const learned = st.learned || 0;
    const papers = (st.by_type?.paper || 0).toLocaleString();
    const patents = (st.by_type?.patent || 0).toLocaleString();
    pill.innerHTML = `<span class="kb-dot" aria-hidden="true"></span><span><strong>Knowledge base: ${st.total.toLocaleString()} records</strong> — ${papers} papers, ${patents} verified patents; ${learned.toLocaleString()} saved back from live searches${st.last_learned_at ? `, latest ${new Date(st.last_learned_at).toLocaleDateString()}` : ""}.
      <span class="zh">知識庫共 ${st.total.toLocaleString()} 筆（論文 ${papers}、驗證專利 ${patents}），其中 ${learned.toLocaleString()} 筆由即時搜尋寫回，每次搜尋都會持續累積。</span></span>`;
    pill.hidden = false;
    const n = st.total.toLocaleString();
    const c = document.getElementById("kbChatCount");
    const cz = document.getElementById("kbChatCountZh");
    if (c) c.textContent = n;
    if (cz) cz.textContent = n;
  } catch {
    // stats are informational; the page works without them
  }
}
loadKnowledgeStats();


const googlePatentsUrl = (publicationNumber) =>
  `https://patents.google.com/patent/${encodeURIComponent(publicationNumber)}/en`;


// Primary IPC main group, with its curated scope label when known (WS_IPC_LABELS below),
// e.g. "Network Management (IPC H04L 41)"; otherwise just the code.
function ipcLabelForPatent(p) {
  const group = wsPrimaryGroup(p);
  if (!group) return "IPC unknown";
  return WS_IPC_LABELS[group] ? `${WS_IPC_LABELS[group]} (IPC ${group})` : `IPC ${group}`;
}

const RESULTS_PAGE_SIZE = 5;
let currentResults = [];
let currentHighlight = null; // RegExp for the current query's terms (all synonyms), or null

// One regex for every variant of every concept in the query, mirroring the matcher's rules:
// "-", "_", "/" and spaces are interchangeable; short ASCII terms need word boundaries;
// longer typed words match as prefixes ("orchestr" → "orchestration").
function highlightRegexFor(keyword) {
  const concepts = keyword ? QueryMatch.parseQuery(keyword) : [];
  const parts = [];
  for (const c of concepts) {
    for (const v of c.variants) {
      if (!v) continue;
      const body = v.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\-_/]+");
      const ascii = /^[\x00-\x7f]+$/.test(v);
      if (ascii && v.length <= 3) parts.push(`\\b${body}\\b`);
      else if (ascii && !c.fromDictionary) parts.push(`\\b${body}[\\w-]*`);
      else if (ascii) parts.push(`\\b${body}(?:s|es)?\\b`); // dictionary phrase: whole words, plural included
      else parts.push(body);
    }
  }
  if (!parts.length) return null;
  parts.sort((a, b) => b.length - a.length); // longest first, so "network slicing" beats "network"
  return new RegExp(`(${parts.join("|")})`, "gi");
}

// Escape, then wrap matches in <mark> (the text is never interpreted as HTML).
function highlightText(text, re) {
  const s = String(text || "");
  if (!re) return escapeHtml(s);
  let out = "";
  let last = 0;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s))) {
    if (!m[0]) { re.lastIndex++; continue; }
    out += escapeHtml(s.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(s.slice(last));
}

// ~220 characters of the abstract around the first matched term (or its start).
function abstractSnippet(abstract, re) {
  const s = String(abstract || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  let idx = 0;
  if (re) {
    re.lastIndex = 0;
    const m = re.exec(s);
    if (m) idx = m.index;
  }
  let start = Math.max(0, idx - 80);
  if (start > 0) start = s.indexOf(" ", start) + 1 || start;
  let end = Math.min(s.length, start + 220);
  if (end < s.length) end = s.lastIndexOf(" ", end) > start ? s.lastIndexOf(" ", end) : end;
  return `${start > 0 ? "… " : ""}${highlightText(s.slice(start, end), re)}${end < s.length ? " …" : ""}`;
}
let relevanceResults = [];
let currentKeyword = "";
let currentPage = 1;

function renderResultCards(pageResults) {
  return pageResults.map(p => {
    const applicant = p.company_name || (p.assignees && p.assignees[0]) || "Unknown applicant";
    return `
      <article class="result-card">
        <div class="result-head">
          <span class="result-jurisdiction">${escapeHtml(p.jurisdiction || "—")}</span>
          <span>${escapeHtml(p.publication_date || "date unknown")}</span>
        </div>
        <h5>${highlightText(p.title || "(untitled)", currentHighlight)}</h5>
        <p class="result-meta">${escapeHtml(applicant)} · ${escapeHtml(ipcLabelForPatent(p))}</p>
        ${p.abstract ? `<p class="result-snippet">${abstractSnippet(p.abstract, currentHighlight)}</p>` : ""}
        <a class="result-link" href="${googlePatentsUrl(p.publication_number)}" target="_blank" rel="noopener noreferrer">
          View on Google Patents <span aria-hidden="true">↗</span>
        </a>
      </article>
    `;
  }).join("");
}

function renderResultsPage() {
  const countEl = document.getElementById("resultsCount");
  const list = document.getElementById("resultsList");
  const pagination = document.getElementById("resultsPagination");
  const pageInfo = document.getElementById("resultsPageInfo");
  const prevBtn = document.getElementById("resultsPrev");
  const nextBtn = document.getElementById("resultsNext");

  const totalPages = Math.max(1, Math.ceil(currentResults.length / RESULTS_PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);

  const start = (currentPage - 1) * RESULTS_PAGE_SIZE;
  const pageResults = currentResults.slice(start, start + RESULTS_PAGE_SIZE);

  countEl.textContent = `${currentResults.length.toLocaleString()} result${currentResults.length === 1 ? "" : "s"}`;
  list.innerHTML = renderResultCards(pageResults);

  if (currentResults.length > RESULTS_PAGE_SIZE) {
    pagination.hidden = false;
    pageInfo.textContent = `Page ${currentPage} / ${totalPages} · 第 ${currentPage} / ${totalPages} 頁`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
  } else {
    pagination.hidden = true;
  }
}

// Sorting only reorders the same matches; "relevance" is the matcher's own ranking.
document.getElementById("resultsSort").addEventListener("change", (e) => {
  const mode = e.target.value;
  const byDate = (a, b) => (a.publication_date || "").localeCompare(b.publication_date || "");
  currentResults = mode === "newest" ? [...relevanceResults].sort((a, b) => byDate(b, a))
    : mode === "oldest" ? [...relevanceResults].sort(byDate)
    : relevanceResults;
  currentPage = 1;
  renderResultsPage();
});

// CSV of the current patent results (in the current sort order), with a UTF-8 BOM so Excel
// opens Chinese text correctly. Built from the same data the cards show — nothing extra.
document.getElementById("resultsExport").addEventListener("click", () => {
  if (!currentResults.length) return;
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["publication_number", "title", "jurisdiction", "publication_date", "applicant", "primary_ipc", "url"]];
  for (const p of currentResults) {
    rows.push([p.publication_number, p.title, p.jurisdiction, p.publication_date, p.company_name || (p.assignees || [])[0] || "", (p.ipc || [])[0] || "", googlePatentsUrl(p.publication_number)]);
  }
  const blob = new Blob(["\ufeff" + rows.map((r) => r.map(cell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const slug = (currentKeyword || "all").replace(/[^\p{L}\p{N}]+/gu, "_").slice(0, 40);
  a.download = `researchgap_patents_${slug}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

document.getElementById("resultsPrev").addEventListener("click", () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  renderResultsPage();
  document.getElementById("resultsWrap").scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
});
document.getElementById("resultsNext").addEventListener("click", () => {
  currentPage += 1;
  renderResultsPage();
  document.getElementById("resultsWrap").scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
});

function renderResults(results, keyword) {
  const heading = document.getElementById("resultsHeading");
  const countEl = document.getElementById("resultsCount");
  const list = document.getElementById("resultsList");
  const pagination = document.getElementById("resultsPagination");

  heading.textContent = keyword ? `Results for "${keyword}"` : "All patents in the corpus";
  relevanceResults = results;
  currentKeyword = keyword;
  currentHighlight = highlightRegexFor(keyword);
  document.getElementById("resultsSort").value = "relevance";
  currentResults = results;
  currentPage = 1;

  if (corpusLoadError) {
    countEl.textContent = "";
    pagination.hidden = true;
    list.innerHTML = `<div class="results-empty">
      Could not load the patent corpus (${escapeHtml(corpusLoadError.message)}).
      If you opened this file directly from disk, the browser blocks that fetch — serve it from a
      local server instead, e.g. <code>python3 -m http.server</code>, then open the printed
      localhost URL. See README.
      <br><small>無法載入專利語料庫。若你是直接用瀏覽器開啟本機檔案，請改用本地伺服器（例如
      <code>python3 -m http.server</code>）開啟印出的 localhost 網址，詳見 README。</small>
    </div>`;
    return;
  }

  if (!results.length) {
    countEl.textContent = "";
    pagination.hidden = true;
    const shown = keyword ? `“${escapeHtml(keyword)}”` : "these filters";
    const concepts = keyword ? QueryMatch.parseQuery(keyword) : [];
    let breakdown = "";
    if (concepts.length >= 2 && patentCorpus) {
      const filters = {
        yearStart: document.getElementById("yearStart").value,
        yearEnd: document.getElementById("yearEnd").value,
        jurisdiction: document.getElementById("country").value,
        patentType: true,
      };
      const items = concepts.map((c) => ({ term: c.label, n: searchCorpus({ ...filters, keyword: c.label }).length }));
      breakdown = `<div class="zero-breakdown">
        <p>Every concept must appear in the same patent. Each one on its own, with the same filters:
          <span class="zh">所有概念必須同時出現在同一件專利。各概念單獨搜尋（相同條件）：</span></p>
        <div class="ai-suggest__chips">${items.map((it) => `<button type="button" class="ai-chip zero-chip" data-term="${escapeHtml(it.term)}"${it.n ? "" : " disabled"}>${escapeHtml(it.term)} <span class="ai-chip__count">${it.n.toLocaleString()}</span></button>`).join("")}</div>
      </div>`;
    }
    list.innerHTML = `<div class="results-empty">
      No patents match ${shown}. Check the spelling, try a broader keyword, or relax the year and country filters.
      <br><small>找不到符合的專利。請檢查拼字、改用較廣的關鍵字，或放寬年份與國家條件。</small>
      <br><small>If ${keyword ? "this is a real technology term" : "your filters are intentional"}, having no matches can itself be a white-space signal worth validating.
      若這是真實的技術用語，「查無結果」本身也可能是值得驗證的白地訊號。</small>
    </div>${breakdown}`;
    list.querySelectorAll(".zero-chip").forEach((btn) => btn.addEventListener("click", () => {
      document.getElementById("keyword").value = btn.dataset.term;
      document.getElementById("searchForm").requestSubmit();
    }));
    return;
  }

  renderResultsPage();
}

/* ===== Motion: scroll-reveal, count-up, nav scrollspy ===== */
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!prefersReducedMotion) {
  const revealTargets = document.querySelectorAll(
    ".section-head, .gap-card, .about-lead, .about-card"
  );
  revealTargets.forEach((el, i) => {
    el.classList.add("reveal");
    // small stagger for elements that arrive together in a grid/row
    el.style.transitionDelay = `${Math.min(i % 5, 4) * 70}ms`;
  });

  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });

  revealTargets.forEach(el => revealObserver.observe(el));
} else {
  document.querySelectorAll(".reveal, .reveal-scale").forEach(el => el.classList.add("is-visible"));
}

// nav scrollspy: highlight the section currently in view
const navLinks = [...document.querySelectorAll(".nav a[href^='#']")];
const spySections = navLinks
  .map(a => document.querySelector(a.getAttribute("href")))
  .filter(Boolean);

if (spySections.length) {
  const spyObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const id = `#${entry.target.id}`;
      navLinks.forEach(a => a.classList.toggle("active", a.getAttribute("href") === id));
    });
  }, { rootMargin: "-45% 0px -50% 0px", threshold: 0 });
  spySections.forEach(sec => spyObserver.observe(sec));
}

const canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

if (!prefersReducedMotion) {
  // subtle hero-orb mouse parallax (desktop pointer only)
  const orbField = document.getElementById("orbField");
  const heroSection = document.querySelector(".hero");
  if (orbField && heroSection && canHover) {
    heroSection.addEventListener("mousemove", (e) => {
      const x = (e.clientX / window.innerWidth - 0.5) * 26;
      const y = (e.clientY / window.innerHeight - 0.5) * 26;
      orbField.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    });
    heroSection.addEventListener("mouseleave", () => {
      orbField.style.transform = "translate(0, 0)";
    });
  }

  // 3D tilt on the featured gap card (desktop pointer only)
  const featuredCard = document.querySelector(".gap-card.featured");
  if (featuredCard && canHover) {
    const maxDeg = 5;
    featuredCard.addEventListener("mousemove", (e) => {
      const rect = featuredCard.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width - 0.5;
      const py = (e.clientY - rect.top) / rect.height - 0.5;
      featuredCard.style.transform =
        `perspective(800px) rotateX(${(-py * maxDeg).toFixed(2)}deg) rotateY(${(px * maxDeg).toFixed(2)}deg)`;
      featuredCard.classList.add("tilt-active");
    });
    featuredCard.addEventListener("mouseleave", () => {
      featuredCard.style.transform = "perspective(800px) rotateX(0) rotateY(0)";
      featuredCard.classList.remove("tilt-active");
    });
  }

  // ripple micro-interaction on primary action buttons
  function attachRipple(el) {
    el.classList.add("ripple-btn");
    el.addEventListener("click", (e) => {
      const rect = el.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const span = document.createElement("span");
      span.className = "ripple";
      span.style.width = span.style.height = `${size}px`;
      span.style.left = `${e.clientX - rect.left - size / 2}px`;
      span.style.top = `${e.clientY - rect.top - size / 2}px`;
      el.appendChild(span);
      span.addEventListener("animationend", () => span.remove());
    });
  }
  document.querySelectorAll(".pill-btn, .searchbar button, .chat-input button, .ncu-link")
    .forEach(attachRipple);
}

function popValue(el) {
  el.classList.remove("pop");
  // eslint-disable-next-line no-unused-expressions
  void el.offsetWidth; // restart animation
  el.classList.add("pop");
}

// The filters sit in a collapsed <details> panel; its summary line always shows the
// current filter values so nothing is hidden from the user while it's closed.
function updateFilterState() {
  const start = document.getElementById("yearStart").value;
  const end = document.getElementById("yearEnd").value;
  const country = document.getElementById("country");
  const types = [
    document.getElementById("patent").checked && "Patent",
    document.getElementById("paper").checked && "Paper",
  ].filter(Boolean).join(" + ") || "No type";
  const years = start && end ? `${start}–${end}` : start ? `From ${start}` : end ? `Until ${end}` : "All years";
  const place = country.value === "All" ? "All countries" : country.options[country.selectedIndex].text.split(" / ")[0];
  document.getElementById("filterState").textContent = `${years} · ${place} · ${types}`;
}
["yearStart", "yearEnd", "country", "patent", "paper"].forEach((id) => {
  const el = document.getElementById(id);
  el.addEventListener("input", updateFilterState);
  el.addEventListener("change", updateFilterState);
});
updateFilterState();

document.querySelectorAll(".quick-topic").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.getElementById("keyword").value = btn.dataset.q;
    document.getElementById("searchForm").requestSubmit();
  });
});

// Shareable searches: the query and filters live in the URL (?q=…&from=…&to=…&country=…&types=…),
// so a search can be bookmarked or sent as a link, and back/forward replays it.
function searchStateFromForm() {
  return {
    q: document.getElementById("keyword").value.trim(),
    from: document.getElementById("yearStart").value,
    to: document.getElementById("yearEnd").value,
    country: document.getElementById("country").value,
    types: [document.getElementById("patent").checked && "patent", document.getElementById("paper").checked && "paper"].filter(Boolean).join(","),
  };
}
function applySearchState(st) {
  document.getElementById("keyword").value = st.q || "";
  document.getElementById("yearStart").value = st.from || "";
  document.getElementById("yearEnd").value = st.to || "";
  const country = document.getElementById("country");
  country.value = [...country.options].some((o) => o.value === st.country) ? st.country : "All";
  const types = (st.types || "patent,paper").split(",");
  document.getElementById("patent").checked = types.includes("patent");
  document.getElementById("paper").checked = types.includes("paper");
  updateFilterState();
}
function urlForSearch(st) {
  const params = new URLSearchParams();
  if (st.q) params.set("q", st.q);
  if (st.from) params.set("from", st.from);
  if (st.to) params.set("to", st.to);
  if (st.country && st.country !== "All") params.set("country", st.country);
  if (st.types && st.types !== "patent,paper") params.set("types", st.types);
  const qs = params.toString();
  return `${location.pathname}${qs ? `?${qs}` : ""}#overview`;
}
let replayingHistory = false;
window.addEventListener("popstate", () => {
  const params = new URLSearchParams(location.search);
  if (!params.has("q")) return;
  replayingHistory = true;
  applySearchState(Object.fromEntries(params));
  document.getElementById("searchForm").requestSubmit();
});

document.getElementById("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  document.getElementById("quickStart").hidden = true;
  if (!replayingHistory) {
    const next = urlForSearch(searchStateFromForm());
    if (next !== `${location.pathname}${location.search}${location.hash}`) history.pushState(null, "", next);
  }
  replayingHistory = false;

  const keywordInput = document.getElementById("keyword").value.trim();
  const start = document.getElementById("yearStart").value;
  const end = document.getElementById("yearEnd").value;
  const jurisdiction = document.getElementById("country").value;
  const patent = document.getElementById("patent").checked;
  const paper = document.getElementById("paper").checked;

  const types = [patent && "Patent", paper && "Academic Paper"].filter(Boolean).join(" + ") || "No type selected";

  document.getElementById("overview").scrollIntoView({behavior:"smooth"});

  const resultsWrap = document.getElementById("resultsWrap");
  resultsWrap.hidden = false;
  const token = ++searchToken;
  resetSearchExtras();

  // A reversed range can never match anything, so say that instead of implying a white space.
  if (start && end && Number(start) > Number(end)) {
    document.getElementById("filterPanel").open = true;
    document.getElementById("resultsHeading").textContent = "Check the year range";
    document.getElementById("resultsCount").textContent = "";
    document.getElementById("resultsPagination").hidden = true;
    document.getElementById("resultsList").innerHTML = `<div class="results-empty">
      The start year (${escapeHtml(start)}) is later than the end year (${escapeHtml(end)}). Swap them, or clear one of the two fields.
      <br><small>起始年份（${escapeHtml(start)}）晚於結束年份（${escapeHtml(end)}）。請對調，或清空其中一個欄位。</small>
    </div>`;
    document.getElementById("analysisSummary").textContent = "Enter a valid year range to search. 請輸入有效的年份範圍。";
    return;
  }
  if (!patent && !paper) {
    document.getElementById("filterPanel").open = true;
    document.getElementById("resultsHeading").textContent = "Choose a type";
    document.getElementById("resultsCount").textContent = "";
    document.getElementById("resultsPagination").hidden = true;
    document.getElementById("resultsList").innerHTML = `<div class="results-empty">
      Select at least one type (Patent or Academic Paper) to search.
      <br><small>請至少勾選一種類型（專利或學術文獻）。</small>
    </div>`;
    return;
  }
  document.getElementById("resultsList").innerHTML =
    `<div class="results-loading">Searching the 2,799-patent corpus… <span class="zh">搜尋 2,799 筆專利語料庫中…</span></div>`;

  await patentCorpusPromise;
  if (token !== searchToken) return;
  const results = searchCorpus({ keyword: keywordInput, yearStart: start, yearEnd: end, jurisdiction, patentType: patent });
  if (patent) {
    renderResults(results, keywordInput);
    if (!corpusLoadError) renderQueryInterpretation(keywordInput, results);
  } else {
    document.getElementById("patentBlock").hidden = true;
  }
  if (keywordInput) {
    loadLandscape(keywordInput, { end }, token);
    loadAiSuggestions(keywordInput, token);
    if (paper) loadPaperResults(keywordInput, { start, end }, token);
  } else if (paper && !patent) {
    const el = document.getElementById("paperResults");
    el.hidden = false;
    el.innerHTML = `<div class="results-empty">Enter a keyword to search academic papers.
      <br><small>請輸入關鍵字以搜尋學術文獻。</small></div>`;
  }

  document.getElementById("analysisSummary").textContent =
    `${keywordInput || "All patents"} · ${start || "All"}—${end || "2026"} · ${jurisdiction} · ${types}`;
});

/*
 * White-Space table: driven entirely by a real compute_patentability result (case_id,
 * subtech_label, combination_whitespace[]) that arrives via /api/chat's tool_calls once the
 * AI Assistant finishes analyzing a paper/patent draft — see the chatForm submit handler,
 * which calls renderWhiteSpaceFromAnalysis() whenever a completed (non-needs_confirmation)
 * compute_patentability result shows up. Nothing here is a fixed example.
 */
const STATUS_LABEL = {
  gap: { en: "Potential White Space", zh: "潛在白地" },
  developing: { en: "Developing", zh: "發展中" },
  crowded: { en: "Crowded", zh: "高密度" },
};
let realCombinationRows = new Map();

// Shared row-rendering used by both the default corpus-wide table and a real
// AI-analyzed case (renderWhiteSpaceFromAnalysis) — same row shape either way:
// combo_a, combo_b, ipc_a, ipc_b, count, status, evidence_en, evidence_zh.
// Both tables inside .matrix-wrap (the default matrix and the AI-case list) have a
// min-width wider than the card on narrow viewports, so the wrap scrolls horizontally
// (see .matrix-wrap{overflow:auto} in styles.css) — this only shows a hint when that's
// actually true right now, not a static "this might scroll" guess.
function updateMatrixScrollHint() {
  const wrap = document.getElementById("matrixWrap");
  const hint = document.getElementById("matrixScrollHint");
  if (!wrap || !hint) return;
  hint.hidden = wrap.scrollWidth <= wrap.clientWidth + 1;
}
window.addEventListener("resize", () => {
  clearTimeout(window._matrixScrollHintTimer);
  window._matrixScrollHintTimer = setTimeout(updateMatrixScrollHint, 150);
});

function renderComboRows(rows) {
  document.getElementById("whiteSpaceEmpty").hidden = true;
  document.getElementById("whiteSpaceTable").hidden = false;
  document.getElementById("whiteSpaceLegend").hidden = false;
  document.getElementById("whiteSpaceGapCards").hidden = false;

  realCombinationRows = new Map();
  const tbody = document.getElementById("whiteSpaceTbody");
  tbody.innerHTML = rows.map((row, i) => {
    const rowId = `row-${i}`;
    realCombinationRows.set(rowId, row);
    const label = STATUS_LABEL[row.status] || STATUS_LABEL.developing;
    const combo = `${escapeHtml(row.combo_a)} (${escapeHtml(row.ipc_a)}) × ${escapeHtml(row.combo_b)} (${escapeHtml(row.ipc_b)})`;
    const evidenceCell = row.status === "gap"
      ? `<button class="pill-btn small" data-gap="${rowId}" aria-label="View evidence for ${combo}">View Evidence <span class="zh">查看證據</span> →</button>`
      : `<span class="combo-evidence">${escapeHtml(row.evidence_en)}</span>`;
    return `
      <tr class="${row.status === "gap" ? "gap-row" : ""}">
        <td>${combo}</td>
        <td>${(Number(row.count) || 0).toLocaleString()}</td>
        <td><span class="status-badge ${row.status === "gap" ? "gap" : row.status === "crowded" ? "dense" : "medium"}">${label.en} <span class="zh">${label.zh}</span></span></td>
        <td>${evidenceCell}</td>
      </tr>
    `;
  }).join("");

  const firstGap = rows.find((r) => r.status === "gap") || rows[0];
  if (firstGap) showGapCard(firstGap);
  updateMatrixScrollHint();
}

function renderWhiteSpaceFromAnalysis(result) {
  const rows = result?.combination_whitespace;
  const note = document.getElementById("whiteSpaceNote");

  if (!Array.isArray(rows) || rows.length === 0) {
    // A real analysis ran, but this case's technical classification (subtech_label ===
    // "OTHER", or no comparable groups) didn't yield a combination breakdown. Say that
    // honestly instead of silently doing nothing, which looked identical to "nothing
    // was ever uploaded."
    note.innerHTML = `<i class="static-dot" aria-hidden="true"></i><span>
      ${escapeHtml(result.case_id || "")} has no matching technology group, so showing the full corpus instead.
      <span class="zh">${escapeHtml(result.case_id || "")} 無對應技術分組，改顯示全語料庫。</span>
    </span>`;
    document.getElementById("whiteSpaceTable").hidden = true;
    renderDefaultWhiteSpaceMatrix();
    return;
  }

  note.innerHTML = `<i class="static-dot" aria-hidden="true"></i><span>
    Based on: ${escapeHtml(result.case_id)} · cutoff ${escapeHtml(String(result.cutoff_year))} · subtech ${escapeHtml(result.subtech_label)}
    <span class="zh">分析對象：${escapeHtml(result.case_id)}・基準日 ${escapeHtml(String(result.cutoff_year))} 年・技術分類 ${escapeHtml(result.subtech_label)}</span>
  </span>`;

  document.getElementById("whiteSpaceMatrix").hidden = true;
  // The backend's own combo_a/combo_b labels are TF-IDF title-word extractions (e.g.
  // "Assurance Conflict") — the same awkward, made-up-sounding pattern already fixed
  // for the default matrix via WS_IPC_LABELS (see below). Apply the same curated
  // lookup here by IPC code so an AI-analyzed case doesn't regress to that look.
  const relabeled = rows.map((row) => ({
    ...row,
    combo_a: wsLabelFor(row.ipc_a),
    combo_b: wsLabelFor(row.ipc_b),
  }));
  renderComboRows(relabeled);
}

/*
 * Default (whole-corpus) White-Space matrix: a real click-to-explore grid computed
 * entirely client-side from data/patents.json — the same 2,799-patent corpus the
 * search bar already uses — so the section shows a real matrix (N=2,799) on page load
 * instead of an empty "not yet analyzed" state. Same IPC-grouping approach as
 * backend/corpus.js's deriveSubtechGroups (top-12 most frequent IPC main-groups), just
 * run in the browser since this default view isn't tied to any single AI-analyzed case.
 *
 * Row/column labels: earlier versions derived labels from title-word frequency
 * (TF-IDF-style), which produced real-but-awkward, made-up-sounding phrases like
 * "Medium Functions" or "Assurance Conflict" — technically traceable to the data but
 * reads as fabricated to anyone unfamiliar with how it was generated. WS_IPC_LABELS
 * below is a small curated map from IPC main-group code to that group's actual
 * classification scope (WIPO IPC subject matter, paraphrased) instead — grounded in a
 * real, checkable external standard rather than an algorithm's word-frequency guess.
 * A completed AI Assistant analysis (renderWhiteSpaceFromAnalysis) replaces this with
 * a case-specific list, since "one case vs many groups" isn't a square matrix.
 */
const WS_SUBTECH_COUNT = 12;
const WS_IPC_LABELS = {
  "H04L 12": "Data Switching Networks",
  "H04L 45": "Routing & Path Selection",
  "H04L 41": "Network Management",
  "H04L 29": "Network Protocol Control",
  "H04L 47": "Traffic Control & QoS",
  "H04W 48": "Network Access Selection",
  "G06F 15": "Computing Systems",
  "G06F 9": "Virtualization & Scheduling",
  "H04L 9": "Network Security",
  "H04W 28": "Wireless Resource Management",
  "H04W 24": "Wireless Monitoring & Testing",
  "H04W 4": "Wireless Network Services",
};
function wsLabelFor(code) {
  return WS_IPC_LABELS[code] || `IPC ${code}`;
}

function wsIpcMainGroup(code) {
  return String(code).split("(")[0].trim().split("/")[0].trim();
}
function wsPrimaryGroup(p) {
  return Array.isArray(p.ipc) && p.ipc.length ? wsIpcMainGroup(p.ipc[0]) : null;
}
function wsDeriveSubtechGroups(corpus) {
  const counts = new Map();
  for (const p of corpus) {
    const g = wsPrimaryGroup(p);
    if (!g) continue;
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, WS_SUBTECH_COUNT).map(([g]) => g);
}
function wsGroupsOf(p, known) {
  const set = new Set();
  for (const code of p.ipc || []) {
    const g = wsIpcMainGroup(code);
    if (known.has(g)) set.add(g);
  }
  return set;
}

// Rows = the 4 most frequent groups in the corpus, columns = the next 4 — an 8-group,
// 4×4 grid stays readable while still covering the bulk of the corpus (disjoint sets,
// so every cell is a distinct, real pair; no diagonal/self-pair ambiguity to handle).
function computeDefaultWhitespaceMatrix(corpus) {
  const topGroups = wsDeriveSubtechGroups(corpus);
  const known = new Set(topGroups);
  const rowGroups = topGroups.slice(0, 4);
  const colGroups = topGroups.slice(4, 8);
  const groupSets = corpus.map((p) => wsGroupsOf(p, known));

  const rawCounts = [];
  for (const a of rowGroups) {
    for (const b of colGroups) {
      let count = 0;
      for (const gs of groupSets) if (gs.has(a) && gs.has(b)) count++;
      rawCounts.push([a, b, count]);
    }
  }
  // Crowded/developing is relative to this matrix's own scale, not a fixed absolute
  // count — these top-8-group cells run far higher than the finer per-case subtech
  // combinations elsewhere on this page, so a fixed "<5" threshold (tuned for those)
  // would leave every non-zero cell here reading as "crowded" and flatten the matrix
  // to two colors. Split non-zero counts at their own median instead.
  const nonZero = rawCounts.map(([, , c]) => c).filter((c) => c > 0).sort((x, y) => x - y);
  const median = nonZero.length ? nonZero[Math.floor((nonZero.length - 1) / 2)] : 0;

  const cells = new Map();
  for (const [a, b, count] of rawCounts) {
    const status = count === 0 ? "gap" : count < median ? "developing" : "crowded";
    const labelA = wsLabelFor(a), labelB = wsLabelFor(b);
    cells.set(`${a}|${b}`, {
      combo_a: labelA, combo_b: labelB, ipc_a: a, ipc_b: b, count, status,
      evidence_en: `Among all ${corpus.length.toLocaleString()} patents in the corpus, ${count} are classified under both "${labelA}" (${a}) and "${labelB}" (${b}).`,
      evidence_zh: `母體 ${corpus.length.toLocaleString()} 筆專利中，同時歸類於「${labelA}」(${a}) 與「${labelB}」(${b}) 的共 ${count} 件。`,
    });
  }
  return { rowGroups, colGroups, cells };
}

let defaultWhitespaceMatrix = null;
let activeMatrixCellKey = null;

function statusClass(status) {
  return status === "gap" ? "gap" : status === "crowded" ? "dense" : "medium";
}

function renderDefaultWhiteSpaceMatrix() {
  if (!patentCorpus) {
    // Corpus fetch genuinely failed (patentCorpusPromise already settled by the time this
    // runs) — reveal the honest "could not load" empty state, which starts `hidden` in the
    // HTML precisely so it doesn't flash as a false-alarm error during the normal few-
    // hundred-ms-to-seconds it takes to fetch+parse the ~3MB corpus on a real connection.
    document.getElementById("whiteSpaceEmpty").hidden = false;
    document.getElementById("whiteSpaceNote").innerHTML = `<i class="static-dot" aria-hidden="true"></i><span>
      Could not load the patent corpus, so no real white-space matrix is available right now.
      <span class="zh">目前無法載入專利語料庫，暫無真實白地矩陣。</span>
    </span>`;
    return;
  }
  if (!defaultWhitespaceMatrix) defaultWhitespaceMatrix = computeDefaultWhitespaceMatrix(patentCorpus);
  const { rowGroups, colGroups, cells } = defaultWhitespaceMatrix;
  if (rowGroups.length === 0 || colGroups.length === 0) return;

  document.getElementById("whiteSpaceNote").innerHTML = `<i class="static-dot" aria-hidden="true"></i><span>
    All ${patentCorpus.length.toLocaleString()} patents in the corpus — click a cell for details.
    <span class="zh">全部 ${patentCorpus.length.toLocaleString()} 筆專利語料庫——點格子看詳情。</span>
  </span>`;

  document.getElementById("whiteSpaceEmpty").hidden = true;
  document.getElementById("whiteSpaceTable").hidden = true;
  document.getElementById("whiteSpaceMatrix").hidden = false;
  document.getElementById("whiteSpaceLegend").hidden = false;
  document.getElementById("whiteSpaceGapCards").hidden = false;

  document.getElementById("whiteSpaceMatrixHead").innerHTML = `
    <tr><th scope="col"><span class="visually-hidden">Technology group / 技術分組</span></th>${colGroups.map((c) => `<th scope="col">${escapeHtml(wsLabelFor(c))}</th>`).join("")}</tr>
  `;
  document.getElementById("whiteSpaceMatrixBody").innerHTML = rowGroups.map((a) => `
    <tr>
      <th scope="row">${escapeHtml(wsLabelFor(a))}</th>
      ${colGroups.map((b) => {
        const key = `${a}|${b}`;
        const cell = cells.get(key);
        return `<td class="${statusClass(cell.status)}" data-cell="${key}" tabindex="0" role="button"
          aria-label="${cell.count.toLocaleString()} patents: ${escapeHtml(cell.combo_a)} × ${escapeHtml(cell.combo_b)}">${cell.count.toLocaleString()}</td>`;
      }).join("")}
    </tr>
  `).join("");

  const firstGapKey = [...cells.entries()].find(([, c]) => c.status === "gap")?.[0];
  const initialKey = firstGapKey || [...cells.keys()][0];
  if (initialKey) selectMatrixCell(initialKey);
  updateMatrixScrollHint();
}

function selectMatrixCell(key) {
  const cell = defaultWhitespaceMatrix?.cells.get(key);
  if (!cell) return;
  activeMatrixCellKey = key;
  document.querySelectorAll("#whiteSpaceMatrixBody td").forEach((td) => {
    td.classList.toggle("active", td.dataset.cell === key);
  });
  showGapCard(cell);
}

document.getElementById("whiteSpaceMatrixBody").addEventListener("click", (e) => {
  const td = e.target.closest("[data-cell]");
  if (td) selectMatrixCell(td.dataset.cell);
});
document.getElementById("whiteSpaceMatrixBody").addEventListener("keydown", (e) => {
  const td = e.target.closest("[data-cell]");
  if (!td) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    selectMatrixCell(td.dataset.cell);
    return;
  }
  // Arrow keys move between cells like a grid (Tab still walks them in order).
  const moves = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
  const mv = moves[e.key];
  if (!mv) return;
  const rows = [...document.querySelectorAll("#whiteSpaceMatrixBody tr")];
  const r = rows.indexOf(td.parentElement);
  const cellsInRow = [...td.parentElement.querySelectorAll("[data-cell]")];
  const c = cellsInRow.indexOf(td);
  const targetRow = rows[r + mv[0]];
  if (!targetRow) return;
  const target = targetRow.querySelectorAll("[data-cell]")[c + mv[1]];
  if (!target) return;
  e.preventDefault();
  target.focus();
});

patentCorpusPromise.then(renderDefaultWhiteSpaceMatrix);

function showGapCard(row) {
  document.getElementById("gapCount").textContent = row.count.toLocaleString();
  document.getElementById("gapCountUnit").innerHTML = `patents <span class="zh">件專利</span>`;
  document.getElementById("gapKicker").textContent = row.status === "gap" ? "POTENTIAL GAP" : row.status.toUpperCase();
  document.getElementById("gapTitle").textContent = `${row.combo_a} × ${row.combo_b}`;
  document.getElementById("gapDescription").textContent = row.evidence_en;
  document.getElementById("gapDescriptionZh").textContent = row.evidence_zh;
  const ask = document.getElementById("gapAsk");
  if (ask) ask.dataset.q = `Is "${row.combo_a} × ${row.combo_b}" (${row.count} patents in the corpus) a white space worth exploring? What does the literature say?`;
  const scoreEl = document.querySelector(".score");
  if (scoreEl) popValue(scoreEl);
}

document.getElementById("whiteSpaceTbody").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-gap]");
  if (!btn) return;
  const row = realCombinationRows.get(btn.dataset.gap);
  if (row) showGapCard(row);
});

/*
 * Real backend integration seam — mirrors TML/frontend/src/lib/agent.ts so both frontends
 * talk to the same backend/server.js the same way. This is a static site with no build step,
 * so there's no env var injection: fill in the deployed Azure App Service URL (…/api/chat)
 * here once it exists. Left empty, the chat below keeps using the local canned demo replies
 * exactly as before — nothing about the current demo behavior changes until this is set.
 */
const AGENT_API_URL = "https://researchgap-agent-api.azurewebsites.net/api/chat";
const PATENTABILITY_API_URL = AGENT_API_URL.replace("/api/chat", "/api/patentability");
let chatHistory = [];
// What was shown, so a reload of this tab can redraw the conversation (sessionStorage: per tab,
// gone when the tab closes; a full or blocked store just means nothing is restored).
const CHAT_STORE_KEY = "rg-chat-v1";
let chatLog = [];
function saveChat() {
  try {
    if (!chatLog.length) sessionStorage.removeItem(CHAT_STORE_KEY);
    else sessionStorage.setItem(CHAT_STORE_KEY, JSON.stringify({ history: chatHistory, log: chatLog.slice(-12) }));
  } catch {
    try { sessionStorage.removeItem(CHAT_STORE_KEY); } catch { /* storage unavailable */ }
  }
}
function restoreChat() {
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(CHAT_STORE_KEY) || "null"); } catch { return; }
  if (!Array.isArray(saved?.log) || !saved.log.length) return;
  chatHistory = Array.isArray(saved.history) ? saved.history : [];
  chatLog = saved.log;
  chatLog.forEach((e) => {
    addUserBubble(e.user);
    addBotBubble(e.en, e.zh, e.usage, e.tool_calls);
  });
  chatMessages.scrollTop = chatMessages.scrollHeight;
  const scoreResult = chatLog
    .flatMap((e) => e.tool_calls || [])
    .filter((c) => c.tool === "compute_patentability" && typeof c.result?.score === "number")
    .map((c) => c.result)
    .pop();
  if (scoreResult) {
    renderWhiteSpaceFromAnalysis(scoreResult);
    showBacktestPanel(scoreResult);
  }
}

// Hand a question to the AI assistant from elsewhere on the page (topic landscape, gap card):
// scroll to the chat and send it, so the user does not have to retype what they were looking at.
function askAssistant(question) {
  document.getElementById("assistant").scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
  if (chatBusy) {
    chatText.value = question;
    return;
  }
  chatText.value = question;
  setTimeout(() => document.getElementById("chatForm").requestSubmit(), prefersReducedMotion ? 0 : 450);
}

// Follow-up suggestions under a reply, chosen by which backend tool produced it (deterministic,
// not model-generated), so the next step is one click away.
function followUpsFor(toolCalls) {
  const tools = (toolCalls || []).map((c) => c.tool);
  const scored = (toolCalls || []).some((c) => c.tool === "compute_patentability" && typeof c.result?.score === "number");
  const landscape = (toolCalls || []).find((c) => c.tool === "topic_landscape" && c.result?.query);
  if (scored) {
    return [
      ["Why is the lowest factor low?", "Which factor pulls my POS down the most, and why?"],
      ["Show the white-space table", "What white-space opportunities exist for my research?"],
      ["Questions for a patent attorney", "What should I ask a patent attorney about this case?"],
    ];
  }
  if (landscape) {
    const q = landscape.result.query;
    return [
      ["Who files most?", `Who are the top patent applicants for ${q}, and how concentrated is it?`],
      ["Recent papers", `List the most relevant recent papers on ${q}, with links.`],
      ["Check my own paper", null],
    ];
  }
  if (tools.includes("search_prior_art")) {
    return [["Is this area crowded?", "Is this area crowded in patents? Give numbers."], ["Check my own paper", null]];
  }
  return [];
}

// A full analysis (scoring + external patent checks + the model's write-up) normally takes
// 20–40 s; past 120 s something is wrong, so the request is abandoned with a clear message
// instead of leaving the typing indicator spinning forever.
const CHAT_TIMEOUT_MS = 120000;
// The backend streams one JSON line per step (application/x-ndjson) — which tools are running —
// and the usual payload as the last line; onProgress gets each step so the typing indicator can
// say what is happening. A plain JSON reply (older backend) is still accepted.
async function readAgentResponse(res, onProgress) {
  if (!/ndjson/.test(res.headers.get("content-type") || "") || !res.body) {
    return { status: res.status, data: res.ok ? await res.json() : null };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last = null;
  const handle = (line) => {
    if (!line.trim()) return;
    const evt = JSON.parse(line);
    if (evt.type === "step") onProgress?.(evt);
    else last = evt;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    lines.forEach(handle);
  }
  handle(buffer);
  if (!last) return { status: 502, data: null };
  return { status: last.type === "error" ? last.status || 500 : 200, data: last };
}

async function sendMessageToAgent(message, history, onProgress, signal) {
  try {
    const res = await fetchWithTimeout(AGENT_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" },
      body: JSON.stringify({ message, history }),
      signal,
    }, CHAT_TIMEOUT_MS);
    const { status, data } = await readAgentResponse(res, onProgress);
    if (status === 429) {
      return {
        en: "You're sending requests a little too fast. Please wait a minute and try again.",
        zh: "請求過於頻繁，請稍候一分鐘再試。",
        usage: null, tool_calls: []
      };
    }
    if (status === 503) {
      return {
        en: "The assistant has reached its usage limit for now. Please try again later.",
        zh: "助理目前已達使用上限，請稍後再試。",
        usage: null, tool_calls: []
      };
    }
    if (status < 200 || status >= 300) {
      return {
        en: `Assistant is temporarily unavailable (server returned ${status}). Please try again shortly.`,
        zh: `助理暫時無法回應（伺服器回傳 ${status}）。請稍後再試。`,
        usage: null, tool_calls: []
      };
    }
    if (typeof data?.reply !== "string") {
      return {
        en: "Assistant response was malformed. Please contact the site administrator.",
        zh: "助理回應格式異常，請聯絡系統管理員確認後端服務。",
        usage: null, tool_calls: []
      };
    }
    return { en: data.reply, zh: "", usage: data.usage || null, tool_calls: data.tool_calls || [] };
  } catch (err) {
    if (signal?.aborted) return { stopped: true };
    if (err?.name === "AbortError") {
      return {
        en: "The assistant took longer than 2 minutes, so the request was stopped. Please try again — a shorter question usually answers faster.",
        zh: "助理超過 2 分鐘未回應，已停止這次請求。請再試一次，較短的問題通常回得較快。",
        usage: null, tool_calls: []
      };
    }
    return {
      en: "Could not reach the assistant backend. Please check your connection and try again.",
      zh: "無法連線到助理後端，請確認網路連線，或稍後再試。",
      usage: null, tool_calls: []
    };
  }
}

const chatMessages = document.getElementById("chatMessages");
const chatText = document.getElementById("chatText");

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Minimal, safe Markdown-ish renderer for AI replies. The system prompt (backend/systemPrompt.js)
// instructs the model to always answer with GFM-style pipe tables, numbered lists and "---"
// section breaks — without this, that structure collapsed into one unreadable run-on paragraph
// (chat bubbles are a single <p>, and HTML collapses newlines). Every text fragment is escaped
// with escapeHtml() before any markup is added, so this never trusts the model's text as HTML.
function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line);
}
function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-");
}
function splitTableCells(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}
function inlineFormat(escapedText) {
  // Operates on already-escaped text, so this only ever adds our own tags — never
  // interprets characters the model produced as HTML. Links: only http(s) URLs become <a>;
  // quotes are already escaped (&quot;), so a URL cannot break out of the href attribute.
  return escapedText
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}
let chatTableCount = 0; // unique accessible names for scrollable reply tables
function renderBotMarkdown(raw) {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let i = 0;
  let paragraphBuf = [];

  function flushParagraph() {
    if (paragraphBuf.length) {
      html.push(`<p>${paragraphBuf.map((l) => inlineFormat(escapeHtml(l))).join("<br>")}</p>`);
      paragraphBuf = [];
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      const headerCells = splitTableCells(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        bodyRows.push(splitTableCells(lines[i]));
        i += 1;
      }
      html.push(
        `<div class="chat-table-wrap" tabindex="0" role="region" aria-label="Table ${++chatTableCount} / 表格 ${chatTableCount}"><table class="chat-table"><thead><tr>${headerCells
          .map((c) => `<th scope="col">${inlineFormat(escapeHtml(c))}</th>`)
          .join("")}</tr></thead><tbody>${bodyRows
          .map((row) => `<tr>${row.map((c, j) => `<td data-label="${escapeHtml(headerCells[j] || "")}">${inlineFormat(escapeHtml(c))}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`
      );
      continue;
    }

    if (/^\s*(-{3,}|—{3,})\s*$/.test(line)) {
      flushParagraph();
      html.push(`<hr class="chat-divider">`);
      i += 1;
      continue;
    }

    // Bulleted ("- ", "* ", "• ") and numbered ("1. ", "1) ") lists: consecutive items of the
    // same kind become one <ul>/<ol>; numbered lists keep the model's own starting number.
    const bullet = /^\s*[-*•]\s+(.*)$/;
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/;
    if (bullet.test(line) || numbered.test(line)) {
      flushParagraph();
      const isNum = numbered.test(line);
      const re = isNum ? numbered : bullet;
      const start = isNum ? Number(line.match(numbered)[1]) : 1;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        const m = lines[i].match(re);
        items.push(isNum ? m[2] : m[1]);
        i += 1;
      }
      const tag = isNum ? "ol" : "ul";
      html.push(`<${tag} class="chat-list"${isNum && start !== 1 ? ` start="${start}"` : ""}>${items.map((t) => `<li>${inlineFormat(escapeHtml(t))}</li>`).join("")}</${tag}>`);
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      flushParagraph();
      const level = headingMatch[1].length;
      const tag = level <= 2 ? "h4" : level === 3 ? "h5" : "h6";
      html.push(`<${tag} class="chat-heading">${inlineFormat(escapeHtml(headingMatch[2]))}</${tag}>`);
      i += 1;
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      i += 1;
      continue;
    }

    paragraphBuf.push(line);
    i += 1;
  }
  flushParagraph();
  return html.join("");
}

function addUserBubble(text) {
  const bubble = document.createElement("div");
  bubble.className = "bubble user";
  bubble.innerHTML = `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  chatMessages.appendChild(bubble);
}

// "How this answer was built": the tools the backend actually ran for this reply, with the
// populations and counts they returned — the visible difference from a general chatbot, whose
// answer has no inspectable trail. Built only from tool_calls in the API response.
function evidenceItems(toolCalls) {
  const items = [];
  for (const call of toolCalls || []) {
    const r = call.result || {};
    if (call.tool === "compute_patentability") {
      if (typeof r.score === "number") {
        const ext = r.external_prior_art || {};
        const kbN = (ext.knowledge_base || []).length;
        items.push({
          en: `Patentability scored by the backend: POS ${r.score} (${r.grade}), cutoff ${r.cutoff_year}, ${r.features?.length || 0} features detected, prior art from ${r.corpus_meta?.n_before_cutoff ?? "?"} corpus patents published by the cutoff${ext.count ? ` + ${ext.count} verified online` : ""}${kbN ? ` + ${kbN} from the knowledge base` : ""}.`,
          zh: `後端計算可專利性：POS ${r.score}（${r.grade}），基準年 ${r.cutoff_year}，偵測到 ${r.features?.length || 0} 個技術特徵；前案來自基準日前 ${r.corpus_meta?.n_before_cutoff ?? "?"} 筆語料庫專利${ext.count ? `＋線上驗證 ${ext.count} 筆` : ""}${kbN ? `＋知識庫 ${kbN} 筆` : ""}。`,
        });
      } else if (r.out_of_scope) {
        items.push({ en: "The backend found this document outside the SDN/NFV scope, so no score was produced.", zh: "後端判定文件超出 SDN／NFV 範圍，因此不給分數。" });
      } else if (r.needs_confirmation) {
        items.push({ en: `The backend needs the ${r.needs_confirmation === "cutoff_year" ? "publication year" : "technical features"} before it can score.`, zh: `後端需要先確認${r.needs_confirmation === "cutoff_year" ? "發表年份" : "技術特徵"}才能計分。` });
      }
    } else if (call.tool === "topic_landscape" && r.patents) {
      items.push({
        en: `Topic landscape computed by the backend for “${r.query}”: ${r.patents.matched.toLocaleString()} of ${Number(r.patents.population.match(/N=(\d+)/)?.[1] || 2799).toLocaleString()} corpus patents, ${r.papers.matched.toLocaleString()} knowledge-base papers${r.patents.applicant_hhi != null ? `, applicant HHI ${r.patents.applicant_hhi}` : ""}.`,
        zh: `後端計算「${r.query}」主題全景：語料庫專利 ${r.patents.matched} 筆、知識庫論文 ${r.papers.matched} 筆${r.patents.applicant_hhi != null ? `，申請人 HHI ${r.patents.applicant_hhi}` : ""}。`,
      });
    } else if (call.tool === "search_prior_art") {
      const kb = (r.knowledge_base || []).length;
      const live = (r.literature || []).length;
      const web = (r.web || []).length;
      const upd = r.knowledge_base_update;
      items.push({
        en: `Literature search “${r.query}”: ${kb} retrieved from the knowledge base, ${live} live from Semantic Scholar / Crossref / arXiv, ${web} web sources${upd ? `; ${upd.added} new record${upd.added === 1 ? "" : "s"} saved to the knowledge base` : ""}.`,
        zh: `文獻搜尋「${r.query}」：知識庫檢索 ${kb} 筆、即時來源 ${live} 筆、網路來源 ${web} 筆${upd ? `；新增 ${upd.added} 筆寫回知識庫` : ""}。`,
      });
    }
  }
  return items;
}

function evidenceBlock(toolCalls) {
  const items = evidenceItems(toolCalls);
  if (!items.length) return "";
  return `<details class="evidence"><summary>How this answer was built <span class="zh">本回答的依據</span> · ${items.length}</summary><ul>${items
    .map((i) => `<li>${escapeHtml(i.en)}<span class="zh">${escapeHtml(i.zh)}</span></li>`)
    .join("")}</ul><p class="evidence-note">Numbers above come from backend code, not from the language model. <span class="zh">以上數字皆由後端程式產生，而非語言模型。</span></p></details>`;
}

function addBotBubble(en, zh, usage, toolCalls) {
  const bubble = document.createElement("div");
  bubble.className = "bubble bot";
  const zhBlock = zh ? `<p class="bubble-zh"><small>${escapeHtml(zh)}</small></p>` : "";
  const usageBlock = usage
    ? `<p class="bubble-usage"><small>Tokens used: ${usage.total_tokens.toLocaleString()} (prompt ${usage.prompt_tokens.toLocaleString()} + completion ${usage.completion_tokens.toLocaleString()}) <span class="zh">・已使用 ${usage.total_tokens.toLocaleString()} tokens</span></small></p>`
    : "";
  const copyBtn = usage ? `<button type="button" class="bubble-copy" title="Copy this answer / 複製這則回答">Copy <span class="zh">複製</span></button>` : "";
  const follow = usage ? followUpsFor(toolCalls) : [];
  const followBlock = follow.length
    ? `<div class="follow-ups"><span class="follow-ups__label">Next <span class="zh">接著問</span></span>${follow
        .map(([label, q]) => `<button type="button" class="follow-up" data-q="${q ? escapeHtml(q) : ""}">${escapeHtml(label)}</button>`)
        .join("")}</div>`
    : "";
  bubble.innerHTML = `<span>RG</span><div class="bubble-content">${evidenceBlock(toolCalls)}${renderBotMarkdown(en)}${zhBlock}${usageBlock}${copyBtn}${followBlock}</div>`;
  bubble.querySelectorAll(".follow-up").forEach((b) =>
    b.addEventListener("click", () => {
      if (chatBusy) return;
      if (!b.dataset.q) {
        // "Check my own paper": point at the upload button instead of sending a question
        document.querySelector(".chat-upload-btn")?.classList.add("attention");
        setTimeout(() => document.querySelector(".chat-upload-btn")?.classList.remove("attention"), 2200);
        document.getElementById("chatFile").click();
        return;
      }
      chatText.value = b.dataset.q;
      document.getElementById("chatForm").requestSubmit();
    })
  );
  bubble.querySelector(".bubble-copy")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(en);
      btn.innerHTML = `Copied <span class="zh">已複製</span>`;
    } catch {
      btn.innerHTML = `Copy failed <span class="zh">無法複製</span>`;
    }
    setTimeout(() => { btn.innerHTML = `Copy <span class="zh">複製</span>`; }, 1800);
  });
  chatMessages.appendChild(bubble);
  return bubble;
}

// Bring the START of a new reply into view. Jumping to the bottom of a long analysis lands the
// reader on the references/disclaimer and hides the conclusion and table they asked for.
function scrollToBubbleStart(bubble) {
  chatMessages.scrollTop += bubble.getBoundingClientRect().top - chatMessages.getBoundingClientRect().top - 8;
}

// Typing indicator with an elapsed-time counter, so a 30-second analysis does not look frozen.
// bubble.setStep() receives the backend's progress events and lists the tools as they run.
const TOOL_STEP_LABELS = {
  search_prior_art: (t) => `Searching papers and patents${t.query ? ` for “${t.query}”` : ""}`,
  topic_landscape: (t) => `Counting patents and papers${t.query ? ` on “${t.query}”` : ""}`,
  compute_patentability: (t) => t.mode === "corpus" && t.query
    ? `Scoring patent ${t.query} against prior art`
    : "Scoring your document against prior art (POS)",
};
function addTypingBubble(withDocument) {
  const bubble = document.createElement("div");
  bubble.className = "bubble bot typing";
  bubble.innerHTML = `<span>RG</span><div class="typing-box"><p class="typing-dots"><i></i><i></i><i></i></p>
    <ol class="typing-steps" hidden></ol>
    <p class="typing-status" aria-live="off"><span class="typing-text">${withDocument
      ? "Reading your document and computing the score… usually 20–40 s"
      : "Working on it…"}</span> <span class="typing-time">0 s</span></p></div>`;
  chatMessages.appendChild(bubble);
  const t0 = Date.now();
  const timeEl = bubble.querySelector(".typing-time");
  const textEl = bubble.querySelector(".typing-text");
  const stepsEl = bubble.querySelector(".typing-steps");
  let gotSteps = false;
  const timer = setInterval(() => {
    const sec = Math.round((Date.now() - t0) / 1000);
    timeEl.textContent = `${sec} s`;
    if (gotSteps) return;
    if (!withDocument && sec === 8) textEl.textContent = "Searching the corpus and the knowledge base…";
    if (sec === 45) textEl.textContent = "Still working — external patent checks can take a while…";
  }, 1000);
  bubble.setStep = (evt) => {
    gotSteps = true;
    stepsEl.querySelectorAll("li:not(.done)").forEach((li) => li.classList.add("done"));
    if (evt.step === "tools" && Array.isArray(evt.tools)) {
      evt.tools.forEach((tool) => {
        const li = document.createElement("li");
        li.textContent = (TOOL_STEP_LABELS[tool.name] || (() => `Running ${tool.name}`))(tool);
        stepsEl.appendChild(li);
      });
      stepsEl.hidden = false;
      textEl.textContent = "Running backend tools…";
    } else if (evt.step === "model") {
      textEl.textContent = evt.round > 0 ? "Writing the answer from these results…" : "Reading your question…";
    }
    if (chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 120) {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  };
  const remove = bubble.remove.bind(bubble);
  bubble.remove = () => {
    clearInterval(timer);
    remove();
  };
  return bubble;
}

/*
 * Document upload: extracts plain text client-side (PDF via pdf.js loaded as a module in
 * index.html and exposed on window.pdfjsLib, TXT via File.text()) and folds it into the next
 * chat message sent to /api/chat, where the existing compute_patentability tool (mode: "upload")
 * already handles arbitrary pasted text — no new backend endpoint needed.
 */
const MAX_ATTACHMENT_CHARS = 12000;
const MAX_PDF_PAGES = 40;
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
let attachedDocText = "";
let attachedDocName = "";

const chatFile = document.getElementById("chatFile");
const chatAttachment = document.getElementById("chatAttachment");
const chatAttachmentName = document.getElementById("chatAttachmentName");
const chatAttachmentRemove = document.getElementById("chatAttachmentRemove");

async function extractPdfText(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  // isEvalSupported:false is the official mitigation for CVE-2024-4367 (pdf.js < 4.2.67
  // could run script from a crafted PDF font) — this build is 3.11.174, so it must stay off.
  const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
  const parts = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => item.str).join(" "));
  }
  return parts.join("\n\n");
}

function clearAttachment() {
  attachedDocText = "";
  attachedDocName = "";
  chatFile.value = "";
  chatAttachment.hidden = true;
  chatAttachmentName.textContent = "";
}

chatAttachmentRemove.addEventListener("click", clearAttachment);

chatFile.addEventListener("change", async () => {
  const file = chatFile.files[0];
  if (!file) return;

  chatAttachment.hidden = false;
  chatAttachmentName.textContent = `Reading ${file.name}...`;

  try {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    const rawText = isPdf ? await extractPdfText(file) : await file.text();
    const text = rawText.replace(/\s+/g, " ").trim();
    if (!text) throw new Error("no extractable text found");
    attachedDocText = text;
    attachedDocName = file.name;
    // A scanned/image-only PDF has no embedded text layer, so pdf.js extracts little or
    // nothing even though the file "succeeded" — warn instead of silently sending near-empty
    // content the AI can't actually read the document from.
    const suspicious = isPdf && text.length < 200;
    chatAttachmentName.textContent = suspicious
      ? `${file.name}: only ${text.length} characters extracted — this may be a scanned PDF with no text layer; try pasting the text directly instead`
      : text.length > MAX_ATTACHMENT_CHARS
        ? `${file.name} (${text.length.toLocaleString()} characters — the first ${MAX_ATTACHMENT_CHARS.toLocaleString()} will be analyzed)`
        : `${file.name} (${text.length.toLocaleString()} characters extracted)`;
  } catch (err) {
    attachedDocText = "";
    attachedDocName = "";
    chatAttachmentName.textContent = `Could not read ${file.name}: ${err.message}`;
  }
});

/*
 * Backtest panel: re-runs the same already-scored case's real extracted features against a
 * different cutoff year via POST /api/patentability (mode:"upload", features + publication_year
 * supplied directly, so the endpoint skips re-extraction and just recomputes from a different
 * historical corpus slice). This is the backend capability the professor's 2023-vs-2020 cutoff
 * request was already asking for — see backend/scoring.js's cutoff-filtered corpus — this panel
 * is the missing demo-facing surface for it, no backend change needed.
 */
const backtestPanel = document.getElementById("backtestPanel");
const backtestCaseLabel = document.getElementById("backtestCaseLabel");
const backtestCaseLabelZh = document.getElementById("backtestCaseLabelZh");
const backtestYear = document.getElementById("backtestYear");
const backtestRun = document.getElementById("backtestRun");
const backtestStatus = document.getElementById("backtestStatus");
const backtestResult = document.getElementById("backtestResult");
let lastScoredCase = null;

function showBacktestPanel(scoreResult) {
  lastScoredCase = scoreResult;
  backtestResult.hidden = true;
  backtestStatus.hidden = true;
  const label = `${scoreResult.case_id} (${scoreResult.subtech_label}, cutoff ${scoreResult.cutoff_year})`;
  const labelZh = `${scoreResult.case_id}（${scoreResult.subtech_label}，基準年 ${scoreResult.cutoff_year}）`;
  backtestCaseLabel.textContent = label;
  backtestCaseLabelZh.textContent = labelZh;
  backtestYear.value = Math.max(2016, Math.min(2027, scoreResult.cutoff_year - 3));
  backtestPanel.hidden = false;
}

function renderBacktestComparison(original, compareYear, compareResult) {
  const rows = original.breakdown
    .map((f, i) => {
      const cf = compareResult.breakdown?.[i];
      return `<tr><td>${escapeHtml(String(f.label))}</td><td>${escapeHtml(String(f.weighted))}</td><td>${cf ? escapeHtml(String(cf.weighted)) : "—"}</td></tr>`;
    })
    .join("");
  backtestResult.innerHTML = `
    <div class="chat-table-wrap" tabindex="0" role="region" aria-label="Backtest table / 回測表格">
      <table class="chat-table">
        <thead><tr><th scope="col">Factor / 因子</th><th scope="col">Cutoff ${escapeHtml(String(original.cutoff_year))}</th><th scope="col">Cutoff ${escapeHtml(String(compareYear))}</th></tr></thead>
        <tbody>
          ${rows}
          <tr><td><strong>POS Score</strong></td><td><strong>${escapeHtml(String(original.score))}</strong></td><td><strong>${escapeHtml(String(compareResult.score))}</strong></td></tr>
          <tr><td><strong>Grade / 等級</strong></td><td><strong>${escapeHtml(String(original.grade))}</strong></td><td><strong>${escapeHtml(String(compareResult.grade))}</strong></td></tr>
        </tbody>
      </table>
    </div>
    <p class="backtest-source">Both columns are computed live from the same real corpus, each sliced at its own cutoff date — not estimated.<span class="zh">兩欄皆由同一份真實語料庫、依各自基準日切片後即時計算，非估計值。</span></p>
  `;
  backtestResult.hidden = false;
}

backtestRun?.addEventListener("click", async () => {
  if (!lastScoredCase) return;
  const year = Number(backtestYear.value);
  backtestResult.hidden = true;
  backtestStatus.hidden = false;
  if (!year || year < 2000 || year > 2100) {
    backtestStatus.className = "backtest-status error";
    backtestStatus.textContent = "Please enter a valid year. / 請輸入有效的年份。";
    return;
  }
  backtestStatus.className = "backtest-status";
  backtestStatus.textContent = "Recomputing against the historical corpus... / 正在用歷史語料庫重新計算……";
  backtestRun.disabled = true;
  try {
    const res = await fetch(PATENTABILITY_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "upload",
        features: lastScoredCase.features,
        doc_terms: lastScoredCase.doc_terms,
        publication_year: year,
        target_jurisdiction: lastScoredCase.target_jurisdiction,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) {
      backtestStatus.className = "backtest-status error";
      backtestStatus.textContent = data?.error || `Server returned ${res.status}. / 伺服器回傳 ${res.status}。`;
      return;
    }
    if (data.needs_confirmation || data.out_of_scope || typeof data.score !== "number") {
      backtestStatus.className = "backtest-status error";
      backtestStatus.textContent = "Not enough real data existed by that year to score honestly. / 該年份之前的真實資料不足，無法誠實評分。";
      return;
    }
    backtestStatus.hidden = true;
    renderBacktestComparison(lastScoredCase, year, data);
  } catch {
    backtestStatus.className = "backtest-status error";
    backtestStatus.textContent = "Could not reach the backend. / 無法連線到後端。";
  } finally {
    backtestRun.disabled = false;
  }
});

function answerFor(text) {
  if (/sdn|nfv/i.test(text)) {
    return {
      en: "Three initial directions found: ① SDN/NFV × Digital Twin, ② Energy-aware NFV orchestration, ③ LLM-based network orchestration. Start by comparing the last 5 years of publication count, patent count, and growth rate.",
      zh: "初步找到 3 個方向：① SDN/NFV × Digital Twin，② Energy-aware NFV orchestration，③ LLM-based network orchestration。建議先比較近 5 年論文量、專利量與成長率。"
    };
  }
  if (/6g/i.test(text)) {
    return {
      en: "For 6G, prioritize checking the intersection of Digital Twin, Green Networking, AI-native orchestration, and decentralized coordination.",
      zh: "6G 可優先檢查：Digital Twin、Green Networking、AI-native orchestration 與 decentralized coordination 的交叉區域。"
    };
  }
  if (/edge/i.test(text)) {
    return {
      en: "Edge Computing shows a widening gap against SDN and Digital Twin — recent literature is growing while patent filings stay sparse in those combinations.",
      zh: "Edge Computing 與 SDN、Digital Twin 的交叉白地正在擴大——近年文獻成長快，但這些組合的專利佈局仍稀少。"
    };
  }
  return {
    en: "Preliminary analysis: this topic may contain a gap where publication density is low but recent growth is increasing. Next, validate it with patent counts, publication clusters, and the newest review papers.",
    zh: "初步分析：此主題可能存在文獻密度低、但近期成長加快的白地，建議接著用專利數量、文獻聚類與最新回顧論文驗證。"
  };
}

// True while a request is in flight: a second submit would start a parallel analysis (more
// cost, replies arriving out of order), so extra submits are ignored until the reply lands.
let chatBusy = false;
const chatSendBtn = document.querySelector("#chatForm button[type=submit]");
// While a reply is pending the send button turns into a Stop button (the backend may still
// finish the turn, but the page stops waiting and nothing is added to the conversation).
let chatAbort = null;
function setChatBusy(busy) {
  chatBusy = busy;
  chatText.disabled = busy;
  if (chatSendBtn) {
    chatSendBtn.classList.toggle("is-stop", busy);
    chatSendBtn.setAttribute("aria-label", busy ? "Stop waiting for the reply" : "Send");
    chatSendBtn.title = busy ? "Stop / 停止" : "";
    chatSendBtn.textContent = busy ? "■" : "→";
  }
  if (!busy) chatText.focus({ preventScroll: true });
}

// "New chat": clears the conversation history the next request carries, and the bubbles.
document.getElementById("chatReset")?.addEventListener("click", () => {
  if (chatBusy) return;
  chatHistory = [];
  chatLog = [];
  saveChat();
  clearAttachment();
  [...chatMessages.querySelectorAll(".bubble")].slice(1).forEach((b) => b.remove());
  chatText.focus({ preventScroll: true });
});

document.getElementById("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (chatBusy) {
    chatAbort?.abort();
    return;
  }
  const typed = chatText.value.trim();
  if (!typed && !attachedDocText) return;

  // Fold any uploaded document into the outgoing message (the visible bubble stays short;
  // the full extracted text rides along for the backend/model to actually read).
  let text = typed;
  let displayText = typed;
  if (attachedDocText) {
    const truncated = attachedDocText.length > MAX_ATTACHMENT_CHARS
      ? `${attachedDocText.slice(0, MAX_ATTACHMENT_CHARS)}\n\n[...truncated, document continues...]`
      : attachedDocText;
    const question = typed || "Please evaluate whether this document describes a patentable invention, and give a POS score if possible.";
    text = `${question}\n\n----- Uploaded document: ${attachedDocName} -----\n${truncated}`;
    displayText = typed
      ? `${typed}\n[Attached file: ${attachedDocName}]`
      : `[Attached file: ${attachedDocName}]`;
  }
  clearAttachment();

  addUserBubble(displayText);
  chatText.value = "";
  chatMessages.scrollTop = chatMessages.scrollHeight;

  const typingBubble = addTypingBubble(text.includes("----- Uploaded document:"));
  chatMessages.scrollTop = chatMessages.scrollHeight;
  setChatBusy(true);

  if (AGENT_API_URL) {
    chatAbort = new AbortController();
    const { en, zh, usage, tool_calls, stopped } = await sendMessageToAgent(text, chatHistory, typingBubble.setStep, chatAbort.signal);
    chatAbort = null;
    if (stopped) {
      typingBubble.remove();
      addBotBubble("Stopped. Ask again whenever you're ready — a narrower question usually answers faster.", "已停止。可隨時再問，範圍較小的問題通常回得較快。");
      setChatBusy(false);
      return;
    }
    chatHistory = [...chatHistory, { role: "user", content: text }, { role: "assistant", content: en }];
    typingBubble.remove();
    const botBubble = addBotBubble(en, zh, usage, tool_calls);
    chatLog.push({ user: displayText, en, zh, usage, tool_calls });
    saveChat();
    scrollToBubbleStart(botBubble);
    setChatBusy(false);
    if (tool_calls?.some((c) => c.tool === "search_prior_art" || c.tool === "compute_patentability")) loadKnowledgeStats();

    const scoreResult = tool_calls
      ?.filter((c) => c.tool === "compute_patentability" && typeof c.result?.score === "number")
      .map((c) => c.result)
      .pop();
    if (scoreResult) {
      renderWhiteSpaceFromAnalysis(scoreResult);
      showBacktestPanel(scoreResult);
    }
    return;
  }

  window.setTimeout(() => {
    const { en, zh } = answerFor(text);
    typingBubble.remove();
    const botBubble = addBotBubble(en, zh);
    scrollToBubbleStart(botBubble);
    setChatBusy(false);
  }, prefersReducedMotion ? 0 : 550);
});

// The data-needs-doc suggestions are about "my paper". Without one attached (and none analysed earlier
// in this chat) the assistant used to ask for a publication year — a confusing answer to a
// question with nothing to answer it about — so say what to do instead, without a round trip.
document.querySelectorAll(".chat-suggestion").forEach(btn => {
  btn.addEventListener("click", () => {
    if (chatBusy) return;
    const hasDocument = Boolean(attachedDocText) || chatHistory.some((m) => m.role === "user" && m.content.includes("Uploaded document:"));
    if (btn.hasAttribute("data-needs-doc") && !hasDocument) {
      addUserBubble(btn.dataset.q || btn.textContent.trim());
      const bubble = addBotBubble("Please attach your paper or patent draft first (PDF or TXT) with the paperclip button below, then ask this question again.", "請先用下方迴紋針按鈕附上論文或專利草稿（PDF 或 TXT），再點一次這個問題。");
      scrollToBubbleStart(bubble);
      document.querySelector(".chat-upload-btn")?.classList.add("attention");
      window.setTimeout(() => document.querySelector(".chat-upload-btn")?.classList.remove("attention"), 2200);
      return;
    }
    chatText.value = btn.dataset.q || btn.textContent.trim();
    document.getElementById("chatForm").requestSubmit();
  });
});

// The long bilingual placeholder is cut off after "技術、" on a phone-width search bar; use a short one there.
{
  const kw = document.getElementById("keyword");
  const narrow = window.matchMedia("(max-width: 520px)");
  const setPlaceholder = () => {
    kw.placeholder = narrow.matches ? "Search patents / 搜尋專利" : "Technology, field, or keyword / 技術、領域或關鍵字";
  };
  setPlaceholder();
  narrow.addEventListener?.("change", setPlaceholder);
}

// A shared link (?q=…) runs its search once the page is ready.
{
  const params = new URLSearchParams(location.search);
  if (params.has("q")) {
    replayingHistory = true;
    applySearchState(Object.fromEntries(params));
    document.getElementById("searchForm").requestSubmit();
  }
}

document.getElementById("landscapePanel").addEventListener("click", (e) => {
  const b = e.target.closest(".ls-ask");
  if (b) askAssistant(b.dataset.q);
});
document.getElementById("gapAsk")?.addEventListener("click", (e) => {
  if (e.currentTarget.dataset.q) askAssistant(e.currentTarget.dataset.q);
});

// "/" jumps to the search box (unless the user is typing somewhere).
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  e.preventDefault();
  const kw = document.getElementById("keyword");
  kw.focus();
  kw.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "center" });
});

restoreChat();

// Offline-capable repeat visits (see sw.js). Registered after load so it never competes with
// the first paint; failures (e.g. private mode) are harmless — the site works without it.
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

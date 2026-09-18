const menuBtn = document.getElementById("menuBtn");
// scoped to the hero topbar specifically — the sticky site-nav header also has a
// ".nav", and it comes first in document order, so an unscoped ".nav" query here
// would silently toggle the wrong (hidden-on-mobile) nav instead of the hamburger's.
const nav = document.querySelector(".topbar .nav");

menuBtn.addEventListener("click", () => {
  nav.classList.toggle("open");
  menuBtn.setAttribute("aria-expanded", nav.classList.contains("open"));
});

document.querySelectorAll(".nav a").forEach(a => {
  a.addEventListener("click", () => nav.classList.remove("open"));
});

const backToTop = document.getElementById("backToTop");
const scrollProgress = document.getElementById("scrollProgress");
const siteNav = document.getElementById("siteNav");

window.addEventListener("scroll", () => {
  const pastFold = window.scrollY > window.innerHeight * 0.6;
  // hide near the very bottom so it doesn't sit on top of the footer's caption text
  const nearBottom = window.scrollY + window.innerHeight > document.documentElement.scrollHeight - 140;
  backToTop.classList.toggle("visible", pastFold && !nearBottom);

  siteNav.classList.toggle("visible", window.scrollY > window.innerHeight * 0.7);

  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  const pct = scrollable > 0 ? (window.scrollY / scrollable) * 100 : 0;
  scrollProgress.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}, { passive: true });
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
const patentCorpusPromise = fetch("data/patents.json")
  .then(res => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  })
  .then(data => { patentCorpus = data; })
  .catch(err => {
    corpusLoadError = err;
    console.error("Failed to load patent corpus:", err);
  });

function searchCorpus({ keyword, yearStart, yearEnd, jurisdiction, patentType }) {
  if (!patentCorpus || !patentType) return [];
  const kw = keyword.trim().toLowerCase();
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
      if (kw) {
        const haystack = `${p.title || ""} ${p.abstract || ""} ${p.category || ""}`.toLowerCase();
        if (!haystack.includes(kw)) return false;
      }
      return true;
    })
    .sort((a, b) => (b.publication_date || "").localeCompare(a.publication_date || ""));
}

const googlePatentsUrl = (publicationNumber) =>
  `https://patents.google.com/patent/${encodeURIComponent(publicationNumber)}/en`;

const formatCategory = (category) =>
  category
    ? category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "Uncategorized";

const RESULTS_PAGE_SIZE = 5;
let currentResults = [];
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
        <h5>${escapeHtml(p.title || "(untitled)")}</h5>
        <p class="result-meta">${escapeHtml(applicant)} · ${escapeHtml(formatCategory(p.category))}</p>
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
    list.innerHTML = `<div class="results-empty">
      No matching patents in the corpus — for this keyword/filter combination, that absence may
      itself be a white-space signal worth validating.
      <br><small>語料庫中沒有符合的專利——這個組合的「查無結果」本身，也可能是值得驗證的白地訊號。</small>
    </div>`;
    return;
  }

  renderResultsPage();
}

/* ===== Motion: scroll-reveal, count-up, nav scrollspy ===== */
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (!prefersReducedMotion) {
  const revealTargets = document.querySelectorAll(
    ".section-head, .gap-card, .about-copy p"
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

document.getElementById("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();

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
  document.getElementById("resultsList").innerHTML =
    `<div class="results-loading">Searching the 2,799-patent corpus… <span class="zh">搜尋 2,799 筆專利語料庫中…</span></div>`;

  await patentCorpusPromise;
  const results = searchCorpus({ keyword: keywordInput, yearStart: start, yearEnd: end, jurisdiction, patentType: patent });
  renderResults(results, keywordInput);

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
        <td>${row.count.toLocaleString()}</td>
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
    <tr><th></th>${colGroups.map((c) => `<th>${escapeHtml(wsLabelFor(c))}</th>`).join("")}</tr>
  `;
  document.getElementById("whiteSpaceMatrixBody").innerHTML = rowGroups.map((a) => `
    <tr>
      <th>${escapeHtml(wsLabelFor(a))}</th>
      ${colGroups.map((b) => {
        const key = `${a}|${b}`;
        const cell = cells.get(key);
        return `<td class="${statusClass(cell.status)}" data-cell="${key}" tabindex="0" role="button"
          aria-label="View ${escapeHtml(cell.combo_a)} × ${escapeHtml(cell.combo_b)}">${cell.count.toLocaleString()}</td>`;
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
  if (e.key !== "Enter" && e.key !== " ") return;
  const td = e.target.closest("[data-cell]");
  if (!td) return;
  e.preventDefault();
  selectMatrixCell(td.dataset.cell);
});

patentCorpusPromise.then(renderDefaultWhiteSpaceMatrix);

function showGapCard(row) {
  document.getElementById("gapCount").textContent = row.count.toLocaleString();
  document.getElementById("gapCountUnit").innerHTML = `patents <span class="zh">件專利</span>`;
  document.getElementById("gapKicker").textContent = row.status === "gap" ? "POTENTIAL GAP" : row.status.toUpperCase();
  document.getElementById("gapTitle").textContent = `${row.combo_a} × ${row.combo_b}`;
  document.getElementById("gapDescription").textContent = row.evidence_en;
  document.getElementById("gapDescriptionZh").textContent = row.evidence_zh;
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

async function sendMessageToAgent(message, history) {
  try {
    const res = await fetch(AGENT_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
    if (!res.ok) {
      return {
        en: `Assistant is temporarily unavailable (server returned ${res.status}). Please try again shortly.`,
        zh: `助理暫時無法回應（伺服器回傳 ${res.status}）。請稍後再試。`,
        usage: null, tool_calls: []
      };
    }
    const data = await res.json();
    if (typeof data?.reply !== "string") {
      return {
        en: "Assistant response was malformed. Please contact the site administrator.",
        zh: "助理回應格式異常，請聯絡系統管理員確認後端服務。",
        usage: null, tool_calls: []
      };
    }
    return { en: data.reply, zh: "", usage: data.usage || null, tool_calls: data.tool_calls || [] };
  } catch {
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
  // interprets characters the model produced as HTML.
  return escapedText.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}
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
        `<div class="chat-table-wrap"><table class="chat-table"><thead><tr>${headerCells
          .map((c) => `<th>${inlineFormat(escapeHtml(c))}</th>`)
          .join("")}</tr></thead><tbody>${bodyRows
          .map((row) => `<tr>${row.map((c) => `<td>${inlineFormat(escapeHtml(c))}</td>`).join("")}</tr>`)
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

function addBotBubble(en, zh, usage) {
  const bubble = document.createElement("div");
  bubble.className = "bubble bot";
  const zhBlock = zh ? `<p class="bubble-zh"><small>${escapeHtml(zh)}</small></p>` : "";
  const usageBlock = usage
    ? `<p class="bubble-usage"><small>Tokens used: ${usage.total_tokens.toLocaleString()} (prompt ${usage.prompt_tokens.toLocaleString()} + completion ${usage.completion_tokens.toLocaleString()}) <span class="zh">・已使用 ${usage.total_tokens.toLocaleString()} tokens</span></small></p>`
    : "";
  bubble.innerHTML = `<span>RG</span><div class="bubble-content">${renderBotMarkdown(en)}${zhBlock}${usageBlock}</div>`;
  chatMessages.appendChild(bubble);
}

function addTypingBubble() {
  const bubble = document.createElement("div");
  bubble.className = "bubble bot typing";
  bubble.innerHTML = `<span>RG</span><p class="typing-dots"><i></i><i></i><i></i></p>`;
  chatMessages.appendChild(bubble);
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
let attachedDocText = "";
let attachedDocName = "";

const chatFile = document.getElementById("chatFile");
const chatAttachment = document.getElementById("chatAttachment");
const chatAttachmentName = document.getElementById("chatAttachmentName");
const chatAttachmentRemove = document.getElementById("chatAttachmentRemove");

async function extractPdfText(file) {
  if (!window.pdfjsLib) throw new Error("PDF reader is still loading, please try again in a moment");
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
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
      return `<tr><td>${escapeHtml(f.label)}</td><td>${f.weighted}</td><td>${cf ? cf.weighted : "—"}</td></tr>`;
    })
    .join("");
  backtestResult.innerHTML = `
    <div class="chat-table-wrap">
      <table class="chat-table">
        <thead><tr><th>Factor / 因子</th><th>Cutoff ${escapeHtml(String(original.cutoff_year))}</th><th>Cutoff ${escapeHtml(String(compareYear))}</th></tr></thead>
        <tbody>
          ${rows}
          <tr><td><strong>POS Score</strong></td><td><strong>${original.score}</strong></td><td><strong>${compareResult.score}</strong></td></tr>
          <tr><td><strong>Grade / 等級</strong></td><td><strong>${escapeHtml(original.grade)}</strong></td><td><strong>${escapeHtml(compareResult.grade)}</strong></td></tr>
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

document.getElementById("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
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

  const typingBubble = addTypingBubble();
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (AGENT_API_URL) {
    const { en, zh, usage, tool_calls } = await sendMessageToAgent(text, chatHistory);
    chatHistory = [...chatHistory, { role: "user", content: text }, { role: "assistant", content: en }];
    typingBubble.remove();
    addBotBubble(en, zh, usage);
    document.getElementById("aiResponse").textContent = en;
    chatMessages.scrollTop = chatMessages.scrollHeight;

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
    addBotBubble(en, zh);
    document.getElementById("aiResponse").textContent = en;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }, prefersReducedMotion ? 0 : 550);
});

document.querySelectorAll(".chat-suggestion").forEach(btn => {
  btn.addEventListener("click", () => {
    chatText.value = btn.textContent.trim();
    document.getElementById("chatForm").requestSubmit();
  });
});

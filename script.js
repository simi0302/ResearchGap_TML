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

const RESULTS_PAGE_SIZE = 24;

function renderResults(results, keyword) {
  const heading = document.getElementById("resultsHeading");
  const countEl = document.getElementById("resultsCount");
  const list = document.getElementById("resultsList");

  heading.textContent = keyword ? `Results for "${keyword}"` : "All patents in the corpus";

  if (corpusLoadError) {
    countEl.textContent = "";
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
    list.innerHTML = `<div class="results-empty">
      No matching patents in the corpus — for this keyword/filter combination, that absence may
      itself be a white-space signal worth validating.
      <br><small>語料庫中沒有符合的專利——這個組合的「查無結果」本身，也可能是值得驗證的白地訊號。</small>
    </div>`;
    return;
  }

  const shown = results.slice(0, RESULTS_PAGE_SIZE);
  countEl.textContent = results.length > shown.length
    ? `Showing ${shown.length} of ${results.length.toLocaleString()}`
    : `${results.length.toLocaleString()} result${results.length === 1 ? "" : "s"}`;

  list.innerHTML = shown.map(p => {
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

/* ===== Motion: scroll-reveal, count-up, nav scrollspy ===== */
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Guards the count-up animation below against a real data race: if a search
// resolves and writes a real metric value while that metric's scroll-triggered
// count-up is still mid-flight, the animation's own rAF loop would otherwise
// blindly overwrite the real value a frame later. Any writer "claims" an
// element by bumping its generation; the animation checks its own generation
// is still current on every frame and silently aborts once it isn't.
const metricGen = new WeakMap();
const bumpMetricGen = (el) => {
  const next = (metricGen.get(el) || 0) + 1;
  metricGen.set(el, next);
  return next;
};
function setMetricValue(el, value) {
  bumpMetricGen(el);
  el.textContent = value;
  popValue(el);
}

if (!prefersReducedMotion) {
  const revealTargets = document.querySelectorAll(
    ".section-head, .metric, .gap-card, .chart-card, .emerging-list article, .about-copy p"
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

  // count numeric strong/score values up from 0 the first time they scroll into view
  const countTargets = document.querySelectorAll(".metric strong");
  const countObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      countObserver.unobserve(entry.target);
      const el = entry.target;
      const raw = el.textContent.trim();
      const target = parseInt(raw.replace(/[^\d]/g, ""), 10);
      if (!Number.isFinite(target)) return;
      const duration = 900;
      const start = performance.now();
      const myGen = bumpMetricGen(el);
      function tick(now) {
        if (metricGen.get(el) !== myGen) return; // a real value was written mid-animation — bail out
        const progress = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.round(target * eased).toLocaleString();
        if (progress < 1) requestAnimationFrame(tick);
        else el.textContent = raw;
      }
      requestAnimationFrame(tick);
    });
  }, { threshold: 0.4 });
  countTargets.forEach(el => countObserver.observe(el));
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
  // trend chart lines "draw" in once scrolled into view
  const chartLines = document.querySelectorAll(".chart-card .line");
  chartLines.forEach(line => {
    const length = line.getTotalLength();
    line.style.strokeDasharray = `${length}`;
    line.style.strokeDashoffset = `${length}`;
  });
  const lineObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("draw");
      lineObserver.unobserve(entry.target);
    });
  }, { threshold: 0.35 });
  chartLines.forEach(line => lineObserver.observe(line));

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

const numberFromText = (text) =>
  [...text].reduce((n, ch) => n + ch.charCodeAt(0), 0);

function makeDemoMetrics(keyword) {
  const seed = numberFromText(keyword || "ResearchGap");
  return {
    papers: (1700 + seed % 2100).toLocaleString(),
    patents: (500 + seed % 1300).toLocaleString(),
    institutions: 120 + seed % 330,
    topics: 7 + seed % 16,
    gaps: 4 + seed % 11
  };
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

  const realPatents = corpusLoadError ? null : results.length;
  const realInstitutions = corpusLoadError ? null
    : new Set(results.map(p => p.company_name || (p.assignees && p.assignees[0]) || "Unknown")).size;

  // Publications/Topics/Gaps have no real dataset behind them (see the data-note in the
  // UI). Keep them from contradicting the real search: if the real corpus found nothing
  // for this combination, show nothing here either, instead of an unrelated
  // plausible-looking number that has nothing to do with what was actually searched.
  const nothingFound = realPatents === 0;
  const m = nothingFound ? { papers: "0", topics: 0, gaps: 0 } : makeDemoMetrics(keywordInput);

  const metricEls = ["metricPapers", "metricPatents", "metricInstitutions", "metricTopics", "metricGaps"]
    .map(id => document.getElementById(id));
  const metricValues = [
    paper ? m.papers : "0",
    realPatents === null ? "—" : realPatents.toLocaleString(),
    realInstitutions === null ? "—" : realInstitutions.toLocaleString(),
    m.topics,
    m.gaps
  ];
  metricEls.forEach((el, i) => setMetricValue(el, metricValues[i]));

  document.getElementById("analysisSummary").textContent =
    `${keywordInput || "All patents"} · ${start || "All"}—${end || "2026"} · ${jurisdiction} · ${types}`;
});

const gapData = {
  "SDN × Digital Twin": {
    score: 87,
    en: "Related literature and patents remain scarce, but research growth is accelerating — worth examining real-time network optimization, autonomic management, and digital twin integration.",
    zh: "相關文獻與專利數量偏低，但研究成長速度較快，適合進一步檢查即時網路最佳化、自治管理與數位孿生整合。"
  },
  "NFV × Digital Twin": {
    score: 91,
    en: "Direct cross-research between NFV and Digital Twin is still limited — worth exploring service-chain simulation, resource orchestration, and fault prediction.",
    zh: "NFV 與 Digital Twin 的直接交叉研究仍少，可進一步探索服務鏈模擬、資源編排與故障預測。"
  },
  "NFV × Blockchain": {
    score: 79,
    en: "This combination already has some security/trust research, but a white space may remain in lightweight coordination and cross-domain NFV management.",
    zh: "此組合已有部分安全與信任研究，但在輕量化協調與跨域 NFV 管理方面仍可能存在白地。"
  },
  "6G × Blockchain": {
    score: 83,
    en: "6G research volume is growing fast, but its cross-density with Blockchain patents and literature is relatively limited — worth examining decentralized network coordination.",
    zh: "6G 的研究量快速增加，但與 Blockchain 的專利與文獻交叉密度相對有限，可檢視去中心化網路協調機會。"
  }
};

function selectGap(cell) {
  const key = cell.dataset.gap;
  document.getElementById("gapTitle").textContent = key;
  document.getElementById("gapDescription").textContent = gapData[key].en;
  document.getElementById("gapDescriptionZh").textContent = gapData[key].zh;
  const scoreEl = document.querySelector(".score");
  scoreEl.innerHTML = `${gapData[key].score}<small>/100</small>`;
  popValue(scoreEl);
}

document.querySelectorAll("[data-gap]").forEach(cell => {
  cell.addEventListener("click", () => selectGap(cell));
  cell.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectGap(cell);
    }
  });
});

document.getElementById("evidenceBtn").addEventListener("click", () => {
  document.getElementById("evidenceNote").hidden = false;
});

/*
 * Real backend integration seam — mirrors TML/frontend/src/lib/agent.ts so both frontends
 * talk to the same backend/server.js the same way. This is a static site with no build step,
 * so there's no env var injection: fill in the deployed Azure App Service URL (…/api/chat)
 * here once it exists. Left empty, the chat below keeps using the local canned demo replies
 * exactly as before — nothing about the current demo behavior changes until this is set.
 */
const AGENT_API_URL = "";
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
        zh: `助理暫時無法回應（伺服器回傳 ${res.status}）。請稍後再試。`
      };
    }
    const data = await res.json();
    if (typeof data?.reply !== "string") {
      return {
        en: "Assistant response was malformed. Please contact the site administrator.",
        zh: "助理回應格式異常，請聯絡系統管理員確認後端服務。"
      };
    }
    return { en: data.reply, zh: "" };
  } catch {
    return {
      en: "Could not reach the assistant backend. Please check your connection and try again.",
      zh: "無法連線到助理後端，請確認網路連線，或稍後再試。"
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

function addUserBubble(text) {
  const bubble = document.createElement("div");
  bubble.className = "bubble user";
  bubble.innerHTML = `<p>${escapeHtml(text)}</p>`;
  chatMessages.appendChild(bubble);
}

function addBotBubble(en, zh) {
  const bubble = document.createElement("div");
  bubble.className = "bubble bot";
  bubble.innerHTML = `<span>RG</span><p>${escapeHtml(en)}${zh ? `<br><small>${escapeHtml(zh)}</small>` : ""}</p>`;
  chatMessages.appendChild(bubble);
}

function addTypingBubble() {
  const bubble = document.createElement("div");
  bubble.className = "bubble bot typing";
  bubble.innerHTML = `<span>RG</span><p class="typing-dots"><i></i><i></i><i></i></p>`;
  chatMessages.appendChild(bubble);
  return bubble;
}

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
  const text = chatText.value.trim();
  if (!text) return;

  addUserBubble(text);
  chatText.value = "";
  chatMessages.scrollTop = chatMessages.scrollHeight;

  const typingBubble = addTypingBubble();
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (AGENT_API_URL) {
    const { en, zh } = await sendMessageToAgent(text, chatHistory);
    chatHistory = [...chatHistory, { role: "user", content: text }, { role: "assistant", content: en }];
    typingBubble.remove();
    addBotBubble(en, zh);
    document.getElementById("aiResponse").textContent = en;
    chatMessages.scrollTop = chatMessages.scrollHeight;
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

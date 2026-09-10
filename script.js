const menuBtn = document.getElementById("menuBtn");
const nav = document.querySelector(".nav");

menuBtn.addEventListener("click", () => {
  nav.classList.toggle("open");
  menuBtn.setAttribute("aria-expanded", nav.classList.contains("open"));
});

document.querySelectorAll(".nav a").forEach(a => {
  a.addEventListener("click", () => nav.classList.remove("open"));
});

const backToTop = document.getElementById("backToTop");
window.addEventListener("scroll", () => {
  const pastFold = window.scrollY > window.innerHeight * 0.6;
  // hide near the very bottom so it doesn't sit on top of the footer's caption text
  const nearBottom = window.scrollY + window.innerHeight > document.documentElement.scrollHeight - 140;
  backToTop.classList.toggle("visible", pastFold && !nearBottom);
});
backToTop.addEventListener("click", () => {
  window.scrollTo({ top: 0, behavior: "smooth" });
});

document.querySelectorAll(".tag").forEach(tag => {
  tag.addEventListener("click", () => {
    document.getElementById("keyword").value = tag.textContent.trim();
    document.getElementById("keyword").focus();
  });
});

/* ===== Motion: scroll-reveal, count-up, nav scrollspy ===== */
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
      function tick(now) {
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

document.getElementById("searchForm").addEventListener("submit", (e) => {
  e.preventDefault();

  const keyword = document.getElementById("keyword").value.trim() || "Software Defined Networking";
  const start = document.getElementById("yearStart").value || "All";
  const end = document.getElementById("yearEnd").value || "2026";
  const country = document.getElementById("country").value;
  const patent = document.getElementById("patent").checked;
  const paper = document.getElementById("paper").checked;

  const types = [patent && "Patent", paper && "Academic Paper"].filter(Boolean).join(" + ") || "No type selected";
  const m = makeDemoMetrics(keyword);

  const metricEls = ["metricPapers", "metricPatents", "metricInstitutions", "metricTopics", "metricGaps"]
    .map(id => document.getElementById(id));
  const metricValues = [m.papers, m.patents, m.institutions, m.topics, m.gaps];
  metricEls.forEach((el, i) => {
    el.textContent = metricValues[i];
    popValue(el);
  });

  document.getElementById("analysisSummary").textContent =
    `${keyword} · ${start}—${end} · ${country} · ${types}（Prototype sample analysis）`;

  document.getElementById("overview").scrollIntoView({behavior:"smooth"});
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

document.querySelectorAll("[data-gap]").forEach(cell => {
  cell.addEventListener("click", () => {
    const key = cell.dataset.gap;
    document.getElementById("gapTitle").textContent = key;
    document.getElementById("gapDescription").textContent = gapData[key].en;
    document.getElementById("gapDescriptionZh").textContent = gapData[key].zh;
    const scoreEl = document.querySelector(".score");
    scoreEl.innerHTML = `${gapData[key].score}<small>/100</small>`;
    popValue(scoreEl);
  });
});

document.getElementById("evidenceBtn").addEventListener("click", () => {
  alert("Prototype: this button can later open the supporting papers + patents evidence panel.");
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

function addUserBubble(text) {
  const bubble = document.createElement("div");
  bubble.className = "bubble user";
  bubble.innerHTML = `<p>${text.replace(/</g, "&lt;")}</p>`;
  chatMessages.appendChild(bubble);
}

function addBotBubble(en, zh) {
  const bubble = document.createElement("div");
  bubble.className = "bubble bot";
  bubble.innerHTML = `<span>RG</span><p>${en}${zh ? `<br><small>${zh}</small>` : ""}</p>`;
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

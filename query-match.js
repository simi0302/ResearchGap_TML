// Query understanding for the hero search bar, shared by the browser and the backend.
//
// The browser loads this file as /query-match.js (a byte-identical copy at the site root —
// queryMatch.test.js fails if the two drift apart); the backend requires it so that the
// /api/expand-query corpus check counts matches exactly the way the search bar will.
//
// Matching rules:
// - Text is normalized (NFKC, lowercase, "-", "_", "/" treated as spaces) on both sides,
//   so "Software-Defined" and "software defined" are the same thing.
// - A query is split into concepts. A known phrase (e.g. "network slicing", "SDN",
//   "軟體定義網路") becomes one concept that matches any of its curated synonyms; every
//   other word is its own concept. A patent must match EVERY concept (AND), and any
//   variant of a concept counts (OR). "quoted text" is matched literally as one concept.
// - Short ASCII terms (≤ 3 chars, e.g. "ai", "ran", "5g") need word boundaries, so "ai"
//   does not match "maintain". Longer typed words match as prefixes ("orchestr").
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QueryMatch = api;
})(typeof self !== "undefined" ? self : this, function () {
  // Curated synonym groups for the SDN/NFV/network-slicing domain. The first entry is the
  // label shown to the user; the first ASCII entry is used as the English query when the
  // same concept is sent to literature databases. Only established equivalents belong here
  // (abbreviation ↔ spelled-out form, spelling variants, Chinese ↔ English) — not loosely
  // "related" topics, which is what the AI suggestions are for.
  const SYNONYM_GROUPS = [
    ["SDN", "sdn", "software defined network", "software defined networking", "軟體定義網路", "軟體定義網絡", "软件定义网络"],
    ["NFV", "nfv", "network function virtualization", "network functions virtualization", "network function virtualisation", "network functions virtualisation", "網路功能虛擬化", "網絡功能虛擬化", "网络功能虚拟化"],
    ["VNF", "vnf", "virtual network function", "virtualized network function", "virtualised network function", "虛擬網路功能", "虚拟网络功能"],
    ["network slicing", "network slicing", "network slice", "網路切片", "網絡切片", "网络切片"],
    ["5G", "5g", "fifth generation", "第五代行動通訊", "第五代移動通信"],
    ["6G", "6g", "sixth generation"],
    ["MEC", "mec", "multi access edge computing", "mobile edge computing", "多接取邊緣運算", "移動邊緣計算"],
    ["edge computing", "edge computing", "邊緣運算", "边缘计算"],
    ["RAN", "ran", "radio access network", "無線接取網路", "无线接入网"],
    ["QoS", "qos", "quality of service", "服務品質", "服务质量"],
    ["QoE", "qoe", "quality of experience", "體驗品質"],
    ["orchestration", "orchestration", "orchestrator", "協作編排", "编排"],
    ["MANO", "mano", "management and orchestration"],
    ["intent-based", "intent based", "intent driven", "意圖導向", "基于意图"],
    ["zero-touch", "zero touch", "零接觸"],
    ["AI", "ai", "artificial intelligence", "人工智慧", "人工智能"],
    ["machine learning", "machine learning", "機器學習", "机器学习"],
    ["deep learning", "deep learning", "深度學習", "深度学习"],
    ["reinforcement learning", "reinforcement learning", "強化學習", "强化学习"],
    ["digital twin", "digital twin", "數位孿生", "數字孿生", "数字孪生"],
    ["load balancing", "load balancing", "load balancer", "負載平衡", "负载均衡"],
    ["controller", "controller", "控制器"],
    ["OpenFlow", "openflow"],
    ["virtual machine", "virtual machine", "虛擬機", "虚拟机"],
    ["container", "container", "容器"],
    ["cloud", "cloud", "雲端", "云"],
    ["security", "security", "資安", "安全"],
    ["latency", "latency", "時延", "延遲", "时延"],
    ["routing", "routing", "路由"],
    ["traffic engineering", "traffic engineering", "流量工程"],
  ].map(([label, ...variants]) => ({ label, variants }));

  const STOPWORDS = new Set(["and", "or", "the", "of", "for", "in", "on", "with", "a", "an", "to", "的", "與", "和", "及"]);
  const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;

  function normalize(text) {
    return String(text || "")
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[-_/]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripQuotes(s) {
    return String(s || "").replace(/["“”]/g, " ");
  }

  // Inflection allowed after a dictionary term: "VNFs", "slices", "sliced", "orchestrating".
  // Short abbreviations only take a plural "s", so "ran" doesn't match "rand".
  function suffixFor(term) {
    if (term.length <= 3) return "s?";
    return term.endsWith("e") ? "(?:s|d|r|rs)?" : "(?:s|es|ed|ing)?";
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // One variant → a matcher function over normalized text.
  //   exact: dictionary term; leading word boundary, plus an optional plural/verb suffix.
  //   prefix: user-typed word ≥ 4 chars; leading boundary only.
  function compileVariant(variant, mode) {
    const v = normalize(variant);
    if (!v) return null;
    if (CJK.test(v)) return (text) => text.includes(v);
    const lead = "(?:^|[^a-z0-9])";
    let pattern;
    if (mode === "prefix" && v.length >= 4) pattern = lead + escapeRe(v);
    else pattern = lead + escapeRe(v) + suffixFor(v) + "(?![a-z0-9])";
    const re = new RegExp(pattern);
    return (text) => re.test(text);
  }

  // Dictionary lookup index: normalized variant → group, longest first for greedy matching.
  const PHRASES = [];
  for (const g of SYNONYM_GROUPS) for (const v of g.variants) PHRASES.push({ phrase: normalize(v), group: g });
  PHRASES.sort((a, b) => b.phrase.length - a.phrase.length);

  function makeConcept(label, variants, { fromDictionary, mode }) {
    const uniq = [...new Set(variants.map(normalize).filter(Boolean))];
    const matchers = uniq.map((v) => compileVariant(v, mode)).filter(Boolean);
    return {
      label,
      variants: uniq,
      fromDictionary,
      englishTerm: /^[ -~]+$/.test(label) ? label : uniq.find((v) => !CJK.test(v)) || null,
      test: (text) => matchers.some((m) => m(text)),
    };
  }

  // Finds dictionary phrases inside a chunk of text (works for CJK text without spaces too).
  function extractPhrases(chunk) {
    const concepts = [];
    let rest = " " + chunk + " ";
    for (const { phrase, group } of PHRASES) {
      const isCjk = CJK.test(phrase);
      const re = isCjk ? new RegExp(escapeRe(phrase), "g") : new RegExp("(?:^|[^a-z0-9])" + escapeRe(phrase) + suffixFor(phrase) + "(?![a-z0-9])", "g");
      if (re.test(rest)) {
        if (!concepts.some((c) => c.label === group.label)) {
          concepts.push(makeConcept(group.label, group.variants, { fromDictionary: true, mode: "exact" }));
        }
        rest = rest.replace(re, " ");
      }
    }
    return { concepts, rest };
  }

  function parseQuery(query) {
    const concepts = [];
    let text = String(query || "");
    // "quoted phrases" are matched literally
    text = text.replace(/["“”]([^"“”]+)["“”]/g, (_m, q) => {
      const n = normalize(q);
      if (n) concepts.push(makeConcept(q.trim(), [n], { fromDictionary: false, mode: "exact" }));
      return " ";
    });
    const { concepts: dict, rest } = extractPhrases(normalize(text));
    concepts.push(...dict);
    for (const word of rest.split(/[\s,，、;；]+/)) {
      let w = word.trim();
      for (const sw of ["的", "與", "和", "及"]) w = w.split(sw).join(" ").trim();
      for (const piece of w.split(" ")) {
        if (!piece || STOPWORDS.has(piece)) continue;
        if (concepts.some((c) => c.variants.includes(piece))) continue;
        concepts.push(makeConcept(piece, [piece], { fromDictionary: false, mode: "prefix" }));
      }
    }
    return concepts;
  }

  // Text a patent is searched over. Deliberately excludes the internal `category` label
  // (e.g. "network_slicing_baseline" sits on 2,549 of 2,799 patents and would make
  // "network slicing" match nearly everything).
  function patentText(p) {
    return { title: normalize(p.title), abstract: normalize(p.abstract) };
  }

  // Relevance: title hits weigh 3, abstract hits 1, per concept; a literal hit of the exact
  // typed words adds a little so the user's own wording ranks first.
  function scorePatent(concepts, p, rawQuery) {
    const { title, abstract } = patentText(p);
    let score = 0;
    for (const c of concepts) {
      const inTitle = c.test(title);
      const inAbstract = c.test(abstract);
      if (!inTitle && !inAbstract) return 0;
      score += (inTitle ? 3 : 0) + (inAbstract ? 1 : 0);
    }
    const literal = normalize(stripQuotes(rawQuery));
    if (literal && (title.includes(literal) || abstract.includes(literal))) score += 0.5;
    return score;
  }

  // Whether the patent would also have matched a plain substring search for the typed
  // text — used to report how many results only the synonyms found.
  function literalMatch(p, rawQuery) {
    const literal = normalize(stripQuotes(rawQuery));
    if (!literal) return true;
    const { title, abstract } = patentText(p);
    return title.includes(literal) || abstract.includes(literal);
  }

  // Number of patents a single term matches, using the same rules as the search bar.
  function countTermMatches(corpus, term) {
    const concepts = parseQuery(term);
    if (!concepts.length) return 0;
    let n = 0;
    for (const p of corpus) if (scorePatent(concepts, p, "") > 0) n += 1;
    return n;
  }

  // English query for literature databases (they don't understand Chinese terms).
  function englishQuery(concepts) {
    return concepts.map((c) => c.englishTerm || c.variants[0]).filter(Boolean).join(" ");
  }

  return { SYNONYM_GROUPS, normalize, parseQuery, scorePatent, literalMatch, countTermMatches, englishQuery, patentText };
});

// Every backend-generated user-facing string in one place, {en, zh}. English is the default
// for this deployment (international track — see DEFAULT_LANG in server.js); Chinese is kept
// for local/demo use. Never mix languages inside one string — callers pick the whole table via
// t(lang) and read from it, so a string can't drift out of sync in only one language.
const STRINGS = {
  en: {
    grade: { high: "High", medium: "Medium", low: "Low" },
    scoreName: "Patentability Opportunity Score (POS)",
    disclaimer:
      "Relative opportunity score based on sources searched up to the cutoff year. Not a prediction of patent approval. Inventive step requires a patent attorney.",
    factorLabels: {
      novelty: "Novelty",
      crowding: "Crowding",
      temporal: "Temporal",
      regional: "Regional",
    },
    novelty: {
      fallback: "No comparable prior art was retrieved from the corpus for this case, so Novelty falls back to a neutral 0.5.",
      withData: (closestNo, overlapPct, unmatched, total) =>
        `Closest matched prior art is ${closestNo}, with ${overlapPct}% feature overlap; ${unmatched} of ${total} case features were not found in any of the top-matched prior art.`,
    },
    crowding: {
      formula:
        "Crowding = 1 − percentile rank of (patents before the cutoff matching ≥2 of the case's features) among the hit-counts of every pairwise combination of known technical features.",
      note: (hits, percentile, nPairs) =>
        `${hits} patents before the cutoff match at least 2 of this case's features — that places this combination at the ${percentile}th percentile of crowdedness among ${nPairs} known feature-pair combinations (higher percentile = more crowded, lower score).`,
    },
    regional: {
      note: (target, targetHits, gapTerm, concentrationNote) =>
        `Target jurisdiction ${target} has ${targetHits} matching patents before the cutoff${gapTerm ? " (no matching filing — regional gap)" : ""}, using the same feature-matched set as Crowding (not full patent-family linkage). ${concentrationNote}`,
      concentration: (total, hhi, topApplicant, topSharePct) =>
        total
          ? `Within the matched set (${total} patents), applicant concentration HHI is ${hhi}${topApplicant ? `, led by ${topApplicant} (${topSharePct}% share)` : ""}.`
          : "No patents in the matched set before the cutoff, so applicant concentration falls back to a neutral 0.5.",
    },
    temporal: {
      fallback: "No real per-year publication trend was available for this case, so Temporal falls back to a neutral 0.5.",
      note: (y0, y1, litFirst, litLast, halved, patCount, litCount) =>
        `Real publication counts for ${y0}–${y1} moved from ${litFirst} to ${litLast}${
          halved ? `; matched-set patent filings in the same window (${patCount}) outnumber publications (${litCount}), so the score is halved.` : "."
        }`,
    },
    outOfScope: {
      other: "This document's dominant technology classification falls outside the SDN/NFV/network-slicing scope this tool covers, so no score is computed.",
      insufficient: "Fewer than 2 in-scope technical features were matched in this text, so no score is computed.",
    },
    needsConfirmationYear: "No year could be detected in the text — please provide a publication/filing year to set the cutoff date.",
    needsConfirmationFeatures: "No known technical-feature vocabulary was matched in the text — please add a technical description.",
    errors: {
      missingPatentId: "mode=corpus requires patent_id (the reference patent's publication_number).",
      unknownPatentId: (id) => `No corpus patent found with publication_number = ${id}.`,
      scoringFailed: "The backend failed while computing the patentability score.",
      missingAzureConfig: "Backend is missing Azure OpenAI configuration (AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT).",
      missingMessage: "Missing message/history.",
      azureBadResponse: "Azure OpenAI returned an unexpected response format.",
      azureCallFailed: "The backend failed while calling Azure OpenAI.",
      azureError: (status) => `Azure OpenAI returned an error (${status}).`,
    },
  },
  zh: {
    grade: { high: "高", medium: "中", low: "低" },
    scoreName: "可專利性機會分數（Patentability Opportunity Score, POS）",
    disclaimer: "本分數為根據基準日前檢索資料計算的相對機會分數，並非核准機率預測；進步性判斷仍須專利師確認。",
    factorLabels: {
      novelty: "Novelty 新穎性",
      crowding: "Crowding 擁擠度",
      temporal: "Temporal 時間差",
      regional: "Regional 區域缺口",
    },
    novelty: {
      fallback: "本次未能從語料庫中檢索到可比對的前案，新穎性採中性估計值 0.5。",
      withData: (closestNo, overlapPct, unmatched, total) =>
        `與最接近前案 ${closestNo} 的特徵重疊度 ${overlapPct}%；${total} 項特徵中有 ${unmatched} 項未見於最相關前案中。`,
    },
    crowding: {
      formula: "Crowding = 1 − （基準日前至少符合本案 2 項技術特徵的專利數）在所有已知技術特徵兩兩組合命中數中的百分位排名。",
      note: (hits, percentile, nPairs) =>
        `基準日前至少符合本案 2 項技術特徵的專利有 ${hits} 件——在 ${nPairs} 組已知技術特徵配對的擁擠度分布中位於第 ${percentile} 百分位（百分位越高代表越擁擠，分數越低）。`,
    },
    regional: {
      note: (target, targetHits, gapTerm, concentrationNote) =>
        `目標法域 ${target} 在基準日前有 ${targetHits} 件符合特徵的專利${gapTerm ? "（無對應申請案，region gap）" : ""}，採用與 Crowding 相同的特徵比對集合（非逐案專利家族比對）。${concentrationNote}`,
      concentration: (total, hhi, topApplicant, topSharePct) =>
        total
          ? `比對集合內（${total} 件）申請人集中度 HHI 為 ${hhi}${topApplicant ? `，最大申請人為 ${topApplicant}（占比 ${topSharePct}%）` : ""}。`
          : "比對集合內於基準日前無專利資料，申請人集中度採中性估計值 0.5。",
    },
    temporal: {
      fallback: "本次未能取得真實逐年文獻成長數據，時間差採中性估計值 0.5。",
      note: (y0, y1, litFirst, litLast, halved, patCount, litCount) =>
        `${y0}–${y1} 年間真實文獻篇數由 ${litFirst} 變化至 ${litLast}${
          halved ? `；同期比對集合內專利申請數（${patCount}）多於文獻數（${litCount}），分數折半。` : "。"
        }`,
    },
    outOfScope: {
      other: "此文件的主要技術分類不在本工具涵蓋的 SDN/NFV/network slicing 範圍內，不予計分。",
      insufficient: "文字中比對到的範圍內技術特徵少於 2 項，不予計分。",
    },
    needsConfirmationYear: "無法從文字中偵測到年份，請提供發表／申請年以設定基準日。",
    needsConfirmationFeatures: "文字中未比對到任何已知技術特徵詞彙，請補充技術描述。",
    errors: {
      missingPatentId: "corpus 模式需要 patent_id（母體專利的 publication_number）。",
      unknownPatentId: (id) => `找不到 publication_number = ${id} 的母體專利。`,
      scoringFailed: "後端計算可專利性初判分數時發生錯誤。",
      missingAzureConfig: "後端缺少 Azure OpenAI 設定（AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT）。",
      missingMessage: "缺少 message/history。",
      azureBadResponse: "Azure OpenAI 回應格式異常。",
      azureCallFailed: "後端呼叫 Azure OpenAI 時發生錯誤。",
      azureError: (status) => `Azure OpenAI 回應錯誤（${status}）。`,
    },
  },
};

function t(lang) {
  return STRINGS[lang === "zh" ? "zh" : "en"];
}

module.exports = { t, STRINGS };

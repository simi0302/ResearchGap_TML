/**
 * IPC／CPC 分類號 → 中文技術名稱（對照 WIPO／CPC 常用語意，供儀表板顯示）。
 * 未收錄之細碼會退回 IPC 小類（4 字元）或空字串。
 */

/** 正規化：大寫、去空白，便於比對 */
export function normalizePatentClassSymbol(code: string): string {
  return (code ?? "").replace(/\s+/g, "").toUpperCase();
}

/** IPC 小類：字母 + 兩位數字 + 字母 */
export function extractIpcSubclass(norm: string): string | null {
  const m = norm.match(/^([A-H]\d{2}[A-Z])/i);
  return m ? m[1].toUpperCase() : null;
}

/** IPC 類（三碼，如 G06） */
export function extractIpcClass(norm: string): string | null {
  const m = norm.match(/^([A-HY]\d{2})$/i);
  return m ? m[1].toUpperCase() : null;
}

/** IPC G 部類（三碼）中文概稱 */
const IPC_CLASS_TITLE_ZH: Record<string, string> = {
  G01: "測量；測試",
  G02: "光學",
  G03: "照相；影像",
  G04: "測量儀器",
  G05: "控制；調節",
  G06: "計算；推算",
  G07: "檢驗設備",
  G08: "信號；控制",
  G09: "教育；顯示",
  G10: "樂器；聲學",
  G11: "儲存；記錄",
  G12: "儀器細節",
  G16: "資訊；醫療 ICT",
  G21: "核技術",
};

/** IPC 小類（4 碼）中文概稱 — 擴充常見於 Agentic AI／電信／資安之小類 */
const IPC_SUBCLASS_TITLE_ZH: Record<string, string> = {
  G06N: "計算機學習與神經網路",
  G06F: "電數位資料處理",
  G06Q: "商業方法、資料處理系統或方法",
  G06K: "圖像辨識、資料識別與標識",
  G06T: "影像處理、產生或分析",
  G06V: "影像或影片辨識、理解",
  G10B: "鍵盤樂器、風琴",
  G10C: "鋼琴",
  G10D: "弦樂器",
  G10F: "自動演奏樂器",
  G10G: "樂器表徵、輔助裝置",
  G10H: "電聲樂器、電子合成",
  G10K: "發聲裝置、樂音產生",
  G10L: "語音分析、合成、辨識與編碼",
  G10M: "樂器輔助、調音",
  G10N: "樂譜、記譜",
  G10R: "錄音、再生",
  G10S: "弦樂器細節",
  G10W: "吹奏樂器",
  G16H: "醫療資訊學與數位健康",
  G16B: "生物資訊學",
  G16C: "計算化學、計算生物學",
  G16Y: "資訊與通訊技術之一般標示",
  H04L: "數位資訊傳輸（協定、網路、安全）",
  H04W: "無線通信網路",
  H04N: "影像通信、串流與編碼",
  H04B: "傳輸",
  H04J: "多工通信",
  H04K: "保密通信、干擾與防護",
  H04Q: "交換與選路（傳統電信）",
  H04M: "電話通信",
  G08G: "交通控制與導航系統",
  B60W: "車輛控制與駕駛輔助",
  G05A: "控制閥件",
  G01B: "秤重",
  G01C: "測距、導航與測繪",
  G01D: "機械式測量",
  G01F: "流量、液位與容量測量",
  G01H: "磁場測量",
  G01J: "光強度測量",
  G01K: "溫度測量",
  G01L: "力與功測量",
  G01M: "機械或結構測試",
  G01N: "材料或物質分析",
  G01G: "材料強度試驗",
  G01P: "速度、加速度測量",
  G01R: "電氣變量測量",
  G01S: "雷達、無線電定位",
  G01V: "速度測量",
  G01W: "短時間間隔測量",
  G02A: "多焦點與特殊光學",
  G02B: "光學元件、系統與裝置",
  G02C: "眼鏡與視力矯正光學",
  G02F: "光控裝置與調變",
  G02K: "平面光學與導波",
  G02N: "光波導與導光",
  G03B: "照相設備與相機",
  G03C: "感光材料與化學處理",
  G03D: "照相沖洗設備",
  G03F: "光機械複製與製版",
  G03G: "靜電攝影與影印",
  G03H: "全像攝影",
  G05B: "控制或調節系統",
  G05C: "調節器",
  G05D: "非電變量之控制",
  G05F: "非電量之調節",
  G05G: "機械控制系統",
  G06C: "類比計算（歷史）",
  G06D: "光學計算裝置",
  G06E: "光學邏輯元件",
  G06G: "類比計算機",
  G06J: "混合計算裝置",
  G06M: "計數機構",
  G07A: "時間測量",
  G07B: "加密機構與加密打字",
  G07C: "鐘錶、計時與碼表",
  G07D: "時間的視覺指示",
  G07F: "計數機構、投幣與販賣",
  G07G: "收銀機、點鈔與投幣收費",
  G08B: "信號或呼叫系統、監視",
  G08C: "遙測、遙控",
  G09B: "教育或示範用具",
  G09C: "密碼學（非電子）",
  G09D: "鐵路交通控制",
  G09F: "時間顯示裝置",
  G09G: "視覺顯示之控制",
  G09H: "測量儀器之記錄",
  G09K: "文字辨識之準備",
  G11B: "磁記錄載體與磁碟",
  G11C: "靜態記憶體（半導體儲存）",
  G11D: "光學記錄載體",
  G16F: "資訊檢索與檔案系統",
  H01L: "半導體裝置",
  H04H: "廣播通信",
  H04R: "揚聲器、麥克風",
  H04S: "立體聲系統",
  A61B: "診斷、外科、識別",
  B82Y: "奈米結構與奈米技術",
};

/**
 * 由具體到抽象之前綴對照（長度由程式排序，最長先比對）。
 * 涵蓋生命週期圖例常見碼與 AI／通訊主題。
 */
const PREFIX_TITLE_ZH_RAW: { prefix: string; title: string }[] = [
  { prefix: "G06N20/00", title: "機器學習（基於計算之統計或數學模型）" },
  { prefix: "G06N20", title: "機器學習（模型建構與推論）" },
  { prefix: "G06N99/00", title: "計算機學習之其他主題" },
  { prefix: "G06N7/01", title: "類神經網路之模擬或分析" },
  { prefix: "G06N7/06", title: "類比計算機" },
  { prefix: "G06N7/04", title: "偏微分方程求解" },
  { prefix: "G06N7/02", title: "類比計算裝置" },
  { prefix: "G06N7/00", title: "類比計算與模糊邏輯" },
  { prefix: "G06N5/04", title: "以知識模型為基礎之推論" },
  { prefix: "G06N5/02", title: "知識表徵與專家系統" },
  { prefix: "G06N5/00", title: "以知識為基礎之模型" },
  { prefix: "G06N3/08", title: "類神經網路與學習方法" },
  { prefix: "G06N3/06", title: "物理神經裝置" },
  { prefix: "G06N3/04", title: "架構設定與學習" },
  { prefix: "G06N3/02", title: "類神經網路結構" },
  { prefix: "G06N3/00", title: "以類神經網路為基礎之計算模型" },
  { prefix: "G06N3", title: "類神經網路" },
  { prefix: "G10L15/22", title: "語音辨識（意圖、語意、說話者）" },
  { prefix: "G10L15/18", title: "語音分類或語音搜尋" },
  { prefix: "G10L15/16", title: "語音增強與雜訊抑制" },
  { prefix: "G10L15/10", title: "語音分析與特徵擷取" },
  { prefix: "G10L15/06", title: "語音產生與合成" },
  { prefix: "G10L15/02", title: "語音壓縮與編碼" },
  { prefix: "G10L15/00", title: "語音辨識與分析" },
  { prefix: "G10L15", title: "語音辨識與語音技術" },
  { prefix: "G10L25/30", title: "語音或聲音事件分類" },
  { prefix: "G10L25/00", title: "語音或聲音分析" },
  { prefix: "G10L17/00", title: "語音安全與防偽" },
  { prefix: "G10L13/00", title: "語音合成" },
  { prefix: "G10L25", title: "語音／聲音分析" },
  { prefix: "H04L9/40", title: "保密或安全通信（金鑰、認證、協定）" },
  { prefix: "H04L9/32", title: "密碼裝置與金鑰管理" },
  { prefix: "H04L9/08", title: "密鑰分配與金鑰協商" },
  { prefix: "H04L9/00", title: "保密或安全通信" },
  { prefix: "H04L9", title: "通信安全與密碼" },
  { prefix: "H04L67/00", title: "網路應用層協定與 API（含雲端／分散式）" },
  { prefix: "H04L63/00", title: "網路安全監控與威脅防護" },
  { prefix: "H04L61/00", title: "網路位址與名稱解析" },
  { prefix: "H04L41/00", title: "網路管理、設定與編排" },
  { prefix: "H04L12/00", title: "資料交換網路（區域網、交換）" },
  { prefix: "H04L29/00", title: "通信協定與控制（分層協定）" },
  { prefix: "H04L51/00", title: "物聯網通信與裝置聯網" },
  { prefix: "G06F3/16", title: "聲音、影像、觸控等之人機輸入輸出" },
  { prefix: "G06F3/01", title: "輸入裝置與互動介面" },
  { prefix: "G06F3/00", title: "輸入輸出至／自計算機" },
  { prefix: "G06F21/60", title: "身分認證、存取控制與權限" },
  { prefix: "G06F21/57", title: "安全監控與稽核" },
  { prefix: "G06F21/55", title: "資料執行防護與沙箱" },
  { prefix: "G06F21/62", title: "惡意程式防護" },
  { prefix: "G06F21/00", title: "電腦系統安全與防護" },
  { prefix: "G06F16/9535", title: "搜尋引擎與排序（含語意檢索）" },
  { prefix: "G06F16/953", title: "查詢處理與索引" },
  { prefix: "G06F16/90", title: "資料庫管理與維護" },
  { prefix: "G06F16/35", title: "資料摘要與集群" },
  { prefix: "G06F16/33", title: "向量與結構化查詢" },
  { prefix: "G06F16/00", title: "檔案系統與資料庫結構" },
  { prefix: "G06F40/00", title: "自然語言處理與文字處理" },
  { prefix: "G06F40/30", title: "機器翻譯與跨語言處理" },
  { prefix: "G06F40/205", title: "語意分析與句法分析" },
  { prefix: "G06F40/279", title: "對話與聊天機器人介面" },
  { prefix: "G06F8/00", title: "軟體工程與程式設計支援" },
  { prefix: "G06F8/41", title: "程式碼產生與重構" },
  { prefix: "G06F8/70", title: "軟體測試與除錯" },
  { prefix: "G06F9/50", title: "資源配置、排程與雲端運算" },
  { prefix: "G06F9/455", title: "虛擬化與容器" },
  { prefix: "G06F9/44", title: "程式介面與使用者介面框架" },
  { prefix: "G06F9/45", title: "程式執行控制與中間件" },
  { prefix: "G06F11/00", title: "錯誤偵測、監控與可靠性" },
  { prefix: "G06F11/34", title: "效能監控與日誌" },
  { prefix: "G06Q10/10", title: "辦公自動化、工作流與協作" },
  { prefix: "G06Q10/00", title: "行政、商業、財務之資料處理" },
  { prefix: "G06Q20/00", title: "電子商務與支付" },
  { prefix: "G06Q30/00", title: "行銷、定價與客戶關係" },
  { prefix: "G06Q40/00", title: "金融、保險與稅務" },
  { prefix: "G06Q50/00", title: "特定產業之商業系統" },
  { prefix: "G06V10/82", title: "影像辨識與特徵學習" },
  { prefix: "G06V10/00", title: "影像或影片特徵擷取" },
  { prefix: "G06V20/00", title: "場景理解與監控影像分析" },
  { prefix: "G06K19/077", title: "RFID／近場通信" },
  { prefix: "G06K19/07", title: "導電標記載體" },
  { prefix: "G06K19/06", title: "磁性記錄載體" },
  { prefix: "G06K19/00", title: "印刷電路與連接" },
  { prefix: "G06K9/82", title: "影像物件辨識" },
  { prefix: "G06K9/80", title: "物件辨識" },
  { prefix: "G06K9/76", title: "場景辨識" },
  { prefix: "G06K9/74", title: "交通標誌辨識" },
  { prefix: "G06K9/72", title: "簽名辨識" },
  { prefix: "G06K9/70", title: "圖形、圖表辨識" },
  { prefix: "G06K9/68", title: "圖樣或特徵辨識" },
  { prefix: "G06K9/66", title: "機讀碼讀取" },
  { prefix: "G06K9/62", title: "字元辨識" },
  { prefix: "G06K9/60", title: "圖形化輸入介面" },
  { prefix: "G06K9/52", title: "電磁讀取" },
  { prefix: "G06K9/50", title: "光學字元辨識" },
  { prefix: "G06K9/46", title: "指紋辨識" },
  { prefix: "G06K9/40", title: "指紋、掌紋" },
  { prefix: "G06K9/32", title: "衛星影像" },
  { prefix: "G06K9/20", title: "生物特徵辨識" },
  { prefix: "G06K9/00", title: "圖像辨識與讀取" },
  { prefix: "G06K7/10", title: "浮凸字元讀取" },
  { prefix: "G06K7/00", title: "機械輸入" },
  { prefix: "G06T7/00", title: "影像分析與比對" },
  { prefix: "G06T11/00", title: "2D 繪圖與視覺化" },
  { prefix: "G06T19/00", title: "三維建模與虛擬實境" },
  { prefix: "G01V99/00", title: "速度測量（其他）" },
  { prefix: "G01V20/00", title: "流體速度測量" },
  { prefix: "G01V1/00", title: "固體速度測量" },
  { prefix: "G01S17/00", title: "光達（LiDAR）系統" },
  { prefix: "G01S13/00", title: "雷達探測" },
  { prefix: "G01N21/00", title: "光學材料分析" },
  { prefix: "G01N33/00", title: "化學分析" },
  { prefix: "G01B5/00", title: "秤重測量" },
  { prefix: "G01D4/00", title: "機械測量機構" },
  { prefix: "G01C15/00", title: "攝影測量" },
  { prefix: "G01C15", title: "攝影測量" },
  { prefix: "G01C21/00", title: "導航與定位" },
  { prefix: "G02B27/00", title: "光學系統或裝置" },
  { prefix: "G02B13/00", title: "光學物鏡" },
  { prefix: "G02B6/00", title: "光導纖維與光波導" },
  { prefix: "G02B5/00", title: "光學元件（稜鏡、反射鏡等）" },
  { prefix: "G02B17/00", title: "成像光學系統" },
  { prefix: "G02F1/00", title: "光控與調變元件" },
  { prefix: "G03G15/00", title: "影印與複印機" },
  { prefix: "G03G21/00", title: "靜電影像製程" },
  { prefix: "G03F7/00", title: "光刻與微影" },
  { prefix: "G03B15/00", title: "相機機身與光學" },
  { prefix: "G03B7/00", title: "曝光控制" },
  { prefix: "G03C1/00", title: "感光材料" },
  { prefix: "G03H1/00", title: "全像攝影記錄" },
  { prefix: "G05B19/00", title: "程式控制與 PLC" },
  { prefix: "G05B13/00", title: "自適應控制" },
  { prefix: "G05B11/00", title: "數位控制" },
  { prefix: "G05D23/00", title: "溫度控制" },
  { prefix: "G05D13/00", title: "速度控制" },
  { prefix: "G05D11/00", title: "位置控制" },
  { prefix: "G07G5/00", title: "點鈔與紙幣計數" },
  { prefix: "G07G3/00", title: "收銀機與銷售登記" },
  { prefix: "G07G1/00", title: "硬幣分揀與處理" },
  { prefix: "G07F7/00", title: "投幣式遊戲或販賣" },
  { prefix: "G07C5/00", title: "電子鐘錶與計時" },
  { prefix: "G07C3/00", title: "碼表與計時器" },
  { prefix: "G09G5/14", title: "觸控式顯示控制" },
  { prefix: "G09G5/00", title: "顯示裝置一般控制" },
  { prefix: "G09G3/00", title: "彩色顯示控制" },
  { prefix: "G09G1/00", title: "向量顯示控制" },
  { prefix: "G09B19/00", title: "示範模型與教具" },
  { prefix: "G09B7/00", title: "電化教學裝置" },
  { prefix: "G09B5/00", title: "教學或示範用具" },
  { prefix: "G09C3/00", title: "編碼與加密方法" },
  { prefix: "G09C1/00", title: "密碼學方法" },
  { prefix: "G11C29/00", title: "記憶體位址解碼與陣列" },
  { prefix: "G11C16/00", title: "組合式記憶體結構" },
  { prefix: "G11C13/00", title: "正反器型記憶體" },
  { prefix: "G11C11/00", title: "記憶體單元結構" },
  { prefix: "G11C7/00", title: "記憶體定址與位址" },
  { prefix: "G11C5/00", title: "記憶體讀寫與抹除" },
  { prefix: "G11B20/00", title: "磁碟記錄載體" },
  { prefix: "G16H80/00", title: "疫情或爆發事件管理" },
  { prefix: "G16H70/00", title: "醫療影像診斷與分析" },
  { prefix: "G16H50/30", title: "醫療資訊安全與隱私" },
  { prefix: "G16H50/20", title: "臨床決策支援與 AI 診斷輔助" },
  { prefix: "G16H50/08", title: "醫療照護網路與協作" },
  { prefix: "G16H50/00", title: "醫療資料處理與健康分析" },
  { prefix: "G16H40/00", title: "病歷與醫療檔案管理" },
  { prefix: "G16H30/00", title: "病患資料處理與隱私" },
  { prefix: "G16H20/00", title: "治療與健康管理 ICT" },
  { prefix: "G16H10/00", title: "醫療狀況評估與預測" },
  { prefix: "G16B30/00", title: "生物序列比對與分析" },
  { prefix: "G16B20/00", title: "基因體與變異分析" },
  { prefix: "G16C20/00", title: "分子模擬與動力學" },
  { prefix: "G16C10/00", title: "化學結構建模與對接" },
  { prefix: "G16F16/00", title: "資訊檢索與查詢系統" },
  { prefix: "G16Y10/00", title: "ICT 一般標示與語意" },
  { prefix: "H04W4/00", title: "行動應用服務與裝置管理" },
  { prefix: "H04W12/00", title: "無線網路安全" },
  { prefix: "H04W24/00", title: "無線網路監控與最佳化" },
  { prefix: "H04W72/00", title: "無線資源分配與排程" },
  { prefix: "H04W76/00", title: "連線管理與 5G 核心網" },
  { prefix: "H04W60/00", title: "訂戶與裝置註冊" },
  { prefix: "G05B19/042", title: "程式控制與 PLC" },
  { prefix: "G05B13/02", title: "自適應控制與最佳化控制" },
  { prefix: "G06N7/00", title: "類比計算與模糊邏輯" },
  { prefix: "G06N10/00", title: "量子計算模型與演算法" },
  { prefix: "G06N5", title: "以知識為基礎之模型" },
  { prefix: "G06N7", title: "類比／模糊計算" },
  { prefix: "G06N10", title: "量子計算" },
  { prefix: "G06N99", title: "計算機學習其他" },
  { prefix: "G06N", title: "計算機學習與神經網路" },
  { prefix: "G10L", title: "語音技術與語言信號處理" },
  { prefix: "H04L", title: "數位資訊傳輸與網路" },
  { prefix: "H04W", title: "無線通信" },
  { prefix: "H04N", title: "影像與串流通信" },
  { prefix: "G06F", title: "電數位資料處理" },
  { prefix: "G06Q", title: "商業資料處理" },
  { prefix: "G06K", title: "圖像辨識與資料識別" },
  { prefix: "G06T", title: "影像運算與圖形" },
  { prefix: "G06V", title: "電腦視覺" },
  { prefix: "G16H", title: "醫療資訊學" },
];

const PREFIX_TITLE_ZH_SORTED = [...PREFIX_TITLE_ZH_RAW].sort(
  (a, b) => b.prefix.length - a.prefix.length,
);

/** IPC 大部中文概稱（細碼未建檔時之兜底） */
const WIPO_SECTION_TITLE_ZH: Record<string, string> = {
  A: "IPC A 部：生活必需品",
  B: "IPC B 部：作業、運輸",
  C: "IPC C 部：化學、冶金",
  D: "IPC D 部：紡織、紙張",
  E: "IPC E 部：固定建築物",
  F: "IPC F 部：機械工程、照明、熱工",
  G: "IPC G 部：物理（含運算、量測）",
  H: "IPC H 部：電學（含通信）",
};

/**
 * 三階細部 IPC 主組中文：最長前綴對照；若僅對到小類通稱，附加「（主組編號）」區分。
 */
export function getIpcSubgroupTitleZh(displayCode: string): string {
  const raw = (displayCode ?? "").trim().split("（")[0].trim();
  const n = normalizePatentClassSymbol(raw);
  if (!n) return "";
  let matchedPrefix = "";
  let title = "";
  for (const { prefix, title: t } of PREFIX_TITLE_ZH_SORTED) {
    if (n.startsWith(prefix)) {
      matchedPrefix = prefix;
      title = t;
      break;
    }
  }
  if (!title) {
    const sub = extractIpcSubclass(n);
    if (sub && IPC_SUBCLASS_TITLE_ZH[sub]) {
      title = IPC_SUBCLASS_TITLE_ZH[sub];
    }
  }
  if (!title) return "";
  const tailM = raw.match(/(\d+\/\d+)/);
  const tail = tailM?.[1];
  const prefixTail = matchedPrefix.match(/(\d+\/\d+)/)?.[1] ?? "";
  if (tail && n.length > matchedPrefix.length && tail !== prefixTail) {
    return `${title}（${tail}）`;
  }
  if (tail && !matchedPrefix && title) {
    return `${title}（${tail}）`;
  }
  return title;
}

/** 取得中文技術名稱（無則回空字串） */
export function getPatentClassificationTitleZh(code: string): string {
  const n = normalizePatentClassSymbol(code);
  if (!n) return "";
  for (const { prefix, title } of PREFIX_TITLE_ZH_SORTED) {
    if (n.startsWith(prefix)) return title;
  }
  const cls = extractIpcClass(n);
  if (cls && IPC_CLASS_TITLE_ZH[cls]) return IPC_CLASS_TITLE_ZH[cls];
  const sub = extractIpcSubclass(n);
  if (sub && IPC_SUBCLASS_TITLE_ZH[sub]) return IPC_SUBCLASS_TITLE_ZH[sub];
  const sec = n[0]?.toUpperCase();
  if (sec && WIPO_SECTION_TITLE_ZH[sec]) return WIPO_SECTION_TITLE_ZH[sec];
  return "";
}

/** 圖表軸／圖例：僅顯示主題中文名（過長截斷）；無對照時顯示原分類號 */
export function patentClassThemeLabel(code: string, maxLen = 28): string {
  const raw = (code ?? "").trim();
  if (!raw) return "";
  const t = getPatentClassificationTitleZh(raw);
  const s = t || raw;
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

/** ECharts rich：分類號（上）＋主題（下），字體加大 */
export const PATENT_CLASS_AXIS_RICH: Record<string, object> = {
  pcode: {
    fontSize: 12,
    lineHeight: 18,
    fontFamily: "ui-monospace, Consolas, monospace",
    color: "#0f172a",
    fontWeight: 700,
    padding: [0, 0, 2, 0],
  },
  ptheme: {
    fontSize: 13,
    lineHeight: 20,
    color: "#334155",
    fontWeight: 600,
  },
};

/** 網路圖節點內標籤（與軸分開樣式名 gcode / gtheme） */
export const PATENT_CLASS_GRAPH_NODE_RICH: Record<string, object> = {
  gcode: {
    fontSize: 11,
    lineHeight: 16,
    fontFamily: "ui-monospace, Consolas, monospace",
    color: "#ffffff",
    fontWeight: 800,
    textShadowColor: "rgba(15,23,42,0.55)",
    textShadowBlur: 3,
    textShadowOffsetY: 1,
  },
  gtheme: {
    fontSize: 11,
    lineHeight: 16,
    color: "#f1f5f9",
    fontWeight: 600,
    textShadowColor: "rgba(15,23,42,0.45)",
    textShadowBlur: 2,
    textShadowOffsetY: 1,
  },
};

/** ECharts rich 字面量跳脫 */
export function escapeEchartsRichLiteral(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\|/g, "\\|");
}

/** 兩行 rich：分類號 + 主題 */
export function patentClassAxisRichTwoLines(code: string, themeMaxLen = 42): string {
  const raw = (code ?? "").trim();
  if (!raw) return "";
  const escCode = escapeEchartsRichLiteral(raw);
  const theme = getPatentClassificationTitleZh(raw);
  if (!theme || theme === raw) return `{pcode|${escCode}}`;
  const t0 = theme.length > themeMaxLen ? `${theme.slice(0, themeMaxLen)}…` : theme;
  return `{pcode|${escCode}}\n{ptheme|${escapeEchartsRichLiteral(t0)}}`;
}

/** 網路圖節點兩行 rich */
export function patentClassGraphRichTwoLines(code: string, themeMaxLen = 24): string {
  const raw = (code ?? "").trim();
  if (!raw) return "";
  const escCode = escapeEchartsRichLiteral(raw);
  const theme = getPatentClassificationTitleZh(raw);
  if (!theme || theme === raw) return `{gcode|${escCode}}`;
  const t0 = theme.length > themeMaxLen ? `${theme.slice(0, themeMaxLen)}…` : theme;
  return `{gcode|${escCode}}\n{gtheme|${escapeEchartsRichLiteral(t0)}}`;
}

/** Tooltip：主題加粗，分類號灰字（供稽核） */
export function patentClassTooltipHtml(code: string, themeMaxLen = 36): string {
  const raw = (code ?? "").trim();
  if (!raw) return "";
  const theme = patentClassThemeLabel(raw, themeMaxLen);
  if (theme === raw) return `<b>${raw}</b>`;
  return `<b>${theme}</b><br/><span style="color:#94a3b8;font-size:11px;font-family:ui-monospace,monospace">${raw}</span>`;
}

/** 「分類號 · 中文名」單行顯示 */
export function formatPatentClassWithTitle(code: string, sep = " · "): string {
  const raw = (code ?? "").trim();
  if (!raw) return "";
  const t = getPatentClassificationTitleZh(raw);
  return t ? `${raw}${sep}${t}` : raw;
}

/** 純文字兩行軸標（無 rich 處備用）：分類號換行主題 */
export function formatPatentClassAxisLabel(code: string, _maxLen?: number): string {
  const raw = (code ?? "").trim();
  if (!raw) return "";
  const t = getPatentClassificationTitleZh(raw);
  if (!t || t === raw) return raw;
  return `${raw}\n${t}`;
}

/** 列表／CSV：多個 IPC 以分號連結並附名稱 */
export function formatIpcListForDisplay(ipcList: string[]): string {
  return ipcList.map(c => formatPatentClassWithTitle(c, "：")).join("； ");
}

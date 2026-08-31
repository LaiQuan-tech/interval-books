/**
 * Excel 匯入的**解析**那一半 —— 全部在瀏覽器裡跑，不碰網路也不碰資料庫。
 *
 * ── 為什麼解析留在 client，寫入卻一定走 server ────────────────────────────
 * 讀一個 .xlsx 是純檔案處理：把 bytes 變成二維陣列，猜欄位對應，去重。這些事沒有
 * 一件需要資料庫，把 1MB 的檔案上傳只為了讓伺服器做同一件事沒有意義。
 *
 * 但**寫入**是另一回事。來源是「前端 for 迴圈，每一列各兩三次 supabase 呼叫」，
 * 也就是瀏覽器直接寫資料庫；搬過來之後那條路不存在（瀏覽器拿不到 service_role，
 * inv 也不在 PostgREST 上），而且也不該存在 —— 1,000 列就是 2,000 次請求，中途
 * 網路斷掉留下一半的商品跟對不上的進貨。所以這個檔案的產物是一份**資料**，
 * 交給 importProducts() 那一支 server fn 一次寫完，一個交易。
 *
 * ⚠️ xlsx 一定要在呼叫端 dynamic import。它有 Node 專屬的分支，SSR 端靜態 import
 *    會炸（與 html5-qrcode 同一條規矩）。這個檔案本身不 import xlsx，只吃它吐出來
 *    的二維陣列，所以它可以被靜態 import。
 */

/** 對應到 inv.products 的九個可匯入欄位。值是 Excel 的欄索引字串，或 UNMAPPED。 */
export type ColumnMapping = {
  name: string;
  issue_number: string;
  barcode: string;
  selling_price: string;
  cost_price: string;
  quantity: string;
  series: string;
  publisher: string;
  notes: string;
};

export const UNMAPPED = "-1";

export const FIELD_LABELS: Record<keyof ColumnMapping, string> = {
  name: "商品名稱 *",
  issue_number: "期數",
  barcode: "條碼",
  selling_price: "售價",
  cost_price: "進貨價",
  quantity: "數量",
  series: "系列",
  publisher: "出版社",
  notes: "備註",
};

export const EMPTY_MAPPING: ColumnMapping = {
  name: UNMAPPED,
  issue_number: UNMAPPED,
  barcode: UNMAPPED,
  selling_price: UNMAPPED,
  cost_price: UNMAPPED,
  quantity: UNMAPPED,
  series: UNMAPPED,
  publisher: UNMAPPED,
  notes: UNMAPPED,
};

/** 每個欄位的候選標題，**依優先序**排列（越前面分數越高）。與來源一致。 */
// prettier-ignore —— 這是一張「欄位名同義詞」對照表，一個欄位一行才讀得懂。
// 讓 prettier 展開的話會變成一個字串一行（+91 行），既難讀，也會把這個檔案
// 推過 inventory-products-selftest 的 300 行上限。
// prettier-ignore
const FIELD_PATTERNS: Record<keyof ColumnMapping, string[]> = {
  name: ["書名", "商品名", "品名", "名稱", "產品名", "書籍名", "刊物名", "標題", "title", "name", "product", "item", "商品", "書"],
  issue_number: ["期數", "期號", "期", "issue", "no.", "vol", "卷", "號", "冊", "集", "number", "edition", "版次"],
  barcode: ["條碼", "isbn", "barcode", "書籍條碼", "商品條碼", "ean", "upc", "國際書碼", "國際碼", "code", "編碼", "產品編號"],
  selling_price: ["定價", "售價", "單價", "價格", "零售價", "銷售價", "price", "retail", "sell", "賣價", "標價"],
  cost_price: ["成本", "進貨價", "進價", "成本價", "批發價", "採購價", "cost", "purchase", "wholesale", "供貨價", "入貨價"],
  quantity: ["數量", "庫存", "存量", "進貨數", "入庫數", "冊數", "本數", "qty", "quantity", "stock", "amount", "count", "數"],
  series: ["系列", "叢書", "套書", "series", "collection", "書系"],
  publisher: ["出版", "出版社", "發行", "發行商", "書商", "供應商", "publisher", "vendor", "supplier", "廠商"],
  notes: ["備註", "說明", "附註", "註記", "notes", "remark", "comment", "memo", "其他"],
};

function normalise(s: string) {
  return s.toLowerCase().replace(/[\s_\-.]/g, "");
}

/** 三段式評分：完全相同 > 包含 > 中文逐字重疊 6 成。與來源一致。 */
function score(header: string, patterns: string[]): number {
  const h = normalise(header);
  if (!h) return 0;

  for (let i = 0; i < patterns.length; i += 1) {
    if (h === normalise(patterns[i])) return 1000 - i;
  }
  for (let i = 0; i < patterns.length; i += 1) {
    const p = normalise(patterns[i]);
    if (p && (h.includes(p) || p.includes(h))) return 500 - i;
  }
  for (let i = 0; i < patterns.length; i += 1) {
    const p = patterns[i].toLowerCase();
    const hits = [...p].filter((ch) => h.includes(ch)).length;
    if (hits >= p.length * 0.6) return 100 - i + hits;
  }
  return 0;
}

/**
 * 猜欄位對應。
 *
 * 衝突解決是「分數高的先搶」：一個 Excel 欄不會同時被指派給兩個欄位。這件事有
 * 實際後果 —— 「供應商」同時命中 publisher 與（來源沒有但常見的）vendor，先搶先贏
 * 讓結果是穩定的，而不是取決於 Object.keys 的順序。
 */
export function autoMapColumns(headers: string[]): ColumnMapping {
  const best: { field: keyof ColumnMapping; index: number; score: number }[] = [];

  for (const field of Object.keys(FIELD_PATTERNS) as (keyof ColumnMapping)[]) {
    let bestIndex = -1;
    let bestScore = 0;
    headers.forEach((header, index) => {
      const s = score(header, FIELD_PATTERNS[field]);
      if (s > bestScore) {
        bestScore = s;
        bestIndex = index;
      }
    });
    if (bestScore > 0) best.push({ field, index: bestIndex, score: bestScore });
  }

  best.sort((a, b) => b.score - a.score);

  const mapping = { ...EMPTY_MAPPING };
  const used = new Set<number>();
  for (const entry of best) {
    if (used.has(entry.index)) continue;
    used.add(entry.index);
    mapping[entry.field] = String(entry.index);
  }
  return mapping;
}

export type ParsedRow = {
  /** React key 用。不會送到 server。 */
  key: string;
  name: string;
  issue_number: string | null;
  barcode: string | null;
  series: string | null;
  publisher: string | null;
  notes: string | null;
  selling_price: number;
  cost_price: number | null;
  quantity: number;
  existing_product_id: string | null;
  existing_name: string | null;
  selected: boolean;
};

export type SkippedRow = { rowNumber: number; reason: string; raw: string };

export type ParseResult = {
  rows: ParsedRow[];
  skipped: SkippedRow[];
  mergedCount: number;
};

/** 比對用的既有商品（只需要這四欄）。 */
export type ExistingProduct = {
  inv_product_id: string;
  name: string;
  issue_number: string | null;
  barcode: string | null;
  series: string | null;
};

const lower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * 兩列是不是同一件東西。五級優先序，與來源逐條一致：
 *   1. 條碼相同（兩邊都要有條碼）
 *   2. 名稱 + 期數 + 系列 全同
 *   3. 名稱 + 系列（兩邊都沒有期數）
 *   4. 名稱 + 期數（兩邊都沒有系列）
 *   5. 名稱（兩邊都沒有期數也沒有系列）
 *
 * 第 5 級是刻意保守的：只要有一邊填了期數或系列就不會走到它，否則「地味手帖」
 * 的 15 期與 16 期會被當成同一件東西合併掉。
 */
function sameItem(
  a: { name: string; issue_number: string | null; barcode: string | null; series: string | null },
  b: { name: string; issue_number: string | null; barcode: string | null; series: string | null },
): boolean {
  if (a.barcode && b.barcode) return lower(a.barcode) === lower(b.barcode);
  if (lower(a.name) !== lower(b.name)) return false;

  const aIssue = lower(a.issue_number);
  const bIssue = lower(b.issue_number);
  const aSeries = lower(a.series);
  const bSeries = lower(b.series);

  if (aIssue && bIssue && aSeries && bSeries) return aIssue === bIssue && aSeries === bSeries;
  if (aSeries && bSeries && !aIssue && !bIssue) return aSeries === bSeries;
  if (aIssue && bIssue && !aSeries && !bSeries) return aIssue === bIssue;
  return !aIssue && !bIssue && !aSeries && !bSeries;
}

/**
 * 把二維陣列 + 欄位對應變成可以送出的列。
 *
 * ⚠️ 既有商品的比對是 O(n×m)，檔內去重是 O(n²)。2,000 列上限（與
 *    inv_import_products() 的 IMPORT_TOO_MANY 對齊）讓最糟情況仍在幾百毫秒內，
 *    而且它跑在瀏覽器裡不佔伺服器。真的要匯入更多列的話該分批，不是把上限拉高。
 */
export function parseRows(
  rawRows: unknown[][],
  mapping: ColumnMapping,
  existing: ExistingProduct[],
): ParseResult {
  const cell = (row: unknown[], field: keyof ColumnMapping): string => {
    const index = mapping[field];
    if (index === UNMAPPED || index === "") return "";
    return String(row[Number(index)] ?? "").trim();
  };

  const parsed: ParsedRow[] = [];
  const skipped: SkippedRow[] = [];
  let mergedCount = 0;

  rawRows.forEach((row, index) => {
    const name = cell(row, "name");
    if (!name) {
      const raw = row.slice(0, 3).filter(Boolean).join(" | ") || "(空白行)";
      skipped.push({
        // +2 = 陣列從 0 開始，而且第 1 列是標題列。使用者看到的是 Excel 的行號。
        rowNumber: index + 2,
        reason: "商品名稱為空",
        raw: raw.length > 50 ? `${raw.slice(0, 50)}…` : raw,
      });
      return;
    }

    const issue = cell(row, "issue_number");
    const barcode = cell(row, "barcode");
    const series = cell(row, "series");
    const candidate = {
      name,
      issue_number: issue || null,
      barcode: barcode || null,
      series: series || null,
    };

    const dup = parsed.find((p) => sameItem(p, candidate));
    const quantity = Number.parseInt(cell(row, "quantity"), 10);
    const qty = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;

    if (dup) {
      // 來源的行為：重複的不丟掉，數量加起來。一份進貨單同一本書出現兩次通常是
      // 兩箱，不是打錯。
      dup.quantity += qty;
      mergedCount += 1;
      return;
    }

    const price = Number.parseFloat(cell(row, "selling_price"));
    const cost = Number.parseFloat(cell(row, "cost_price"));
    const match = existing.find((e) =>
      sameItem(
        {
          name: e.name,
          issue_number: e.issue_number,
          barcode: e.barcode,
          series: e.series,
        },
        candidate,
      ),
    );

    parsed.push({
      key: `${index}-${barcode || name}-${issue}`,
      ...candidate,
      publisher: cell(row, "publisher") || null,
      notes: cell(row, "notes") || null,
      // 來源用 `parseFloat(x) || 0`，所以空字串與 NaN 都變成 0。這裡一樣，但
      // 成本區分 null（沒填，不要動既有成本）與 0（真的是 0）。
      selling_price: Number.isFinite(price) && price > 0 ? price : 0,
      cost_price: Number.isFinite(cost) && cost >= 0 ? cost : null,
      quantity: qty,
      existing_product_id: match?.inv_product_id ?? null,
      existing_name: match?.name ?? null,
      selected: true,
    });
  });

  return { rows: parsed, skipped, mergedCount };
}

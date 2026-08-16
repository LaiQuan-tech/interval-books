/**
 * 進貨 Excel 匯入的**解析**那一半 —— 全部在瀏覽器裡跑，不碰網路也不碰資料庫。
 *
 * 與 lib/admin/excel-import.ts 同一條分工：解析留在 client，**寫入只有
 * importPurchases() 這一條路**（整批一個交易）。理由寫在那個檔案的檔頭。
 *
 * ── 與來源的兩個差別 ──────────────────────────────────────────────────────
 * 1. 來源對「名稱與條碼都空」「數量空」「數量不是正數」三種列直接 `return`（靜默
 *    丟掉，匯完只說「成功 N 筆」）。這裡每一列被丟掉都帶著行號、原因與原始內容。
 * 2. 來源的自動對應是 if/else 鏈，「效期警示天數」會先被「效期」吃掉。這裡改成
 *    評分制 + 高分先搶，完全相同的標題永遠贏過只是包含的。
 */
import { UNMAPPED } from "@/lib/admin/excel-import";
import { INV_PRODUCT_TYPES, INV_PRODUCT_TYPE_LABELS } from "@/lib/admin/schemas";
import type { ProductPickerRow } from "@/server/repos/inv-purchases";

type ProductType = (typeof INV_PRODUCT_TYPES)[number];

/** 對應到 inv.purchases（與新建商品）的十三個可匯入欄位。 */
export const PURCHASE_FIELD_LABELS = {
  name: "商品名稱 *",
  issue_number: "期數",
  series: "系列",
  barcode: "條碼",
  quantity: "數量 *",
  unit_cost: "單價成本",
  vendor: "供應商",
  purchase_date: "進貨日期",
  notes: "備註",
  expiry_date: "保存期限",
  expiry_alert_days: "效期警示天數",
  product_type: "商品類型",
  category_name: "分類",
} as const;

/** 值是 Excel 的欄索引字串，或 UNMAPPED。 */
export type PurchaseColumnMapping = Record<keyof typeof PURCHASE_FIELD_LABELS, string>;
export const EMPTY_PURCHASE_MAPPING = Object.fromEntries(
  Object.keys(PURCHASE_FIELD_LABELS).map((k) => [k, UNMAPPED]),
) as PurchaseColumnMapping;

/** 候選標題，依優先序排列（越前面分數越高）。 */
const PATTERNS: Record<keyof PurchaseColumnMapping, string[]> = {
  name: ["商品名稱", "書名", "商品名", "品名", "名稱", "產品名", "title", "name", "item"],
  issue_number: ["期數", "期號", "issue", "vol", "卷", "號", "冊", "集"],
  series: ["系列", "叢書", "套書", "series", "collection", "書系"],
  barcode: ["條碼", "isbn", "barcode", "ean", "商品條碼", "國際書碼"],
  quantity: ["進貨數量", "數量", "進貨數", "入庫數", "冊數", "本數", "qty", "quantity"],
  unit_cost: ["單價成本", "單價", "成本", "進貨價", "進價", "成本價", "cost", "批發價"],
  vendor: ["供應商", "廠商", "vendor", "supplier", "書商", "經銷商"],
  purchase_date: ["進貨日期", "進貨日", "purchasedate", "日期", "date"],
  notes: ["備註", "說明", "附註", "註記", "notes", "remark", "memo"],
  expiry_date: ["保存期限", "有效期限", "效期", "到期日", "expiry", "expire"],
  expiry_alert_days: ["效期警示天數", "警示天數", "提醒天數", "提前提醒", "alertdays", "alert"],
  product_type: ["商品類型", "類型", "type"],
  category_name: ["分類", "類別", "category"],
};

const normalise = (s: string) => s.toLowerCase().replace(/[\s_\-.]/g, "");

/** 完全相同 > 包含。分數帶上優先序，同分時排在前面的候選字贏。 */
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
  return 0;
}

/**
 * 猜欄位對應。高分先搶，一個 Excel 欄不會同時被指派給兩個欄位 ——「效期警示天數」
 * 對 expiry_alert_days 是完全相同（1000）、對 expiry_date 只是包含「效期」（499），
 * 所以來源那個「警示天數被當成效期」的 bug 在這裡不會發生。
 */
export function autoMapPurchaseColumns(headers: string[]): PurchaseColumnMapping {
  const best: { field: keyof PurchaseColumnMapping; index: number; score: number }[] = [];

  for (const field of Object.keys(PATTERNS) as (keyof PurchaseColumnMapping)[]) {
    let bestIndex = -1;
    let bestScore = 0;
    headers.forEach((header, index) => {
      const s = score(header, PATTERNS[field]);
      if (s > bestScore) {
        bestScore = s;
        bestIndex = index;
      }
    });
    if (bestScore > 0) best.push({ field, index: bestIndex, score: bestScore });
  }

  best.sort((a, b) => b.score - a.score);
  const mapping = { ...EMPTY_PURCHASE_MAPPING };
  const used = new Set<number>();
  for (const entry of best) {
    if (used.has(entry.index)) continue;
    used.add(entry.index);
    mapping[entry.field] = String(entry.index);
  }
  return mapping;
}

/**
 * 各種寫法的日期 → YYYY-MM-DD，認不出來回 null。⚠️ 不用 toISOString() 把「現在」
 * 轉成日期：那是 UTC，台北晚上八點之後會差一天。這裡只做字串與 UTC 分量運算。
 */
export function toIsoDate(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;

  // Excel 的日期序號（1900 系統，含那個著名的閏年 bug）。
  if (/^\d{5}$/.test(text)) {
    return new Date(Date.UTC(1899, 11, 30) + Number(text) * 86_400_000).toISOString().slice(0, 10);
  }

  const m = text.replace(/[/.]/g, "-").match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 中文標籤或代碼 → product_type。認不出來回 null（讓 server 用它的預設）。 */
export function toProductType(raw: string): ProductType | null {
  const t = raw.trim();
  if (!t) return null;
  if ((INV_PRODUCT_TYPES as readonly string[]).includes(t)) return t as ProductType;
  const hit = INV_PRODUCT_TYPES.find((c) => INV_PRODUCT_TYPE_LABELS[c].startsWith(t));
  return hit ?? null;
}

export type ParsedPurchaseRow = {
  /** React key。不會送到 server。 */
  key: string;
  selected: boolean;
  product_id: string | null;
  /** 比對到的既有商品名稱。null = 這一列會建一件新商品。 */
  matched_name: string | null;
  name: string;
  issue_number: string | null;
  series: string | null;
  barcode: string | null;
  quantity: number;
  unit_cost: number | null;
  vendor_id: string | null;
  vendor: string | null;
  purchase_date: string | null;
  notes: string | null;
  expiry_date: string | null;
  expiry_alert_days: number | null;
  product_type: ProductType | null;
  category_id: string | null;
};

export type SkippedPurchaseRow = { rowNumber: number; reason: string; raw: string };

export type PurchaseParseResult = {
  rows: ParsedPurchaseRow[];
  skipped: SkippedPurchaseRow[];
  mergedCount: number;
};

const lower = (s: string | null) => (s ?? "").trim().toLowerCase();

/** 去重 key。優先序：既有商品 > 條碼 > 名稱+期數 > 名稱。與來源一致。 */
function dedupeKey(row: ParsedPurchaseRow): string {
  if (row.product_id) return `p:${row.product_id}`;
  if (row.barcode) return `b:${lower(row.barcode)}`;
  if (row.issue_number) return `n:${lower(row.name)}#${lower(row.issue_number)}`;
  return `n:${lower(row.name)}`;
}

/** 這一列是哪一件既有商品。條碼 > 名稱+期數 > 名稱（兩邊都沒期數才算）。 */
function matchProduct(
  products: ProductPickerRow[],
  cand: { name: string; issue_number: string | null; barcode: string | null },
): ProductPickerRow | undefined {
  const bc = lower(cand.barcode);
  const hit = bc ? products.find((p) => lower(p.barcode) === bc) : undefined;
  if (hit || !cand.name) return hit;
  const name = lower(cand.name);
  const issue = lower(cand.issue_number);
  if (issue) return products.find((p) => lower(p.name) === name && lower(p.issue_number) === issue);
  return products.find((p) => lower(p.name) === name && !p.issue_number);
}

/**
 * 二維陣列 + 欄位對應 → 可以送出的列。⚠️ 比對是 O(n×m)，2,000 列的上限（與
 * inv_import_purchases() 的 IMPORT_TOO_MANY 對齊）讓最糟情況仍在幾百毫秒內。
 */
export function parsePurchaseRows(
  rawRows: unknown[][],
  mapping: PurchaseColumnMapping,
  ctx: {
    products: ProductPickerRow[];
    vendors: { vendor_id: string; name: string; short_name: string | null }[];
    categories: { category_id: string; name: string }[];
  },
): PurchaseParseResult {
  const cell = (row: unknown[], field: keyof PurchaseColumnMapping): string => {
    const index = mapping[field];
    if (index === UNMAPPED || index === "") return "";
    return String(row[Number(index)] ?? "").trim();
  };

  const rows: ParsedPurchaseRow[] = [];
  const skipped: SkippedPurchaseRow[] = [];
  const byKey = new Map<string, ParsedPurchaseRow>();
  let mergedCount = 0;

  rawRows.forEach((raw, index) => {
    // +2 = 陣列從 0 開始，而且第 1 列是標題列。使用者看到的是 Excel 的行號。
    const preview = raw.slice(0, 3).filter(Boolean).join(" | ") || "(空白行)";
    const skip = (reason: string) =>
      skipped.push({
        rowNumber: index + 2,
        reason,
        raw: preview.length > 50 ? `${preview.slice(0, 50)}…` : preview,
      });

    const nameCell = cell(raw, "name");
    const barcode = cell(raw, "barcode") || null;
    const issue = cell(raw, "issue_number") || null;
    if (!nameCell && !barcode) {
      skip("商品名稱與條碼都是空的");
      return;
    }

    const matched = matchProduct(ctx.products, { name: nameCell, issue_number: issue, barcode });
    const name = nameCell || matched?.name || "";
    if (!name) {
      skip("只有條碼，但比對不到既有商品 —— 無法決定要建什麼名字的商品");
      return;
    }

    const qtyText = cell(raw, "quantity");
    if (!qtyText) {
      skip("數量是空的");
      return;
    }
    const quantity = Number.parseInt(qtyText, 10);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      skip(`數量「${qtyText}」不是大於 0 的整數`);
      return;
    }

    const vendorText = cell(raw, "vendor");
    const vendorHit = vendorText
      ? ctx.vendors.find(
          (v) => lower(v.name) === lower(vendorText) || lower(v.short_name) === lower(vendorText),
        )
      : undefined;
    const categoryText = cell(raw, "category_name");
    const cost = Number.parseFloat(cell(raw, "unit_cost"));
    const alert = Number.parseInt(cell(raw, "expiry_alert_days"), 10);

    const parsed: ParsedPurchaseRow = {
      key: `${index}-${barcode || name}-${issue ?? ""}`,
      selected: true,
      product_id: matched?.inv_product_id ?? null,
      matched_name: matched?.name ?? null,
      name,
      issue_number: issue,
      series: cell(raw, "series") || null,
      barcode,
      quantity,
      unit_cost: Number.isFinite(cost) && cost >= 0 ? cost : null,
      vendor_id: vendorHit?.vendor_id ?? null,
      // 對得到 vendors 就走 vendor_id，對不到才留自由文字。兩個都留著，之後沒有
      // 人能回答「這批貨到底是跟誰進的」。
      vendor: vendorHit ? null : vendorText || null,
      purchase_date: toIsoDate(cell(raw, "purchase_date")),
      notes: cell(raw, "notes") || null,
      expiry_date: toIsoDate(cell(raw, "expiry_date")),
      expiry_alert_days: Number.isFinite(alert) && alert >= 1 && alert <= 365 ? alert : null,
      product_type: toProductType(cell(raw, "product_type")),
      category_id:
        (categoryText
          ? ctx.categories.find((c) => lower(c.name) === lower(categoryText))?.category_id
          : null) ?? null,
    };

    // 同一份進貨單裡同一本書出現兩次通常是兩箱，不是打錯 —— 數量加起來。
    const dup = byKey.get(dedupeKey(parsed));
    if (dup) {
      dup.quantity += quantity;
      mergedCount += 1;
      return;
    }
    byKey.set(dedupeKey(parsed), parsed);
    rows.push(parsed);
  });

  return { rows, skipped, mergedCount };
}

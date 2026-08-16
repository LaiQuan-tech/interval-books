/**
 * 把 Gemini 回來的進貨單結果攤成確認表要的形狀。
 *
 * 抽出來的理由不是「檔案太長」，是這一段是整個 OCR 流程裡**唯一有判斷的純函式**：
 * 哪一列該綁到哪一件商品、廠商要走 vendor_id 還是自由文字。其餘都是 UI 狀態。
 * 純函式才驗得動 —— 元件裡包著 useState 的話，只能靠點擊去測。
 *
 * ⚠️ 這裡不做任何寫入，也不決定任何金額。辨識結果是**建議**，店員在確認表上逐列
 *    改完之後才走既有的 importPurchases()（整批一個交易）。
 */
import { matchOcrProduct } from "@/lib/admin/ocr-match";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import type { OcrPurchaseRow } from "@/components/ocr/PurchaseOCRItems";
import type { OcrPurchaseOptions } from "@/components/ocr/PurchaseOCROptions";
import type { ProductPickerRow } from "@/server/repos/inv-purchases";

/** Gemini 回來的一列。與 src/server/gemini.ts 的 OcrPurchaseItem 同形。 */
export type OcrItemLike = {
  name: string;
  issue_number: string | null;
  series: string | null;
  quantity: number;
  unit_cost: number;
};

export type VendorLike = { vendor_id: string; name: string; short_name?: string | null };

/**
 * 逐列配對既有商品。
 *
 * 配不到就留 product_id = null —— 那一列會在確認表上要求店員自己選，而不是
 * 硬塞一個看起來像的商品。進貨綁錯商品等於把成本記到別本書上。
 */
export function toPurchaseRows(
  products: ProductPickerRow[],
  items: OcrItemLike[],
): OcrPurchaseRow[] {
  return items.map((item, index) => {
    const matched = matchOcrProduct(products, {
      name: item.name,
      issue_number: item.issue_number,
      series: item.series,
    });
    return {
      // index 進 key：同一張單子上同名同期的兩列是合法的（不同折扣分開列）。
      key: `${index}-${item.name}-${item.issue_number ?? ""}`,
      selected: true,
      product_id: matched?.inv_product_id ?? null,
      name: item.name,
      issue_number: item.issue_number ?? "",
      series: item.series ?? "",
      quantity: String(item.quantity),
      unit_cost: String(item.unit_cost),
    };
  });
}

/**
 * 廠商與單頭。
 *
 * 廠商對得到名單就走 vendor_id，對不到才留自由文字 —— 與 Excel 匯入同一條規矩。
 * 大小寫與前後空白都正規化過：手寫單上的「永樂圖書 」不該變成一個新廠商。
 */
export function toPurchaseOptions(
  vendors: VendorLike[],
  data: { vendor: string | null; purchase_date: string | null; notes: string | null },
): OcrPurchaseOptions {
  const vendorText = (data.vendor ?? "").trim();
  const needle = vendorText.toLowerCase();
  const hit = vendorText
    ? vendors.find(
        (v) =>
          v.name.trim().toLowerCase() === needle ||
          (v.short_name ?? "").trim().toLowerCase() === needle,
      )
    : undefined;

  return {
    vendor_id: hit?.vendor_id ?? "",
    vendor: hit ? "" : vendorText,
    category_id: "",
    // ⚠️ 日期用 todayInTaipei() 補，不是 new Date().toISOString()（那是 UTC，
    //    台北時間晚上 8 點之後會差一天）。模型認不出日期時才會走到這裡。
    purchase_date: data.purchase_date ?? todayInTaipei(),
    notes: data.notes ?? "",
  };
}

/** 確認表的初始狀態（還沒辨識之前）。 */
export function emptyPurchaseOptions(): OcrPurchaseOptions {
  return {
    vendor_id: "",
    vendor: "",
    category_id: "",
    purchase_date: todayInTaipei(),
    notes: "",
  };
}

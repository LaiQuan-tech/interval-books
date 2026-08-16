/**
 * 套餐組合價的分攤預覽（**只是預覽**）。
 *
 * ⚠️ 這支必須與 `inv.allocate_combo_amounts()`（supabase/migrations/
 *    0018_inventory_combos_secondhand.sql §3）以及 `public.inv_combo_checkout()`
 *    §4 的權重規則**保持同步**。真正寫進 inv.sales.amount 的金額一律是資料庫算的
 *    ——資料庫是唯一權威（authority）。這裡算的東西不會被送出去，也不該被送出去：
 *    它只是讓店員在按下儲存之前，看得到「這 200 元會怎麼落到每一件商品上」。
 *    來源系統就是在瀏覽器裡算金額再送出（`isFirstItem ? sellingPrice : 0`），
 *    於是改一個 request body 就能決定哪一件商品拿到全部營收 —— 那正是寄賣廠商的
 *    拆帳基礎。0018 之後那條路已經不存在了，這個檔案也不打算把它挖回來。
 *
 * 兩邊如果哪天不一致，以資料庫為準，回來改這裡。
 */

/** 一件組成品項的分攤輸入。定價缺（0 或 null）是常態，不是例外。 */
export type AllocationInput = {
  product_id: string;
  quantity: number;
  /** 這件商品自己的售價。null / 0 代表沒填 —— 整組會退回按數量均分。 */
  selling_price: number | null;
};

export type AllocationRow = AllocationInput & { weight: number; amount: number };

export type AllocationPreview = {
  /** 'list_price' = 依定價比例分攤；'quantity' = 有品項沒定價，整組按數量均分。 */
  basis: "list_price" | "quantity";
  rows: AllocationRow[];
  /** 沒有定價的品項數。> 0 就一定會是 quantity 口徑。 */
  zeroPricedCount: number;
  /** 分攤結果的加總。必等於（取整後的）組合價 —— 不等於就是這支寫錯了。 */
  total: number;
};

/**
 * 最大餘額法（Hare quota）。與 0018 §3 逐步對齊：
 *   1. 全部權重為 0 → 均分（不能除以 0，而且「都沒填就都不分」會讓營收憑空消失）。
 *   2. 理想值 rᵢ = P × wᵢ / Σw，先各取 floor 到「元」。
 *   3. 餘額一元一元發給小數部分最大的那幾項；小數相同時發給權重大的，再相同時
 *      發給位置在前的（陣列已依 product_id 排序，所以結果是決定性的）。
 *
 * 取整到「元」而不是「分」與資料庫的 v_scale = 1 同一個理由：這家店的售價全是
 * 整數元，收據上不該出現 66.67。
 */
export function allocateComboAmounts(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (!Number.isFinite(total) || total < 0) return weights.map(() => 0);

  const units = Math.round(total);
  const sum = weights.reduce((acc, w) => acc + (w > 0 ? w : 0), 0);

  const base: number[] = [];
  const frac: number[] = [];
  let assigned = 0;

  if (sum === 0) {
    for (let i = 0; i < n; i += 1) {
      base[i] = Math.floor(units / n);
      frac[i] = (units % n) / n; // 全部一樣，靠位置決勝
      assigned += base[i];
    }
  } else {
    for (let i = 0; i < n; i += 1) {
      const ideal = (units * Math.max(weights[i], 0)) / sum;
      base[i] = Math.floor(ideal);
      frac[i] = ideal - Math.floor(ideal);
      assigned += base[i];
    }
  }

  while (assigned < units) {
    let best = 0;
    for (let i = 1; i < n; i += 1) {
      if (frac[i] > frac[best] || (frac[i] === frac[best] && weights[i] > weights[best])) {
        best = i;
      }
    }
    base[best] += 1;
    // 拿過的那一項要退出競爭，否則餘額會全部堆到同一件商品上。
    frac[best] = -1;
    assigned += 1;
  }

  return base;
}

/**
 * 從組成品項算出整份預覽（口徑 + 每一件拿多少）。
 *
 * 權重規則來自 0018 §4：正常是「自身售價 × 數量」，但只要**任何一件**的售價 <= 0，
 * 整組退回「數量」當權重。不是只把缺的那件記 0 —— 那跟來源「第一件吃全額」一樣是
 * 把營收憑空挪到別的品項上，只是換一個品項去背。
 *
 * ⚠️ 呼叫端要先依 product_id 排序（與資料庫的 `ORDER BY i.product_id` 同一把尺），
 *    否則餘額的落點會與實際入帳不一樣。這裡自己排一次，省得每個呼叫端都要記得。
 */
export function previewComboAllocation(
  sellingPrice: number,
  items: AllocationInput[],
): AllocationPreview {
  const sorted = [...items].sort((a, b) =>
    a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : 0,
  );
  const zeroPricedCount = sorted.filter((i) => (i.selling_price ?? 0) <= 0).length;
  const basis: AllocationPreview["basis"] = zeroPricedCount > 0 ? "quantity" : "list_price";

  const weights = sorted.map((i) =>
    basis === "quantity" ? i.quantity : (i.selling_price ?? 0) * i.quantity,
  );
  const amounts = allocateComboAmounts(sellingPrice, weights);

  return {
    basis,
    zeroPricedCount,
    rows: sorted.map((item, i) => ({ ...item, weight: weights[i], amount: amounts[i] ?? 0 })),
    total: amounts.reduce((acc, a) => acc + a, 0),
  };
}

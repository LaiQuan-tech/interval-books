/**
 * 把 OCR 讀到的一筆商品，對到庫存裡既有的商品。
 *
 * ── 這一條規則不能鬆：名稱單獨比對只有在「期數與系列都沒讀到」時才算數 ──────
 * 來源 PurchaseOCRDialog 的 findMatchingProduct 有七層優先序，其中第 6、7 層
 * （名稱完全相同、名稱部分相同）**被包在 `if (!issueNumber && !series)` 裡面**。
 * 那個 if 不是寫來好看的：
 *
 *   進貨單上寫「地味手帖 #13」，模型把 13 讀成 18。如果允許退回去只比名稱，
 *   這一列就會安靜地綁到「地味手帖」的**另一期**上 —— 進貨進到錯的期數，庫存與
 *   FIFO 成本一起錯，而畫面上只會顯示「已比對」。沒有人會發現。
 *
 * 所以：只要 OCR 讀到了 issue_number 或 series 其中一個，比對就**必須**帶著它。
 * 對不上就回 null（畫面標成「新建商品」，店員自己決定要不要綁），這比綁錯好。
 *
 * ⚠️ 這條守則管的是**自動比對**。下面的 ocrMatchCandidates() 是給人選的下拉清單，
 *    那裡可以放寬（期數對不上的排到後面，但仍然列出來）—— 差別在於那是店員親手
 *    點下去的，不是系統替他決定的。
 */

/** OCR 讀到的一筆。與 OcrPurchaseItem / OcrBookResult 的前三個欄位同形狀。 */
export type OcrMatchInput = {
  name: string;
  issue_number: string | null;
  series: string | null;
};

/** 比對的對象。只要有這四欄就能比 —— 不綁 ProductPickerRow，測試才餵得進假資料。 */
export type MatchableProduct = {
  inv_product_id: string;
  name: string;
  issue_number: string | null;
  series: string | null;
};

const lower = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

/** 期數只比數字與英數，`#13`、`No.13`、`13` 要算同一期。 */
const issueKey = (value: string | null | undefined): string =>
  (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-z]/g, "");

/**
 * 自動比對。對不到就回 null —— 這裡**不做**「至少給一個最像的」那種事。
 *
 * 七層優先序與來源逐一對應（完全相同 → 模糊 → 只剩名稱），差別只在於這裡把那個
 * 守門的 if 寫成一個提早 return，讓它不可能在下一次改動時被漏掉。
 */
export function matchOcrProduct<T extends MatchableProduct>(
  products: readonly T[],
  candidate: OcrMatchInput,
): T | null {
  const name = lower(candidate.name);
  if (!name) return null;

  const issue = issueKey(candidate.issue_number);
  const series = lower(candidate.series);

  const nameEq = (p: T) => lower(p.name) === name;
  const nameLike = (p: T) => {
    const pn = lower(p.name);
    return pn.includes(name) || name.includes(pn);
  };
  const issueEq = (p: T) => issueKey(p.issue_number) === issue;
  const seriesEq = (p: T) => lower(p.series) === series;

  // 1～5：OCR 讀到了期數或系列 —— 比對一定要帶著它。
  if (issue && series) {
    return (
      products.find((p) => nameEq(p) && issueEq(p) && seriesEq(p)) ??
      products.find((p) => nameLike(p) && issueEq(p) && seriesEq(p)) ??
      null
    );
  }
  if (issue) {
    return (
      products.find((p) => nameEq(p) && issueEq(p)) ??
      products.find((p) => nameLike(p) && issueEq(p)) ??
      null
    );
  }
  if (series) {
    return products.find((p) => nameEq(p) && seriesEq(p)) ?? null;
  }

  // 6～7：走到這裡代表 issue_number 與 series **兩個都是空的**。只有這個情況下
  // 才准用名稱單獨比對 —— 上面三個 return 就是那個守門的 if。
  return (
    products.find((p) => nameEq(p) && !p.issue_number) ??
    products.find((p) => nameEq(p)) ??
    products.find((p) => nameLike(p)) ??
    null
  );
}

/**
 * 給下拉選單用的候選清單（分數高的在前）。
 *
 * 與 matchOcrProduct 的差別：這裡**允許**期數對不上的商品出現，只是扣分排到後面。
 * 理由見檔頭 —— 這份清單是給人看的，最後按下去的是店員。
 */
export function ocrMatchCandidates<T extends MatchableProduct>(
  products: readonly T[],
  candidate: OcrMatchInput,
  limit = 8,
): T[] {
  const name = lower(candidate.name);
  if (!name) return [];

  const issue = issueKey(candidate.issue_number);
  const series = lower(candidate.series);

  const scored: { product: T; score: number }[] = [];
  for (const product of products) {
    const pn = lower(product.name);
    let score = 0;
    if (pn === name) score = 60;
    else if (pn && (pn.includes(name) || name.includes(pn))) score = 30;
    else continue;

    if (issue) score += issueKey(product.issue_number) === issue ? 25 : -20;
    if (series) score += lower(product.series) === series ? 15 : -5;
    if (score > 0) scored.push({ product, score });
  }

  scored.sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name, "zh-TW"));
  return scored.slice(0, limit).map((entry) => entry.product);
}

/** 下拉選單上的顯示字串：「地味手帖 #15（系列：地味）」。 */
export function describeProduct(product: MatchableProduct): string {
  return (
    product.name +
    (product.issue_number ? ` #${product.issue_number}` : "") +
    (product.series ? `（${product.series}）` : "")
  );
}

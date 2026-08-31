/**
 * 台灣電子發票欄位的格式規則 —— 瀏覽器與伺服器共用的唯一一份。
 *
 * ── 為什麼是獨立一個檔案，而不是寫在 src/server/amego.ts 裡 ────────────────
 * amego.ts 已經有一份 isValidTaxId()，而且它**不能**被瀏覽器 import：vite 的
 * client importProtection 把 `**\/server\/**` 設成 behavior:"error"，client 端碰到
 * 就直接 build 失敗（那個保護是對的，amego.ts 會讀 AMEGO_APP_KEY）。
 *
 * 但統編檢核碼一定要在前端就擋下來。理由不是「體驗比較好」，是**擋不下來的後果不對稱**：
 * 錯的統編送到 Amego 會拿到 3040122，那是永久性失敗，retry_count 直接推到上限，
 * 這張訂單從此開不出發票，要人去改資料庫。前端擋下來的話，客人在還看得到那個欄位的
 * 時候就把它改對了。
 *
 * 所以這裡是「共用的純函式」那一份：不 import 任何東西（連 zod 都不），瀏覽器、
 * server function、selftest 三邊都直接用同一份。amego.ts 那一份刻意保留 ——
 * 它的獨立性是 scripts/amego-selftest.mjs 能直接驗產線程式碼的前提，不要為了
 * 「消除重複」把它改成 import 這裡。**兩份會不會漂移由測試守著**：
 * scripts/invoice-selftest.mjs 拿同一組向量同時餵給兩份實作，答案不一樣就紅。
 *
 * ── 這個檔案不碰錢 ────────────────────────────────────────────────────────
 * 這裡沒有任何一個函式看得到金額、單價、運費或 total。發票開法只決定「這張憑證抬頭
 * 寫誰、載具是什麼」，訂單金額一律由 src/server/repos/orders.ts 從 public.products
 * 重算。normalizeInvoiceChoice() 的回傳型別是封閉的六個欄位，所以就算 payload 被
 * 塞進 `total`，它也走不到任何寫入金額的路徑上。
 */

/** 對應 invoices.invoice_type 的 CHECK（0005_commerce_orders.sql）。 */
export const INVOICE_TYPES = ["personal", "company", "donate"] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

/** 手機條碼載具。財政部代碼，Amego 的 CarrierType 直接吃這個字串。 */
export const CARRIER_MOBILE = "3J0002";
/** 自然人憑證載具。 */
export const CARRIER_NPC = "CQ0001";

/** UI 上可選的載具。空字串＝不指定（發票寄到信箱，由我們保管）。 */
export const CARRIER_TYPES = ["", CARRIER_MOBILE, CARRIER_NPC] as const;
export type CarrierType = (typeof CARRIER_TYPES)[number];

/**
 * 台灣統一編號檢核碼。
 *
 * ⚠️ 與 src/server/amego.ts 的 isValidTaxId() 必須永遠給出一樣的答案。兩份是刻意的
 * （見檔頭），漂移由 scripts/invoice-selftest.mjs 的對拍守著。改這裡就要改那裡。
 *
 * 規則（財政部）：8 碼數字，乘數 [1,2,1,2,1,2,4,1]，每位乘積的十位與個位相加後總和，
 * 能被 5 整除即有效；第 7 碼為 7 時，該位的乘積可視為 10（即總和 +1 也算過）。
 */
export function isValidTaxId(value: string | null | undefined): boolean {
  const id = (value ?? "").trim();
  if (!/^\d{8}$/.test(id)) return false;
  const weights = [1, 2, 1, 2, 1, 2, 4, 1];
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    const product = Number(id[i]) * weights[i];
    sum += Math.floor(product / 10) + (product % 10);
  }
  if (sum % 5 === 0) return true;
  return id[6] === "7" && (sum + 1) % 5 === 0;
}

/**
 * 手機條碼載具：`/` 開頭共 8 碼，後 7 碼是 0-9 A-Z 與 `+ - .`。
 *
 * 這是財政部的字集，不是「7 碼英數」—— `+`、`-`、`.` 真的會出現在條碼裡，用
 * `[0-9A-Z]{7}` 會把合法載具擋在門外，而客人手上那張條碼是印出來的，改不了。
 */
export function isValidMobileCarrier(value: string | null | undefined): boolean {
  return /^\/[0-9A-Z+\-.]{7}$/.test((value ?? "").trim());
}

/** 自然人憑證載具：2 個大寫英文字母 + 14 個數字。 */
export function isValidNpcCarrier(value: string | null | undefined): boolean {
  return /^[A-Z]{2}\d{14}$/.test((value ?? "").trim());
}

/** 依載具類型挑對應的格式規則。類型是空的（不指定）時沒有號碼可驗。 */
export function isValidCarrier(
  carrierType: string | null | undefined,
  carrierNumber: string | null | undefined,
): boolean {
  const type = (carrierType ?? "").trim();
  if (type === CARRIER_MOBILE) return isValidMobileCarrier(carrierNumber);
  if (type === CARRIER_NPC) return isValidNpcCarrier(carrierNumber);
  return false;
}

/**
 * 愛心碼：3–7 位數字。
 *
 * 只驗格式，不驗這個碼真的存在 —— 那要打財政部的清單，而且清單會變。碼不存在時
 * Amego 會擋下來，那條路徑由 invoice-issuer 的 permanent 失敗處理。
 */
export function isValidLoveCode(value: string | null | undefined): boolean {
  return /^\d{3,7}$/.test((value ?? "").trim());
}

/**
 * 客人選的發票開法，正規化之後的樣子。
 *
 * 欄位名稱對齊 public.invoices 的欄位，因為它唯一的去處就是那張表。
 */
export type InvoiceChoice = {
  type: InvoiceType;
  taxId: string | null;
  companyTitle: string | null;
  carrierType: string | null;
  carrierNumber: string | null;
  loveCode: string | null;
};

/** 什麼都沒填時的預設：個人、無載具（發票由我們保管並以 email 通知）。 */
export const DEFAULT_INVOICE_CHOICE: InvoiceChoice = {
  type: "personal",
  taxId: null,
  companyTitle: null,
  carrierType: null,
  carrierNumber: null,
  loveCode: null,
};

export type InvoiceChoiceInput =
  | {
      type?: string | null;
      taxId?: string | null;
      companyTitle?: string | null;
      carrierType?: string | null;
      carrierNumber?: string | null;
      loveCode?: string | null;
    }
  | null
  | undefined;

/**
 * 把表單（或一個被改過的 payload）收斂成「這三種開法之一，而且只帶得動自己那組欄位」。
 *
 * ── 為什麼要在伺服器再做一次 ──────────────────────────────────────────────
 * 表單只送三種開法其中一種的欄位，但 payload 是可以被編輯的。沒有這一步的話，
 * `{type:"personal", taxId:"12345678", loveCode:"001"}` 會把三組欄位全部寫進
 * invoices，接著 resolveBuyer() 讀到的就是一個自相矛盾的狀態（B2C 發票同時帶著統編
 * 與愛心碼）。這裡直接讓「不屬於這個類型的欄位」不存在，而不是留著讓下游去猜。
 *
 * ── 格式不對時退回個人發票，不是拒絕訂單 ──────────────────────────────────
 * 與 resolveBuyer() 同一個判斷：一張抬頭不完美的發票，永遠好過一張因為欄位有問題就
 * 開不出來的發票。而且這條路徑正常情況下走不到 —— 瀏覽器已經擋過一次，會走到這裡
 * 的只有被改過的 payload，那種請求本來就不該因為「我把統編改壞了」而拿到不同的結果。
 *
 * ⚠️ 這個函式看不到任何金額欄位，回傳型別也沒有地方放金額。發票開法不影響訂單金額，
 * 這是硬規則。
 */
export function normalizeInvoiceChoice(input: InvoiceChoiceInput): InvoiceChoice {
  const raw = input ?? {};
  const clean = (v: string | null | undefined) => {
    const s = (v ?? "").trim();
    return s.length > 0 ? s : null;
  };

  const type = (INVOICE_TYPES as readonly string[]).includes((raw.type ?? "").trim())
    ? ((raw.type ?? "").trim() as InvoiceType)
    : "personal";

  if (type === "company") {
    const taxId = clean(raw.taxId);
    // 統編不合法就不是公司發票了 —— 退回個人，而不是寫一個開不出來的統編進資料庫。
    if (!taxId || !isValidTaxId(taxId)) return { ...DEFAULT_INVOICE_CHOICE };
    return {
      type: "company",
      taxId,
      companyTitle: clean(raw.companyTitle)?.slice(0, 60) ?? null,
      carrierType: null,
      carrierNumber: null,
      loveCode: null,
    };
  }

  if (type === "donate") {
    const loveCode = clean(raw.loveCode);
    if (!loveCode || !isValidLoveCode(loveCode)) return { ...DEFAULT_INVOICE_CHOICE };
    return {
      type: "donate",
      taxId: null,
      companyTitle: null,
      carrierType: null,
      carrierNumber: null,
      loveCode,
    };
  }

  // personal：載具是選填的。填了但格式不對，就當成沒填（發票仍然開得出來）。
  const carrierType = clean(raw.carrierType)?.toUpperCase() ?? null;
  const carrierNumber = clean(raw.carrierNumber)?.toUpperCase() ?? null;
  if (!carrierType || !isValidCarrier(carrierType, carrierNumber)) {
    return { ...DEFAULT_INVOICE_CHOICE };
  }
  return {
    type: "personal",
    taxId: null,
    companyTitle: null,
    carrierType,
    carrierNumber,
    loveCode: null,
  };
}

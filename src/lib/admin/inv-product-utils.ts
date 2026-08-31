/**
 * 進銷存商品頁的純函式。
 *
 * 放在 lib 而不是元件裡，是因為它們是**規則**不是畫面：期數解析的六個 pattern
 * 決定了資料庫裡會出現什麼樣的 issue_number，Excel 的欄位對應決定了 1,000 列會
 * 被讀成什麼。這兩件事要能單獨被讀、被改、被測。
 */

/**
 * 從商品名稱裡把期數拆出來。六個 pattern 與來源逐字一致。
 *
 * 「地味手帖 NO.15」→ { baseName: "地味手帖", issueNumber: "15" }
 *
 * ⚠️ 最後一個 pattern（結尾的空白 + 數字）會把「小誌 2024」讀成期數 2024。來源
 *    就是這樣，而且這是刻意的：這家店的刊物名稱結尾帶年份的極少，帶期數的很多。
 *    真的拆錯了，期數欄就在旁邊，改回去比每次都要手動填快。所以它只在期數欄
 *    **是空的**時候才跑。
 */
export function extractIssueFromName(name: string): {
  baseName: string;
  issueNumber: string | null;
} {
  const patterns = [
    /\s*NO\.?\s*(\d+)/i, // NO.15, NO 15
    /\s*#(\d+)/, // #15
    /\s*第(\d+)期/, // 第15期
    /\s*Vol\.?\s*(\d+)/i, // Vol.15, Vol 15
    /\s*(\d+)期$/, // 15期
    /\s+(\d+)$/, // 地味手帖 15
  ];

  for (const regex of patterns) {
    const match = name.match(regex);
    if (match) {
      return { baseName: name.replace(regex, "").trim(), issueNumber: match[1] };
    }
  }
  return { baseName: name, issueNumber: null };
}

/**
 * 台北的今天。
 *
 * purchase_date 是 date 不是 timestamptz，所以不能用 toISOString()（那是 UTC，
 * 台北時間晚上 8 點之後會差一天）。與 _shell.pos.tsx 的 todayInTaipei() 同一條規矩。
 */
export function todayInTaipei(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

/** 這個模組現在要不要審核。查不到 = 要審核（fail-closed，與資料庫那一份同語意）。 */
export function isApprovalRequired(
  settings: { module: string; is_enabled: boolean }[],
  module: string,
): boolean {
  const found = settings.find((s) => s.module === module);
  return found?.is_enabled ?? true;
}

/**
 * 整份商品清單，翻頁拿完 —— 只給 Excel 匯入的「這一列是不是既有商品」比對用。
 *
 * 一般頁面**不該**呼叫這個：清單頁的篩選與分頁都在資料庫端做，正是為了不要把
 * 993 筆整份載進瀏覽器（來源系統就是那樣，而且每一次寫入都重抓一次）。
 * 匯入是唯一真的需要全表的場景 —— 比對「這本書已經在庫存裡了嗎」沒有辦法只看一頁。
 *
 * pageSize 上限 200 是 productFilterSchema 訂的，所以 993 筆要跑 5 次。
 */
export async function loadAllProductsForMatching(): Promise<
  {
    inv_product_id: string;
    name: string;
    issue_number: string | null;
    barcode: string | null;
    series: string | null;
  }[]
> {
  const { listAdminProducts } = await import("@/lib/admin/fns/inv-products");
  const base = {
    keyword: null,
    categoryId: null,
    productType: null,
    vendorId: null,
    approvalStatus: "all" as const,
    activeStatus: "all" as const,
    priceChange: "all" as const,
    sort: "created_at" as const,
    pageSize: 200,
  };

  const first = await listAdminProducts({ data: { ...base, page: 0 } });
  const all = [...first.rows];
  const pages = Math.ceil(first.total / base.pageSize);
  for (let page = 1; page < pages; page += 1) {
    const next = await listAdminProducts({ data: { ...base, page } });
    all.push(...next.rows);
  }
  return all;
}

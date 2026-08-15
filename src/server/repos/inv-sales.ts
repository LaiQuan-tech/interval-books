/**
 * 門市 POS 與銷售紀錄 —— 進銷存那一側**所有**資料庫存取的唯一出口。
 *
 * ── 這一層存在的理由（與 repos/inventory-listing.ts 同一條）────────────────
 * inv 不在 PostgREST 的 db_schema 裡（0009 §0：inv.vendors 有身分證字號與銀行
 * 帳戶）。所以連 service_role 的 supabase-js client 都**打不到** inv.* —— 那些表
 * 根本沒被掛出來。要讀就走 0014 的四個 view，要寫就呼叫 SECURITY DEFINER 函式。
 *
 * ── 錯誤一律 throw，不吞 ──────────────────────────────────────────────────
 * 櫃檯最糟的失敗模式是「按了結帳、畫面沒反應、店員再按一次」。所以這裡沒有
 * 任何一個 catch 會把錯誤變成空陣列或 null：呼叫端要嘛拿到資料，要嘛看到一句
 * 中文錯誤。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";

/** 櫃檯賣得動的品項。available 已經是**銷售單位**，前端不要再乘 pack_size。 */
export type PosProduct = {
  inv_product_id: string;
  name: string;
  barcode: string | null;
  issue_number: string | null;
  series: string | null;
  product_type: string;
  selling_price: number | null;
  base_product_id: string | null;
  stock_target_id: string;
  stock_target_name: string;
  units_per_item: number;
  stock_quantity: number;
  reserved: number;
  available: number;
};

export type PosPaymentMethod = {
  payment_method_id: string;
  name: string;
  is_default: boolean;
  display_order: number | null;
  fee_category: string | null;
};

export type PosSaleRow = {
  sale_id: string;
  sale_date: string;
  created_at: string;
  channel: string;
  override_reservation: boolean;
  web_order_id: string | null;
  quantity: number;
  unit_price: number | null;
  amount: number | null;
  cost_price: number | null;
  gross_profit: number | null;
  is_secondhand: boolean;
  item_name: string | null;
  notes: string | null;
  combo_set_id: string | null;
  combo_sale_group: string | null;
  is_reconciled: boolean;
  reconciled_at: string | null;
  inv_product_id: string | null;
  product_name: string | null;
  issue_number: string | null;
  series: string | null;
  product_type: string | null;
  payment_method_id: string | null;
  payment_method_name: string | null;
  user_id: string;
  operator_name: string | null;
};

export type StockAlertRow = {
  alert_id: number;
  created_at: string;
  source: string;
  shortfall: number;
  inv_product_id: string;
  product_name: string;
  current_stock: number;
  sale_id: string | null;
  order_id: string | null;
  order_status: string | null;
  customer_name: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  resolved_by_email: string | null;
};

export type PosCheckoutItem = {
  inv_product_id: string;
  quantity: number;
  unit_price: number;
};

export type PosCheckoutResult = {
  sale_ids: string[];
  total_amount: number;
  total_cost: number;
  oversold: { inv_product_id: string; product_name: string; shortfall: number }[];
};

/**
 * 整份櫃檯商品清單，一次載完。
 *
 * 993 筆聽起來很多，但這是刻意的：櫃檯掃一個條碼不應該等一次網路來回。清單在
 * route loader 載一次，之後每一次掃碼與搜尋都是記憶體比對，離線幾秒也不會卡住
 * 結帳。真正的庫存判斷不靠這份快取 —— 結帳時 pos_checkout() 會在資料庫裡重算
 * 一次可售量，所以這份資料過期最多讓畫面上的數字慢一拍，不會賣超。
 */
export async function listPosProducts(): Promise<PosProduct[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_pos_products")
    .select(
      "inv_product_id, name, barcode, issue_number, series, product_type, selling_price, base_product_id, stock_target_id, stock_target_name, units_per_item, stock_quantity, reserved, available",
    )
    .order("name", { ascending: true })
    .limit(5000);

  if (error) throw new Error(`[repo/inv-sales] 商品清單讀取失敗：${error.message}`);
  return (data ?? []) as unknown as PosProduct[];
}

/**
 * 條碼精準查詢。
 *
 * listPosProducts() 的快取通常就夠了，這支是給「這個條碼不在快取裡」的情況：
 * 有人剛在進銷存那邊建了新品項，店員不該為此重整頁面。
 */
export async function findPosProductByBarcode(barcode: string): Promise<PosProduct | null> {
  const { data, error } = await supabaseAdmin()
    .from("inv_pos_products")
    .select(
      "inv_product_id, name, barcode, issue_number, series, product_type, selling_price, base_product_id, stock_target_id, stock_target_name, units_per_item, stock_quantity, reserved, available",
    )
    .eq("barcode", barcode)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[repo/inv-sales] 條碼查詢失敗：${error.message}`);
  return (data as unknown as PosProduct | null) ?? null;
}

export async function listPosPaymentMethods(): Promise<PosPaymentMethod[]> {
  const { data, error } = await supabaseAdmin()
    .from("inv_pos_payment_methods")
    .select("payment_method_id, name, is_default, display_order, fee_category")
    .order("display_order", { ascending: true });

  if (error) throw new Error(`[repo/inv-sales] 付款方式讀取失敗：${error.message}`);
  return (data ?? []) as unknown as PosPaymentMethod[];
}

/**
 * 結帳。整車一個交易 —— 見 0014 §3。
 *
 * 這裡**不做**任何庫存判斷。判斷在資料庫裡，因為只有那裡才拿得到列鎖；在這裡
 * 先查一次再送出去，中間就有一個網站訂單可以插進來的窗口。
 */
export async function posCheckout(input: {
  userId: string;
  items: PosCheckoutItem[];
  paymentMethodId: string | null;
  saleDate: string;
  notes: string | null;
  overrideReservation: boolean;
}): Promise<PosCheckoutResult> {
  const { data, error } = await supabaseAdmin().rpc("pos_checkout", {
    p_user_id: input.userId,
    p_items: input.items,
    p_payment_method_id: input.paymentMethodId,
    p_sale_date: input.saleDate,
    p_notes: input.notes,
    p_override_reservation: input.overrideReservation,
  });

  if (error) {
    // pos_checkout() 丟出來的訊息是寫給店員看的（「『紅烏龍茶餅』可售 2 件，
    // 這一車需要 3 件」）。前綴只是給 log 用的分類，剝掉再往上丟。
    const message = error.message.replace(/^POS_[A-Z_]+:\s*/, "");
    throw new Error(message || "結帳失敗，請再試一次");
  }

  return data as unknown as PosCheckoutResult;
}

export type SalesFilter = {
  from: string | null;
  to: string | null;
  channel: "all" | "pos" | "online";
  keyword: string | null;
  reconciled: "all" | "yes" | "no";
  paymentMethodId: string | null;
  page: number;
  pageSize: number;
};

/**
 * 銷售紀錄。
 *
 * ⚠️ 篩選與分頁都在**資料庫端**做。來源系統是「抓全表 → 前端 Array.filter →
 *    全部渲染」，665 筆時還撐得住，但每一次寫入都會重抓整張表，而且沒有排序
 *    tiebreak（同一天的順序是不確定的）。這裡補上 created_at 當第二排序鍵。
 */
export async function listPosSales(
  filter: SalesFilter,
): Promise<{ rows: PosSaleRow[]; total: number }> {
  const from = filter.page * filter.pageSize;
  const to = from + filter.pageSize - 1;

  let query = supabaseAdmin()
    .from("inv_pos_sales")
    .select("*", { count: "exact" })
    .order("sale_date", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (filter.from) query = query.gte("sale_date", filter.from);
  if (filter.to) query = query.lte("sale_date", filter.to);
  if (filter.channel !== "all") query = query.eq("channel", filter.channel);
  if (filter.reconciled !== "all") query = query.eq("is_reconciled", filter.reconciled === "yes");
  if (filter.paymentMethodId) query = query.eq("payment_method_id", filter.paymentMethodId);
  if (filter.keyword) {
    // PostgREST 的 or() 語法：逗號分隔，值裡的逗號與括號會壞掉，所以先剝掉。
    const safe = filter.keyword.replace(/[(),]/g, " ").trim();
    if (safe) {
      query = query.or(
        `product_name.ilike.%${safe}%,issue_number.ilike.%${safe}%,series.ilike.%${safe}%,notes.ilike.%${safe}%`,
      );
    }
  }

  const { data, error, count } = await query;
  if (error) throw new Error(`[repo/inv-sales] 銷售紀錄讀取失敗：${error.message}`);
  return { rows: (data ?? []) as unknown as PosSaleRow[], total: count ?? 0 };
}

/** 篩選條件下的合計。分頁只影響看得到幾列，總數要算全部。 */
export async function summarisePosSales(
  filter: SalesFilter,
): Promise<{ count: number; quantity: number; amount: number; cost: number }> {
  let query = supabaseAdmin().from("inv_pos_sales").select("quantity, amount, cost_price");

  if (filter.from) query = query.gte("sale_date", filter.from);
  if (filter.to) query = query.lte("sale_date", filter.to);
  if (filter.channel !== "all") query = query.eq("channel", filter.channel);
  if (filter.reconciled !== "all") query = query.eq("is_reconciled", filter.reconciled === "yes");
  if (filter.paymentMethodId) query = query.eq("payment_method_id", filter.paymentMethodId);
  if (filter.keyword) {
    const safe = filter.keyword.replace(/[(),]/g, " ").trim();
    if (safe) {
      query = query.or(
        `product_name.ilike.%${safe}%,issue_number.ilike.%${safe}%,series.ilike.%${safe}%,notes.ilike.%${safe}%`,
      );
    }
  }

  const { data, error } = await query.limit(20000);
  if (error) throw new Error(`[repo/inv-sales] 銷售合計讀取失敗：${error.message}`);

  const rows = (data ?? []) as { quantity: number; amount: number | null; cost_price: number | null }[];
  return {
    count: rows.length,
    quantity: rows.reduce((n, r) => n + r.quantity, 0),
    amount: rows.reduce((n, r) => n + Number(r.amount ?? 0), 0),
    // cost_price 是**單位**成本，所以要乘數量。來源系統的統計卡也是這樣算的。
    cost: rows.reduce((n, r) => n + Number(r.cost_price ?? 0) * r.quantity, 0),
  };
}

export async function listStockAlerts(status: "all" | "open" | "resolved"): Promise<StockAlertRow[]> {
  let query = supabaseAdmin()
    .from("inv_stock_alerts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);

  if (status === "open") query = query.is("resolved_at", null);
  if (status === "resolved") query = query.not("resolved_at", "is", null);

  const { data, error } = await query;
  if (error) throw new Error(`[repo/inv-sales] 賣超告警讀取失敗：${error.message}`);
  return (data ?? []) as unknown as StockAlertRow[];
}

/**
 * 標記告警已處理。
 *
 * `.is("resolved_at", null)` 不是多餘的：兩個店員同時開著告警頁時，第二個人按下去
 * 應該是沒事發生，而不是把第一個人的處理說明蓋掉。回傳 0 列就是「已經有人處理了」。
 */
export async function resolveStockAlert(input: {
  alertId: number;
  userId: string;
  note: string;
}): Promise<{ resolved: boolean }> {
  const { data, error } = await supabaseAdmin()
    .from("stock_oversold_alerts")
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: input.userId,
      resolution_note: input.note,
    })
    .eq("id", input.alertId)
    .is("resolved_at", null)
    .select("id");

  if (error) throw new Error(`[repo/inv-sales] 告警標記失敗：${error.message}`);
  return { resolved: (data ?? []).length > 0 };
}

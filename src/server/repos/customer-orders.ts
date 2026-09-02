/**
 * 客人看自己的訂單與報名 —— **唯一**的歸屬過濾邊界。
 *
 * ═══ 這個檔案為什麼獨立存在 ═══════════════════════════════════════════════
 *
 * repos/orders.ts 的檔頭寫著「這個模組假設呼叫端已經被授權了」。對後台是對的：
 * 那一側的問題是「這個人能不能進來」，答完就結束了。客人這一側完全不是那個問題
 * —— 每一個客人都「能進來」，差別在**看得到哪幾列**。
 *
 * 那種授權沒有辦法靠「在頁面上記得檢查」來維持。頁面會被複製、會被拆成兩個
 * loader、會有人為了做一個「訂單查詢」的小功能而多開一支 server fn，然後那一支
 * 忘了帶 user_id。所以歸屬過濾**只寫在這一個檔案裡**，而且每一支都長成同一個
 * 形狀：`.eq("user_id", userId)` 就在 select 的下一行，看得見。
 *
 *   · 沒有任何一支收 email、order_id、public_token 之類「可以拿來指別人」的東西。
 *     唯一能指定「是誰」的參數是 userId，而它的唯一合法來源是
 *     customer-auth.ts 的 requireCustomer()。
 *   · 頁面不可以自己 import supabaseAdmin 去查 orders。要多一種查法就加在這裡，
 *     然後它會自動被 scripts/customer-account-selftest.mjs 的突變測試守住。
 *
 * ═══ 為什麼是「查無」與「不是你的」回同一個 null ═══════════════════════════
 *
 * fetchMyOrderDetail() 對「這個編號不存在」與「這個編號存在但不屬於你」回**完全
 * 相同**的結果。分開的話（404 vs 403）就等於提供一支預言機：訂單編號是
 * `IB-2026000000NN` 這種連號的（0005 的 next_order_no()），任何人都可以從
 * IB-202600000001 數上去，用兩種回應的差別數出這家店總共有幾張單、哪幾個編號
 * 是真的。那本身就是營業資料，而且是列舉攻擊的第一步。
 *
 * 實作上這件事是免費的：`.eq("user_id").eq("order_no").maybeSingle()` 兩種情況
 * 都回 `data === null`。**不要**為了「給更好的錯誤訊息」把它拆成先查存不存在、
 * 再比對歸屬 —— 那正是這條規則要擋的東西。
 *
 * ═══ 回傳哪些欄位：先給最小集合 ═══════════════════════════════════════════
 *
 * 客人看自己的姓名、電話、地址是合理的，但這一版**一律不回**
 * customer_name / customer_email / customer_phone，也不回 order_addresses。
 * 理由是這幾支的回傳值會流進頁面、流進 loader 的序列化結果、流進瀏覽器的
 * DevTools 與快取 —— 而目前沒有任何一個畫面需要它們。要用的時候再加，那時候是
 * 一個有具體理由的決定；現在先放進去，只會變成一個沒有人記得為什麼在那裡的個資
 * 出口。
 *
 * ⚠️ 品項不 join public.products。order_items 存的是**購買當下的快照**
 *    （0005:121-134 的 name / unit_price / subtotal / product_type，加上 0020 的
 *    session_id），而快照就是重點：事後改商品名或改價，不可以改寫已成立訂單的
 *    歷史。join 回去等於把那個保證拿掉。
 *
 * ⚠️ 參加者只回 name，**不回 email / phone**。那幾位可能是客人的朋友、同事 ——
 *    是第三人的個資，不是「他自己的資料」。名字要回是因為畫面上得認得出哪一列
 *    是誰的位子。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

/** order_items 的快照。名稱與金額都是購買當下的值，見檔頭。 */
export type MyOrderItem = {
  name: Localized;
  unitPrice: number;
  quantity: number;
  subtotal: number;
  productType: string;
  /** 活動／策旅品項賣的是哪一個梯次（0020 加的欄位）；goods/book 是 null。 */
  sessionId: string | null;
};

export type MyOrderSummary = {
  orderNo: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string | null;
  subtotal: number;
  shippingFee: number;
  discount: number;
  total: number;
  shippingMethod: string;
  createdAt: string;
  paidAt: string | null;
};

export type MyOrderDetail = MyOrderSummary & {
  items: MyOrderItem[];
};

export type MyRegistration = {
  /** 這個位子屬於哪一張訂單，讓畫面可以連回訂單頁。 */
  orderNo: string;
  seatNo: number;
  /** 參加者姓名。email / phone 刻意不回，見檔頭。 */
  name: string;
  sessionId: string;
  sessionTitle: Localized;
  sessionLocation: Localized;
  startsAt: string;
  endsAt: string | null;
};

/**
 * 訂單列表用的欄位。個資一欄都沒有 —— 見檔頭。
 *
 * ⚠️ 這裡沒有 public_token。那是「不登入也看得到」的鑰匙（0005:67 的註解說它
 *    「must never be returned by a status endpoint」），已經登入的人不需要它，
 *    而把它回給瀏覽器等於讓它流進網址列、瀏覽紀錄與 referrer。
 */
const ORDER_COLUMNS =
  "order_no, status, payment_status, payment_method, subtotal, shipping_fee, discount, total, shipping_method, created_at, paid_at";

type OrderRow = {
  order_no: string;
  status: string;
  payment_status: string;
  payment_method: string | null;
  subtotal: number;
  shipping_fee: number;
  discount: number;
  total: number;
  shipping_method: string;
  created_at: string;
  paid_at: string | null;
};

function toSummary(o: OrderRow): MyOrderSummary {
  return {
    orderNo: o.order_no,
    status: o.status,
    paymentStatus: o.payment_status,
    paymentMethod: o.payment_method,
    subtotal: o.subtotal,
    shippingFee: o.shipping_fee,
    discount: o.discount,
    total: o.total,
    shippingMethod: o.shipping_method,
    createdAt: o.created_at,
    paidAt: o.paid_at,
  };
}

/**
 * 這個客人的訂單列表，新的在前。
 *
 * ⚠️ `userId` 是空字串／null 時直接回空陣列，**不要**讓它掉進查詢。
 *    `.eq("user_id", "")` 在 PostgREST 會變成一個 uuid 轉型錯誤（回 error，還算
 *    安全），但 `.eq("user_id", undefined)` 在 supabase-js 會被序列化成
 *    `user_id=eq.undefined`，而那種「參數沒帶好，過濾條件變成別的東西」的形狀
 *    正是這一整個檔案要防的。在門口擋掉，不要靠下游的巧合。
 */
export async function fetchMyOrders(userId: string): Promise<MyOrderSummary[]> {
  if (!userId) return [];

  const { data, error } = await supabaseAdmin()
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  // Fail closed：查詢失敗不可以被讀成「這個人沒有訂單」。
  if (error) throw new Error(`無法讀取訂單：${error.message}`);
  return ((data ?? []) as unknown as OrderRow[]).map(toSummary);
}

/**
 * 單張訂單。
 *
 * **查無** 與 **不是你的** 回完全相同的 `null` —— 見檔頭「為什麼回同一個 null」。
 * 兩個 .eq 一起下，資料庫層面就分不出來，呼叫端也就沒有東西可以拿來分辨。
 */
export async function fetchMyOrderDetail(
  userId: string,
  orderNo: string,
): Promise<MyOrderDetail | null> {
  if (!userId || !orderNo) return null;

  const { data, error } = await supabaseAdmin()
    .from("orders")
    // ⚠️ id 只在這一支被讀出來，而且**不會**出現在回傳值裡：它只用來撈 order_items。
    .select(`id, ${ORDER_COLUMNS}`)
    .eq("user_id", userId)
    .eq("order_no", orderNo)
    .maybeSingle();

  if (error) throw new Error(`無法讀取訂單：${error.message}`);
  if (!data) return null;

  const o = data as unknown as OrderRow & { id: string };

  const { data: itemRows, error: itemError } = await supabaseAdmin()
    .from("order_items")
    .select("name, unit_price, quantity, subtotal, product_type, session_id")
    .eq("order_id", o.id)
    .order("id", { ascending: true });

  if (itemError) throw new Error(`無法讀取訂單品項：${itemError.message}`);

  const items = (
    (itemRows ?? []) as unknown as {
      name: Localized;
      unit_price: number;
      quantity: number;
      subtotal: number;
      product_type: string;
      session_id: string | null;
    }[]
  ).map((r) => ({
    name: r.name,
    unitPrice: r.unit_price,
    quantity: r.quantity,
    subtotal: r.subtotal,
    productType: r.product_type,
    sessionId: r.session_id ?? null,
  }));

  return { ...toSummary(o), items };
}

/**
 * 這個客人買到的每一個位子，含場次時間與地點。
 *
 * ── 為什麼是兩段查詢，而不是一句 PostgREST 的 !inner embed ────────────────
 *
 * `event_registrations` **沒有 user_id 欄位**（0020:275-304），歸屬只能經由
 * `order_id → orders.user_id`。用 embed 寫得出一句話：
 *
 *     .select("…, orders!inner(user_id)").eq("orders.user_id", userId)
 *
 * 但那樣一來，整支函式的授權就縮進一個字串裡的別名。別名打錯、embed 的關聯被
 * PostgREST 換一種解讀，都會讓那個 .eq 過濾到別的東西上，而讀程式的人看到的
 * 仍然是一行有 userId 的程式碼。
 *
 * 分兩段之後，第一段就是普通的 `orders … .eq("user_id", userId)` —— 與上面兩支
 * 一模一樣的形狀，同一個突變測試守得到；第二段只認第一段撈出來的 order_id，
 * 不可能撈到清單以外的東西。多一次 round trip 換一個看得見的邊界。
 */
export async function fetchMyRegistrations(userId: string): Promise<MyRegistration[]> {
  if (!userId) return [];

  const db = supabaseAdmin();

  // 第一段：這個人有哪些訂單。歸屬過濾在這裡，而且只在這裡。
  const { data: orderRows, error: orderError } = await db
    .from("orders")
    .select("id, order_no")
    .eq("user_id", userId);

  if (orderError) throw new Error(`無法讀取訂單：${orderError.message}`);

  const orders = (orderRows ?? []) as unknown as { id: string; order_no: string }[];
  if (orders.length === 0) return [];

  const orderNoById = new Map(orders.map((o) => [o.id, o.order_no]));

  // 第二段：只認上面那串 id。
  const { data, error } = await db
    .from("event_registrations")
    .select(
      "order_id, seat_no, name, session_id, event_sessions!inner(title, location, starts_at, ends_at)",
    )
    .in(
      "order_id",
      orders.map((o) => o.id),
    )
    .order("created_at", { ascending: false });

  if (error) throw new Error(`無法讀取活動報名：${error.message}`);

  type RegRow = {
    order_id: string;
    seat_no: number;
    name: string;
    session_id: string;
    // PostgREST 對 to-one 的 embed 可能回物件或單元素陣列，兩種都吃。
    event_sessions:
      | { title: Localized; location: Localized; starts_at: string; ends_at: string | null }
      | { title: Localized; location: Localized; starts_at: string; ends_at: string | null }[]
      | null;
  };

  return ((data ?? []) as unknown as RegRow[]).flatMap((r) => {
    const s = Array.isArray(r.event_sessions) ? r.event_sessions[0] : r.event_sessions;
    if (!s) return [];
    return [
      {
        orderNo: orderNoById.get(r.order_id) ?? "",
        seatNo: r.seat_no,
        name: r.name,
        sessionId: r.session_id,
        sessionTitle: s.title,
        sessionLocation: s.location,
        startsAt: s.starts_at,
        endsAt: s.ends_at,
      },
    ];
  });
}

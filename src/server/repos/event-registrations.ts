/**
 * Data layer for public.event_registrations — the attendee list.
 *
 * ⚠️ 這張表是這個專案第一張「非訂購人的第三人個資」。
 * ------------------------------------------------------
 * 0020 §2 讓它跟 0005 的電商表一樣：**RLS 開著、零 policy、anon 與 authenticated
 * 零 grant**。瀏覽器沒有任何一條查詢打得到它，唯一的入口是 service_role，也就是
 * 這個檔案。所以這裡漏掉什麼，就沒有第二道門會擋。
 *
 * 三條規矩，每一條都對應一個具體的失敗：
 *
 *   1. **這個檔案不回明文聯絡方式。** listSessionRoster() 回的是遮罩過的
 *      `phone_masked` / `email_masked`，姓名則是全名（遮了現場點不了名，與 0019
 *      讓廠商名稱明文、只遮識別碼是同一條線）。要看單列明文是 Phase 2 的
 *      `reveal_registration_contact()`，它會在同一個交易裡先寫一筆
 *      public.pii_access_log 才回傳值 —— 讀成功 ⇔ 有紀錄。
 *
 *      ⚠️ 遮罩現在做在 TypeScript 這一側（maskTail 底下），不是 SQL。0019 §2 的
 *      線是「遮罩寫在 view 的 select list 裡，完整值不會離開資料庫」，而這一期還
 *      沒有那個 view —— Phase 2 的 0021 會建 public.admin_event_roster（用
 *      inv.mask_tail()）並把這裡換掉。在那之前，明文會進到這個 Node 行程的記憶體，
 *      但**不會離開它**：下面每一支函式回的型別裡都沒有明文欄位。這是這一期的
 *      折衷，寫出來是為了讓 Phase 2 知道要換的是哪一段，而不是讓它看起來已經完成。
 *
 *   2. **console.error 只印 error.code 與 error.message，不印整包 error。**
 *      PostgREST 會把 Postgres 的 `DETAIL: Failing row contains (…)` 一路傳回來，
 *      而對這張表來說那一行就是某個人的姓名與電話。整包記下去就是把參加者的個資
 *      寫進 Vercel 的 log —— 一個沒有保存期限、沒有存取紀錄、也沒有任何人知道它在
 *      那裡的地方。scripts/event-registration-selftest.mjs 有靜態測試守著這一條。
 *
 *   3. **這個檔案不寫入。** 報名資料只由 reserve_session_seat() 寫、只由
 *      release_session_seat() 與 expire_unpaid_orders() 刪，因為「佔了 N 個位子」
 *      與「有 N 位參加者」必須是同一句 SQL 的兩個面向（0020 §2）。這裡多一條
 *      insert 或 delete，那個不變量就沒了。
 *
 * 保留期限：**不做自動清除**，與 orders 一致（業務紀錄，商業會計法五年）。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";

/**
 * ⚠️ 明文欄位（name / email / phone）**只在這個型別裡出現**，而且它不 export。
 * 它是 select 回來的原始列，出這個檔案之前一定會經過 toMasked()。
 */
const COLUMNS =
  "id, session_id, order_id, order_item_id, seat_no, name, email, phone, notice_ack_at, created_at";

type RawRegistrationRow = {
  id: string;
  session_id: string;
  order_id: string;
  order_item_id: number;
  seat_no: number;
  name: string;
  email: string | null;
  phone: string | null;
  notice_ack_at: string | null;
  created_at: string;
};

/** 名單頁看得到的一列。沒有明文 email / phone。 */
export type RegistrationRosterRow = {
  id: string;
  session_id: string;
  order_id: string;
  order_item_id: number;
  seat_no: number;
  /** 全名，不遮罩 —— 遮了現場點不了名（同 0019 對廠商名稱的處置）。 */
  name: string;
  email_masked: string | null;
  phone_masked: string | null;
  /** 只回「有沒有同意」與「什麼時候」，那不是敏感值。 */
  notice_ack_at: string | null;
  created_at: string;
  /** 這一列屬於哪一張訂單，讓店員對得回去。 */
  order_no: string;
  payment_status: string;
};

/**
 * 遮罩，與 0019 的 inv.mask_tail(value, keep_tail, keep_head) 同一套規則，
 * 逐條對應：
 *
 *   - 空字串一律回 null —— 讓「沒填」與「填了但看不到」在畫面上長得不一樣。
 *   - 太短的值整串變星號 —— 留 4 碼的規則套在 4 碼的值上等於沒遮。
 *
 * Phase 2 會改成呼叫 SQL 那一支，這裡就整段拿掉。兩份實作同時存在的期間只有這
 * 一期，而且這一份的輸出格式是照著那一支寫的，所以換過去時畫面不會變。
 */
function maskTail(value: string | null, keepTail: number, keepHead = 0): string | null {
  const v = (value ?? "").trim();
  if (v === "") return null;
  if (v.length <= keepTail + keepHead) return "*".repeat(v.length);
  return v.slice(0, keepHead) + "*".repeat(v.length - keepTail - keepHead) + v.slice(-keepTail);
}

/**
 * 電話留後 4 碼（`******7890`），信箱留頭 1 碼與 domain（`a****@example.com`）。
 *
 * 信箱不用 mask_tail 的理由：尾碼是 domain，遮了尾巴等於什麼都沒遮（大家都是
 * @gmail.com），遮了 domain 又會讓「這是不是同一個人」看不出來。所以遮的是
 * local part。
 */
function maskEmail(value: string | null): string | null {
  const v = (value ?? "").trim();
  if (v === "") return null;
  const at = v.lastIndexOf("@");
  if (at <= 0) return maskTail(v, 2);
  return `${maskTail(v.slice(0, at), 0, 1) ?? "*"}${v.slice(at)}`;
}

function toMasked(
  row: RawRegistrationRow,
  order: { order_no: string; payment_status: string } | undefined,
): RegistrationRosterRow {
  return {
    id: row.id,
    session_id: row.session_id,
    order_id: row.order_id,
    order_item_id: row.order_item_id,
    seat_no: row.seat_no,
    name: row.name,
    email_masked: maskEmail(row.email),
    phone_masked: maskTail(row.phone, 4),
    notice_ack_at: row.notice_ack_at,
    created_at: row.created_at,
    order_no: order?.order_no ?? "",
    payment_status: order?.payment_status ?? "unknown",
  };
}

/**
 * 一個場次的名單，遮罩過。
 *
 * ⚠️ 回的是**所有**報名，包含未付款與已取消的訂單，而且每一列都帶著
 *    `payment_status` 讓畫面自己分。Phase 2 的簽到表只算 `paid`，但那是簽到表的
 *    規則，不是這支查詢的規則 —— 後台需要看得到「有 3 個位子被未付款的訂單押著」，
 *    否則「為什麼還有 3 個位子卻報不了名」這個問題沒有地方可以回答。
 *
 * 兩次查詢而不是一次 join：PostgREST 的巢狀 select 會把 orders 整列拉回來，而那
 * 一列有訂購人的姓名電話 —— 這裡不需要它們，所以不去要。
 */
export async function listSessionRoster(sessionId: string): Promise<RegistrationRosterRow[]> {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("event_registrations")
    .select(COLUMNS)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .order("seat_no", { ascending: true });

  if (error) {
    console.error(`[repo/event-registrations] roster 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/event-registrations] roster 失敗：${error.code}`);
  }

  const rows = (data ?? []) as unknown as RawRegistrationRow[];
  if (rows.length === 0) return [];

  const orderIds = [...new Set(rows.map((r) => r.order_id))];
  const { data: orderRows, error: orderError } = await db
    .from("orders")
    .select("id, order_no, payment_status")
    .in("id", orderIds);

  if (orderError) {
    console.error(
      `[repo/event-registrations] roster orders 失敗：${orderError.code} ${orderError.message}`,
    );
    throw new Error(`[repo/event-registrations] roster orders 失敗：${orderError.code}`);
  }

  const byOrder = new Map(
    ((orderRows ?? []) as unknown as { id: string; order_no: string; payment_status: string }[]).map(
      (o) => [o.id, o],
    ),
  );
  return rows.map((r) => toMasked(r, byOrder.get(r.order_id)));
}

/**
 * 每個場次有幾位報名、其中幾位是已付款的。
 *
 * 場次列表要顯示這兩個數字，而 `event_sessions.seats_taken` 只回答第一個 —— 而且
 * 回答的是「押住了幾個位子」，不是「有幾個人」。舊訂單回填出來的列刻意只有一位
 * （0020 §4.4），所以這兩個數字在那些場次上本來就會不一樣，畫面必須看得出來。
 *
 * 沒有 group by 就自己數：PostgREST 沒有便宜的 group by，而場次是幾十列的量級。
 * 同 src/server/repos/events.ts 的 countEventsByCategory()。
 */
export async function countRegistrationsBySession(): Promise<
  Record<string, { total: number; paid: number }>
> {
  const db = supabaseAdmin();

  const { data, error } = await db.from("event_registrations").select("session_id, order_id");
  if (error) {
    console.error(`[repo/event-registrations] count 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/event-registrations] count 失敗：${error.code}`);
  }
  const rows = (data ?? []) as unknown as { session_id: string; order_id: string }[];
  if (rows.length === 0) return {};

  const { data: paidRows, error: paidError } = await db
    .from("orders")
    .select("id")
    .eq("payment_status", "paid")
    .in("id", [...new Set(rows.map((r) => r.order_id))]);
  if (paidError) {
    console.error(
      `[repo/event-registrations] count orders 失敗：${paidError.code} ${paidError.message}`,
    );
    throw new Error(`[repo/event-registrations] count orders 失敗：${paidError.code}`);
  }
  const paidIds = new Set(((paidRows ?? []) as unknown as { id: string }[]).map((o) => o.id));

  const counts: Record<string, { total: number; paid: number }> = {};
  for (const r of rows) {
    const entry = (counts[r.session_id] ??= { total: 0, paid: 0 });
    entry.total += 1;
    if (paidIds.has(r.order_id)) entry.paid += 1;
  }
  return counts;
}

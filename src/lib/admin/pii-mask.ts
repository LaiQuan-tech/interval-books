/**
 * PII 遮罩 —— 後台訂單頁（/admin/orders）用。
 *
 * ── 為什麼是 TypeScript，不是資料庫（跟 0021 的 inv.mask_email／inv.mask_tail 不同）
 *
 * 0021 把報名名單的遮罩搬進 SQL，理由是「完整值不會離開資料庫」。這裡做不到同一件
 * 事：inv schema 沒有進 PostgREST 的 db_schema（0021 §2 檔頭：「這支函式從瀏覽器打
 * 不到，連 service_role 的 supabase-js client 都打不到」），所以
 * `supabaseAdmin().rpc('mask_email', …)` 從這個專案的任何一支 server fn 都呼叫不到
 * inv.mask_email／inv.mask_tail —— 那兩支是給**其他 SQL 函式**呼叫的，不是給
 * PostgREST 呼叫的。要在 SQL 那一層遮 orders 的聯絡方式，需要一支新的
 * public.admin_* view（比照 0021 §3 的 admin_event_roster），而那是一支 migration。
 *
 * src/server/repos/orders-admin.ts 檔頭記錄了完整理由：這一期的範圍刻意不含那支
 * migration，所以遮罩退而求其次做在應用層 —— 跟 0021 §2 註解裡說的「Phase 1 的
 * 折衷」是同一個等級的妥協：完整值仍然會進到這個 Node 行程的記憶體，只是不會被
 * 序列化進任何一支 server fn 的回傳值，所以不會離開伺服器。
 *
 * ⚠️ 演算法**逐字對照** supabase/migrations/0019_vendors_pii_portal.sql §2 的
 *    inv.mask_tail()，以及 0021_roster_pii.sql §2 的 inv.mask_email()，不是另外
 *    發明一套。0021 §2 檔頭記錄過一個真的 bug：TypeScript 寫成
 *    `v.slice(0, keepHead) + '*'.repeat(...) + v.slice(-keepTail)` 時，keepTail=0
 *    會讓 `v.slice(-0)` 等於 `v.slice(0)` —— 整段字串被接回去一次
 *    （"ab@x.com" 會遮成 "a*ab@x.com"）。下面的寫法刻意不用負數索引，改用
 *    `v.length - keepTail` 算切點，讓同一個 bug 沒有機會重演；
 *    scripts/admin-orders-selftest.mjs 有專門的案例守著這一條。
 *
 * 純函式，沒有任何 import：讓 selftest 可以直接 `import()` 這個檔案本人，不必經過
 * bundler 或 `@/` alias 解析（同 src/lib/admin/nav-active.ts 檔頭的理由——那個檔案
 * 也是為了同一個目的一行 import 都沒有）。
 */

/**
 * 遮罩：留頭 `keepHead` 碼、留尾 `keepTail` 碼，中間換成星號。
 *
 * 值太短（trim 後長度 <= keepHead + keepTail）時整串變星號 —— 留尾規則套在短值上
 * 等於沒遮。null／undefined／空字串／全空白一律回 `null`，讓「沒填」與「填了但你
 * 看不到」在畫面上長得不一樣（同 inv.mask_tail 的註解）。
 *
 * 逐字對照 0019 §2 的 inv.mask_tail(p_value, p_keep_tail, p_keep_head)。
 */
export function maskTail(
  value: string | null | undefined,
  keepTail: number,
  keepHead = 0,
): string | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (v === "") return null;

  if (v.length <= keepTail + keepHead) return "*".repeat(v.length);

  const head = keepHead > 0 ? v.slice(0, keepHead) : "";
  // ⚠️ 不要寫成 v.slice(-keepTail)：keepTail=0 時 slice(-0) 等於 slice(0)，會把
  //    整段尾巴接回去（見檔頭那個真 bug）。用長度算切點沒有這個坑。
  const tail = keepTail > 0 ? v.slice(v.length - keepTail) : "";
  const stars = "*".repeat(v.length - keepHead - keepTail);
  return head + stars + tail;
}

/**
 * 信箱遮罩：遮 local part、留首碼 1 碼與完整 domain（`a****@example.com`）。
 * 沒有 `@`、或 `@` 是第一個字元（local part 是空的）：當一般字串處理，遮尾 2 碼。
 *
 * 逐字對照 0021 §2 的 inv.mask_email()：local part 以**最後一個** `@` 切開 ——
 * `a@b@c.com` 這種不合法但存得進去的值，domain 取的是最後一段（`@c.com`），
 * local part 是 `a@b`。
 */
export function maskEmail(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (v === "") return null;

  const at = v.lastIndexOf("@");
  // at === -1：沒有 @。at === 0：@ 是第一個字元，local part 是空的。
  // 兩種情況 SQL 的 `t.v !~ '^.+@'` 都成立（regexp 要求 @ 之前至少 1 個字元），
  // 一律當一般字串遮尾 2 碼。
  if (at <= 0) return maskTail(v, 2);

  const local = v.slice(0, at);
  const domain = v.slice(at); // 含開頭的 @
  return (maskTail(local, 0, 1) ?? "*") + domain;
}

/**
 * 廠商這一頁的三個動作：審核／退回廠商、刪除廠商、審核廠商送審的商品。
 *
 * 照 useComboActions.ts 的五步慣例：設 busy → dynamic import server fn → 看回傳
 * 決定 toast → `await refresh()` → 清 busy。
 *
 * ⚠️ 每一支都 `await refresh()`。這個 repo 沒有 client 端查詢快取層 —— 重新抓一次
 *    就是唯一的同步方式，也是「另一個店員剛剛核准了什麼」會被看見的時機。
 *
 * ⚠️ 每一個 import 都是 dynamic。server fn 模組會把 zod schema 與 repo 一起拉進來，
 *    靜態 import 會讓它們進入首屏 bundle。
 *
 * ⚠️ **這一層完全不做授權判斷。** 這裡連 canApprove 都沒有收 —— 因為「能不能做」
 *    的答案不在瀏覽器。approve_vendors／approve_products 各自在
 *    fns/inv-vendors.ts 的 requirePermission() 重讀 staff_permissions 再判一次，
 *    沒有權限的人打進來拿到的是 NotAuthorizedError，而下面的 catch 會把那句話原樣
 *    toast 出來。畫面上把按鈕變灰只是為了不要讓人白按。
 *
 * ⚠️ 廠商**沒有**「重新送審」。inv_save_vendor() 的 UPDATE 分支刻意不碰
 *    approval_status（0019 SQL 裡那行註解「編輯不該改審核狀態」），而
 *    inv_approve_record() 只允許 pending → approved/rejected。所以被退回的廠商
 *    是終點，不像套餐有 inv_resubmit_combo_set()。這裡不提供 handleResubmit，
 *    是因為沒有那一支 server fn，不是忘了寫。
 */
import { useState } from "react";
import { toast } from "sonner";
import type { VendorSubmissionApprovalValues } from "@/lib/admin/schemas";
import type { AdminVendorRow, VendorSubmissionRow } from "@/server/repos/inv-vendors";

export function useVendorActions(refresh: () => Promise<void>) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function withId(id: string, run: () => Promise<void>) {
    setBusyId(id);
    try {
      await run();
    } finally {
      setBusyId(null);
    }
  }

  async function handleApprove(row: AdminVendorRow, approved: boolean) {
    await withId(row.vendor_id, async () => {
      try {
        const { approveVendor } = await import("@/lib/admin/fns/inv-vendors");
        const result = await approveVendor({ data: { id: row.vendor_id, approved } });
        if (!result.changed) {
          // changed=false 代表這一筆已經不是 pending 了 —— 兩個店員同時按下去，
          // 或者上一次按完沒有重新整理。這不是錯誤，是競態，所以用 info 不是 error。
          toast.info(`「${row.name}」已經有人審過了（目前：${result.previous_status ?? "未知"}）`);
        } else {
          toast.success(approved ? `「${row.name}」已核准往來` : `「${row.name}」已退回`);
        }
        await refresh();
      } catch (err) {
        // 沒有 approve_vendors 的人打到這裡會拿到 NotAuthorizedError ——
        // 按鈕變灰只是畫面，真正擋人的是 server fn 裡那一次權限檢查。
        toast.error(err instanceof Error ? err.message : "審核失敗");
      }
    });
  }

  async function handleDelete(row: AdminVendorRow) {
    await withId(row.vendor_id, async () => {
      try {
        const { deleteVendor } = await import("@/lib/admin/fns/inv-vendors");
        const result = await deleteVendor({ data: { vendorId: row.vendor_id } });
        toast.success(`已刪除廠商「${result.name}」`);
        await refresh();
      } catch (err) {
        // inv_delete_vendor() 擋下來的時候會講出「還有 N 件商品、N 筆進貨、N 張
        // 退貨單、N 個自助入口帳號」與「解約請把往來狀態改成已終止」——
        // 那是唯一會告訴店員該怎麼辦的一句話，改寫成「刪除失敗」等於把它弄丟。
        toast.error(err instanceof Error ? err.message : "刪除失敗");
      }
    });
  }

  /**
   * 核准／退回一件廠商送審的商品，可選同時上架。
   *
   * listing 不是 null 的時候，核准與上架在**同一個資料庫交易**裡完成
   * （inv_approve_vendor_product）—— 不會出現「審過了但沒上架」這種半套狀態。
   */
  async function handleSubmissionDecision(
    row: VendorSubmissionRow,
    approved: boolean,
    listing: VendorSubmissionApprovalValues["listing"],
  ) {
    await withId(row.inv_product_id, async () => {
      try {
        const { approveVendorSubmission } = await import("@/lib/admin/fns/inv-vendors");
        const result = await approveVendorSubmission({
          data: { id: row.inv_product_id, approved, listing },
        });
        if (!result.changed) {
          toast.info(`「${row.name}」已經有人審過了（目前：${result.previous_status ?? "未知"}）`);
        } else if (result.listed) {
          toast.success(`「${row.name}」已核准並上架（${result.slug ?? ""}）`);
        } else {
          toast.success(approved ? `「${row.name}」已核准` : `「${row.name}」已退回`);
        }
        await refresh();
      } catch (err) {
        // 需要 approve_products（不是 approve_vendors）。同樣地，擋人的是 server fn。
        // 網址代稱撞號的 23505 也會走到這裡，資料庫那一層已經翻成中文了。
        toast.error(err instanceof Error ? err.message : "審核失敗");
      }
    });
  }

  return { busyId, handleApprove, handleDelete, handleSubmissionDecision };
}

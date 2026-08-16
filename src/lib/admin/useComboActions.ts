/**
 * 套餐的四個動作：上架／下架、刪除、重新送審、審核／退回。
 *
 * 照 useAdjustmentActions.ts 的五步慣例：設 busy → dynamic import server fn → 看
 * 回傳決定 toast → `await refresh()` → 清 busy。
 *
 * ⚠️ 每一支都 `await refresh()`。這個 repo 沒有 client 端的查詢快取層 —— 重新抓一次就是
 *    唯一的同步方式，而它同時也是「另一個店員剛剛核准了什麼」會被看見的時機。
 *
 * ⚠️ 這裡的每一個 import 都是 dynamic。server fn 模組會把 zod schema 與 repo 一起
 *    拉進來，靜態 import 會讓它們進入首屏 bundle。
 *
 * ⚠️ 這一層**不判斷**「這個套餐現在能不能做這個動作」。狀態機在資料庫
 *    （inv_set_combo_set_active / inv_delete_combo_set / inv_resubmit_combo_set），
 *    這裡只是把它寫給店員看的整句中文原樣 toast 出來 —— 例如「已經賣過的套餐不可
 *    刪除」就是資料庫講的，不是這裡編的。
 */
import { useState } from "react";
import { toast } from "sonner";
import type { AdminComboSetRow } from "@/server/repos/inv-combos";

export function useComboActions(refresh: () => Promise<void>) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function withRow(row: AdminComboSetRow, run: () => Promise<void>) {
    setBusyId(row.combo_set_id);
    try {
      await run();
    } finally {
      setBusyId(null);
    }
  }

  async function handleToggleActive(row: AdminComboSetRow) {
    await withRow(row, async () => {
      try {
        const { setComboSetActive } = await import("@/lib/admin/fns/inv-combos");
        const result = await setComboSetActive({
          data: { id: row.combo_set_id, isActive: !row.is_active },
        });
        toast.success(result.is_active ? `「${result.name}」已上架` : `「${result.name}」已下架`);
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "上下架失敗");
      }
    });
  }

  async function handleDelete(row: AdminComboSetRow) {
    await withRow(row, async () => {
      try {
        const { deleteComboSet } = await import("@/lib/admin/fns/inv-combos");
        const result = await deleteComboSet({ data: { id: row.combo_set_id } });
        toast.success(`已刪除套餐「${result.name}」`);
        await refresh();
      } catch (err) {
        // 「已經有銷售紀錄的套餐不可刪除」是 inv_delete_combo_set() 寫給店員看的整句
        // 中文，原樣顯示 —— 改寫成「刪除失敗」等於把唯一的解釋弄丟。
        toast.error(err instanceof Error ? err.message : "刪除失敗");
      }
    });
  }

  async function handleResubmit(row: AdminComboSetRow) {
    await withRow(row, async () => {
      try {
        const { resubmitComboSet } = await import("@/lib/admin/fns/inv-combos");
        const result = await resubmitComboSet({ data: { id: row.combo_set_id } });
        toast.success(`「${result.name}」已重新送審`);
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "重新送審失敗");
      }
    });
  }

  async function handleApprove(row: AdminComboSetRow, approved: boolean) {
    await withRow(row, async () => {
      try {
        const { approveComboSet } = await import("@/lib/admin/fns/inv-combos");
        const result = await approveComboSet({
          data: { id: row.combo_set_id, approved },
        });
        if (!result.changed) {
          toast.info(`「${row.name}」已經有人審過了（目前：${result.previous_status ?? "未知"}）`);
        } else {
          toast.success(approved ? `「${row.name}」已核准，可以開始販售` : `「${row.name}」已退回`);
        }
        await refresh();
      } catch (err) {
        // 沒有 approve_combo_sets 的人打到這裡會拿到 NotAuthorizedError ——
        // 藏按鈕只是畫面，真正擋人的是 server fn 裡那一次權限檢查。
        toast.error(err instanceof Error ? err.message : "審核失敗");
      }
    });
  }

  return { busyId, handleToggleActive, handleDelete, handleResubmit, handleApprove };
}

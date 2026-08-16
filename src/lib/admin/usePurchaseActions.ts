/**
 * 進貨清單上的三個動作：審核／退回、刪除、批次審核。
 *
 * 與 useProductActions 同一套五步慣例（setBusy → dynamic import → 呼叫 server fn
 * → toast → await refresh()）。抽出來的理由也一樣：route 檔留著它們，真正的版面
 * 就會被推到 300 行以外。
 *
 * ⚠️ 每一支都 `await refresh()`。這個 repo 沒有 react-query —— 重跑一次清單就是唯一
 *    的同步方式，也是「另一個店員剛剛改了什麼」會被看見的時機。
 *
 * ⚠️ 每一個 import 都是 dynamic。server fn 模組會把 zod schema 一起拉進來，靜態
 *    import 會讓它進首屏 bundle。
 *
 * ⚠️ 錯誤訊息**原樣**丟給 toast。inv_delete_purchase() 的守衛（「已經賣掉 N 件的
 *    批次不能刪，請改開一張在庫異動單」）是寫給店員看的整句中文，改寫它只會把
 *    「我現在該做什麼」這個資訊弄丟。
 */
import { useState } from "react";
import { toast } from "sonner";
import type { AdminPurchaseRow } from "@/server/repos/inv-purchases";

export function usePurchaseActions(refresh: () => Promise<void>) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  async function withRow<T>(row: AdminPurchaseRow, run: () => Promise<T>) {
    setBusyId(row.purchase_id);
    try {
      return await run();
    } finally {
      setBusyId(null);
    }
  }

  async function handleApprove(row: AdminPurchaseRow, approved: boolean) {
    await withRow(row, async () => {
      try {
        const { approveRecord } = await import("@/lib/admin/fns/inv-purchases");
        const result = await approveRecord({
          data: { module: "purchases", id: row.purchase_id, approved },
        });
        if (result.changed) {
          toast.success(approved ? "已審核通過" : "已退回");
        } else {
          toast.info(`這一筆已經有人處理過了（目前：${result.previous_status ?? "未知"}）`);
        }
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "審核失敗");
      }
    });
  }

  async function handleDelete(row: AdminPurchaseRow) {
    await withRow(row, async () => {
      try {
        const { deletePurchase } = await import("@/lib/admin/fns/inv-purchases");
        const result = await deletePurchase({ data: { id: row.purchase_id } });
        toast.success(
          result.stock_rolled_back
            ? `已刪除這一批 ${result.quantity} 件，庫存已經一起收回`
            : `已刪除這一批 ${result.quantity} 件`,
        );
        await refresh();
      } catch (err) {
        // 已經被 FIFO 吃掉的批次會被 trigger 擋下來，那句中文含「請改開一張在庫
        // 異動單」——原樣顯示，不要包成「刪除失敗」。
        toast.error(err instanceof Error ? err.message : "刪除失敗");
      }
    });
  }

  /**
   * 批次審核。只送目前是 pending 的那幾筆 —— 整批覆寫會把三個月前就通過的批次
   * 重寫成「今天某某人核准的」。
   */
  async function handleBatchApprove(approved: boolean, pendingIds: string[]) {
    if (pendingIds.length === 0) return;
    setBatchBusy(true);
    try {
      const { approveRecord } = await import("@/lib/admin/fns/inv-purchases");
      let done = 0;
      for (const id of pendingIds) {
        const result = await approveRecord({ data: { module: "purchases", id, approved } });
        if (result.changed) done += 1;
      }
      toast.success(`已${approved ? "通過" : "退回"} ${done} 筆`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "批次審核失敗");
    } finally {
      setBatchBusy(false);
    }
  }

  return { busyId, batchBusy, handleApprove, handleDelete, handleBatchApprove };
}

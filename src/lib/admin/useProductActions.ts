/**
 * 商品清單上的六個動作：審核、調價審核、重新送審、上下架、刪除、批次審核。
 *
 * 從 route 檔抽出來，因為那個檔案原本同時是「路由 + 載入 + 篩選狀態 + 對話框狀態
 * + 六個 mutation + 版面」。抽出來之後 route 只剩下狀態與版面，而每一個動作的
 * 錯誤處理／toast 文案／重載時機都在同一個地方看得完。
 *
 * ⚠️ 每一支都 `await refresh()`。這個 repo 沒有 react-query —— 重新跑 loader 就是
 *    唯一的同步方式，而它同時也是「另一個店員剛剛改了什麼」會被看見的時機。
 *
 * ⚠️ 這裡的每一個 import 都是 dynamic。server fn 模組會把 zod schema 一起拉進來，
 *    靜態 import 會讓它進入首屏 bundle。
 */
import { useState } from "react";
import { toast } from "sonner";
import type { AdminProductRow } from "@/server/repos/inv-products";

export function useProductActions(refresh: () => Promise<void>) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);

  async function withRow<T>(row: AdminProductRow, run: () => Promise<T>) {
    setBusyId(row.inv_product_id);
    try {
      return await run();
    } finally {
      setBusyId(null);
    }
  }

  async function handleApprove(row: AdminProductRow, approved: boolean) {
    await withRow(row, async () => {
      try {
        const { approveRecord } = await import("@/lib/admin/fns/inv-products");
        const result = await approveRecord({
          data: { module: "products", id: row.inv_product_id, approved },
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

  async function handleApprovePrice(row: AdminProductRow, approved: boolean) {
    await withRow(row, async () => {
      try {
        const { approveRecord } = await import("@/lib/admin/fns/inv-products");
        const result = await approveRecord({
          data: { module: "price_changes", id: row.inv_product_id, approved },
        });
        toast.success(
          result.changed
            ? approved
              ? "調價已核准，新價格已生效"
              : "調價已退回，價格維持原樣"
            : "這一筆調價已經有人處理過了",
        );
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "調價審核失敗");
      }
    });
  }

  async function handleResubmit(row: AdminProductRow) {
    await withRow(row, async () => {
      try {
        const { resubmitProduct } = await import("@/lib/admin/fns/inv-products");
        await resubmitProduct({ data: { id: row.inv_product_id } });
        toast.success("已重新送審");
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "重新送審失敗");
      }
    });
  }

  async function handleToggleActive(row: AdminProductRow) {
    await withRow(row, async () => {
      try {
        const { setProductActive } = await import("@/lib/admin/fns/inv-products");
        const result = await setProductActive({
          data: { id: row.inv_product_id, is_active: !row.is_active },
        });
        if (!result.is_active && result.listed_count > 0) {
          toast.warning(
            `「${result.name}」已停用，但它還掛在 ${result.listed_count} 件上架中的網站商品上 —— 網站那一頁現在買得下去但櫃檯出不了貨。請去「上架」頁下架。`,
          );
        } else {
          toast.success(result.is_active ? "已恢復上架" : "已停用");
        }
        await refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "上下架失敗");
      }
    });
  }

  async function handleDelete(row: AdminProductRow) {
    await withRow(row, async () => {
      try {
        const { deleteProduct } = await import("@/lib/admin/fns/inv-products");
        const result = await deleteProduct({ data: { id: row.inv_product_id } });
        toast.success(`已刪除「${result.name}」`);
        await refresh();
      } catch (err) {
        // 賣過的／還掛在型錄上的會被擋下來，訊息是 inv_delete_product() 寫給
        // 店員看的整句中文（含「請改用停用」），原樣顯示。
        toast.error(err instanceof Error ? err.message : "刪除失敗");
      }
    });
  }

  async function handleBatchApprove(approved: boolean, pendingIds: string[]) {
    if (pendingIds.length === 0) return;
    setBatchBusy(true);
    try {
      const { approveRecord } = await import("@/lib/admin/fns/inv-products");
      let done = 0;
      for (const id of pendingIds) {
        const result = await approveRecord({ data: { module: "products", id, approved } });
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
  return {
    busyId,
    batchBusy,
    handleApprove,
    handleApprovePrice,
    handleResubmit,
    handleToggleActive,
    handleDelete,
    handleBatchApprove,
  };
}

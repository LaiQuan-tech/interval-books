/**
 * 商品清單的「篩選 → 重抓 → 同步」那一組狀態。
 *
 * 與 useProductActions（寫入動作）並排：那一支管「按下去會發生什麼」，這一支管
 * 「畫面上現在是哪一頁」。拆開的理由與 4b 拆 usePurchaseActions 相同 —— route 檔
 * 的 300 行上限不是為了好看，是為了讓下一次「順手加一點」不會把它長回來源那種
 * 1,597 行的樣子。
 *
 * ⚠️ 這個專案**沒有 react-query**。寫入之後重抓就是唯一的同步方式，而且要兩段：
 *    reload() 重抓這一頁的資料，router.invalidate() 重跑 loader（母品項候選與
 *    審核設定放在那裡）。少做第二段的話，改完審核設定畫面上的提示不會更新。
 */
import { useCallback, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import type { ProductFilterValues } from "@/lib/admin/schemas";
import type { AdminProductRow } from "@/server/repos/inv-products";

type Page = { rows: AdminProductRow[]; total: number };

export function useProductListState(initialPage: Page, defaultFilter: ProductFilterValues) {
  const router = useRouter();

  const [filter, setFilter] = useState<ProductFilterValues>(defaultFilter);
  const [data, setData] = useState<Page>(initialPage);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const reload = useCallback(async (next: ProductFilterValues) => {
    setLoading(true);
    try {
      const { listAdminProducts } = await import("@/lib/admin/fns/inv-products");
      setData(await listAdminProducts({ data: next }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "商品清單讀取失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  /** 換篩選條件時把勾選清掉 —— 留著會讓「已選 3 筆」指向看不見的列。 */
  const changeFilter = useCallback(
    (next: ProductFilterValues) => {
      setFilter(next);
      setSelectedIds([]);
      void reload(next);
    },
    [reload],
  );

  const changePage = useCallback(
    (page: number) => {
      const next = { ...filter, page };
      setFilter(next);
      void reload(next);
    },
    [filter, reload],
  );

  /** 寫入之後重抓目前這一頁，並讓 loader 重跑。 */
  const refresh = useCallback(async () => {
    await reload(filter);
    await router.invalidate();
  }, [filter, reload, router]);

  const rowsById = useMemo(() => {
    const map = new Map<string, AdminProductRow>();
    for (const r of data.rows) map.set(r.inv_product_id, r);
    return map;
  }, [data.rows]);

  const selectedPending = useMemo(
    () => selectedIds.filter((id) => rowsById.get(id)?.approval_status === "pending"),
    [selectedIds, rowsById],
  );

  const totalPages = Math.max(1, Math.ceil(data.total / filter.pageSize));

  return {
    filter,
    data,
    loading,
    selectedIds,
    setSelectedIds,
    changeFilter,
    changePage,
    refresh,
    rowsById,
    selectedPending,
    totalPages,
  };
}

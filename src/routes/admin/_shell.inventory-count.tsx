/**
 * /admin/inventory-count —— 庫存盤點
 *
 * 盤帳面庫存，差異透過「在庫異動」記錄（category = 'ADJ'）。盤點與在庫異動在畫面上
 * 是兩頁，在資料庫是**同一張 inv.stock_adjustments**。
 *
 * ── 這一頁修掉的兩個東西 ─────────────────────────────────────────────────
 * · **送的是實盤數量，不是差異。** 差異由 inv_record_stock_count() 用當下的
 *   stock_quantity 算。來源在瀏覽器算，而那個 stock_quantity 是頁面載入時抓的 ——
 *   對話框開著十分鐘、櫃檯中間賣掉三本，送出的差異就會多扣三本。
 * · **審核開關對盤點是有效的。** 來源把 status 硬寫成 'confirmed'，approval_settings
 *   裡的 stock_adjustments 那一列形同虛設。這一頁的 payload 裡沒有 status 這個欄位，
 *   下面那個 `countApprovalOn` 只拿來寫提示文字。
 *
 * ⚠️ 篩選與分頁都在資料庫端（repos/inv-adjustments.ts 的 range()）。來源是把 993 筆
 *    整份撈回瀏覽器再 Array.filter，而且每一次寫入都重抓一次。
 */
import { useCallback, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ClipboardCheck, ClipboardList, History, Loader2, Package, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BatchStockCountDialog } from "@/components/inventory/BatchStockCountDialog";
import { ProductPagination } from "@/components/inventory/ProductPagination";
import { StockCountDialog } from "@/components/inventory/StockCountDialog";
import { RecentStockCounts, StockCountTable } from "@/components/inventory/StockCountTable";
import { isApprovalRequired } from "@/lib/admin/inv-product-utils";
import { INV_PRODUCT_TYPES, INV_PRODUCT_TYPE_LABELS } from "@/lib/admin/schemas";
import type { StockCountProductRow } from "@/server/repos/inv-adjustments";

/** Radix Select 不接受空字串當 value，所以「全部」用這個哨兵值。 */
const ALL = "__all__";

type CountFilter = {
  keyword: string | null;
  categoryId: string | null;
  productType: (typeof INV_PRODUCT_TYPES)[number] | null;
  lowStockOnly: boolean;
  page: number;
  pageSize: number;
};

const DEFAULT_FILTER: CountFilter = {
  keyword: null,
  categoryId: null,
  productType: null,
  lowStockOnly: false,
  page: 0,
  pageSize: 50,
};

/** 最近盤點紀錄 = 六類裡的 ADJ 那一類，最新的 20 筆。 */
const RECENT_FILTER = {
  keyword: null,
  category: "ADJ" as const,
  status: "all" as const,
  productId: null,
  dateFrom: null,
  dateTo: null,
  sort: "created_at" as const,
  page: 0,
  pageSize: 20,
};

export const Route = createFileRoute("/admin/_shell/inventory-count")({
  loader: async () => {
    const {
      getAdjustmentSummary,
      listAdjustmentFormOptions,
      listAdminAdjustments,
      listStockCountProducts,
    } = await import("@/lib/admin/fns/inv-adjustments");
    // 四支都是 staffFnMiddleware 守的。店員進得來、customer 進不來。
    const [page, options, summary, recent] = await Promise.all([
      listStockCountProducts({ data: DEFAULT_FILTER }),
      listAdjustmentFormOptions(),
      getAdjustmentSummary({ data: { dateFrom: null, dateTo: null } }),
      listAdminAdjustments({ data: RECENT_FILTER }),
    ]);
    return { page, options, summary, recent };
  },
  head: () => ({ meta: [{ title: "庫存盤點｜小時光書店後台" }] }),
  component: InventoryCountPage,
});

type StatProps = { label: string; value: string; hint?: string; icon: typeof Package };

function StatCard({ label, value, hint, icon: Icon }: StatProps) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border p-4">
      <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-medium tabular-nums">{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

function InventoryCountPage() {
  const { page: initialPage, options, summary, recent } = Route.useLoaderData();
  const router = useRouter();

  const [filter, setFilter] = useState<CountFilter>(DEFAULT_FILTER);
  const [data, setData] = useState(initialPage);
  const [loading, setLoading] = useState(false);
  const [counting, setCounting] = useState<StockCountProductRow | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);

  // 只拿來寫提示文字。真正的 status 是資料庫算的。
  const countApprovalOn = isApprovalRequired(options.approvalSettings, "stock_adjustments");
  const adj = summary.ADJ ?? { count: 0, quantity: 0, cost: 0 };
  const adjCost = `NT$ ${Math.round(adj.cost).toLocaleString("zh-TW")}`;

  const reload = useCallback(async (next: CountFilter) => {
    setLoading(true);
    try {
      const { listStockCountProducts } = await import("@/lib/admin/fns/inv-adjustments");
      setData(await listStockCountProducts({ data: next }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "商品清單讀取失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  function changeFilter(patch: Partial<CountFilter>) {
    // 任何條件變動都回到第一頁 —— 停在第 5 頁再換一個只有 3 頁結果的條件，看到的會是
    // 「沒有資料」而不是「你在第 5 頁」。
    const next = { ...filter, ...patch, page: 0 };
    setFilter(next);
    void reload(next);
  }

  /** 盤完之後重抓這一頁，順便讓 loader 重跑（統計卡與最近紀錄在那裡）。 */
  const refresh = useCallback(async () => {
    await reload(filter);
    await router.invalidate();
  }, [filter, reload, router]);

  const totalPages = Math.max(1, Math.ceil(data.total / filter.pageSize));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-lg font-medium">
            <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
            庫存盤點
          </h1>
          {countApprovalOn ? (
            <Badge variant="outline" className="font-normal">
              盤點需審核
            </Badge>
          ) : null}
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => setBatchOpen(true)}>
          <ClipboardList className="h-4 w-4" />
          批次盤點
        </Button>
      </div>

      <p className="max-w-3xl text-sm text-muted-foreground">
        盤帳面庫存，差異會透過「在庫異動」記錄。填的是<strong>實際數到的數量</strong>，差異由
        系統用送出當下的庫存算 —— 對話框開著的期間櫃檯照樣可以賣，算差異的時機因此不能在瀏覽器。
      </p>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="商品總數" value={data.total.toLocaleString("zh-TW")} icon={Package} />
        <StatCard label="盤點紀錄" value={`${adj.count} 筆`} hint="已確認的才算" icon={History} />
        <StatCard label="調整件數" value={`${adj.quantity} 件`} hint="盤虧＋盤盈" icon={ClipboardCheck} />
        <StatCard label="調整成本" value={adjCost} icon={ClipboardList} />
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-4">
        <div className="min-w-56 flex-1 space-y-1.5">
          <Label htmlFor="count-search" className="text-xs">
            搜尋
          </Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="count-search"
              className="pl-8"
              placeholder="商品名稱、期數、系列、條碼"
              value={filter.keyword ?? ""}
              disabled={loading}
              onChange={(e) => changeFilter({ keyword: e.target.value.trim() === "" ? null : e.target.value })}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">分類</Label>
          <Select
            value={filter.categoryId ?? ALL}
            disabled={loading}
            onValueChange={(v) => changeFilter({ categoryId: v === ALL ? null : v })}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部分類</SelectItem>
              {options.categories.map((c) => (
                <SelectItem key={c.category_id} value={c.category_id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">類型</Label>
          <Select
            value={filter.productType ?? ALL}
            disabled={loading}
            onValueChange={(v) =>
              changeFilter({ productType: v === ALL ? null : (v as CountFilter["productType"]) })
            }
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部類型</SelectItem>
              {INV_PRODUCT_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {INV_PRODUCT_TYPE_LABELS[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <label className="flex h-9 items-center gap-2 text-sm">
          <Checkbox
            checked={filter.lowStockOnly}
            disabled={loading}
            onCheckedChange={(v) => changeFilter({ lowStockOnly: v === true })}
          />
          只看低庫存
        </label>
      </div>

      {loading ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-border">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : data.rows.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          沒有找到符合的商品
        </div>
      ) : (
        <StockCountTable rows={data.rows} busy={loading} onCount={setCounting} />
      )}

      <ProductPagination
        page={filter.page}
        totalPages={totalPages}
        disabled={loading}
        onPageChange={(page) => {
          const next = { ...filter, page };
          setFilter(next);
          void reload(next);
        }}
      />

      <RecentStockCounts rows={recent.rows} />

      <StockCountDialog
        open={counting !== null}
        onOpenChange={(o) => !o && setCounting(null)}
        product={counting}
        approvalOn={countApprovalOn}
        onDone={refresh}
      />

      <BatchStockCountDialog
        open={batchOpen}
        onOpenChange={setBatchOpen}
        approvalOn={countApprovalOn}
        onDone={refresh}
      />
    </div>
  );
}

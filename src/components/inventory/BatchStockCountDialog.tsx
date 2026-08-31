/**
 * 批次盤點 —— 一次盤一整排架子。
 *
 * ⚠️ 與單筆那一支同一條規矩：送出去的是**實盤數量**，差異由資料庫算。畫面上的
 *    「預估差異」只是給人看的參考值。
 * ⚠️ 商品清單走 server 端搜尋，不是把 993 筆整份載進瀏覽器再 Array.filter。
 * ⚠️ 只送**有填數字**的那幾列。勾了但沒填代表「還沒數到」，不是「數到 0」——
 *    把它當成 0 送出去會把整架的庫存清光。
 */
import { useEffect, useState } from "react";
import { ClipboardList, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  BatchStockCountTable,
  type BatchCountPicked,
} from "@/components/inventory/BatchStockCountTable";
import { ReasonSelect } from "@/components/inventory/StockCountDialog";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import { stockCountSchema, type InvAdjustmentReason } from "@/lib/admin/schemas";
import type { StockCountProductRow } from "@/server/repos/inv-adjustments";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  approvalOn: boolean;
  onDone: () => Promise<void>;
};

export function BatchStockCountDialog({ open, onOpenChange, approvalOn, onDone }: Props) {
  const [keyword, setKeyword] = useState("");
  const [rows, setRows] = useState<StockCountProductRow[]>([]);
  const [loading, setLoading] = useState(false);
  /**
   * key 存在 = 已勾選。連 row 一起存**不是**多此一舉：清單會隨著搜尋字串換掉，
   * 只存 id 的話「勾了 A、再搜尋 B」會讓 A 靜默地不被送出。
   */
  const [picked, setPicked] = useState<BatchCountPicked>({});
  const [reason, setReason] = useState<InvAdjustmentReason>("count_error");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPicked({});
    setKeyword("");
    setReason("count_error");
    setNotes("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 打字停 300ms 才問一次資料庫。每一個按鍵都送一次請求，100 件商品的清單會被
    // 打成 100 次查詢，而且回來的順序不保證。
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const { listStockCountProducts } = await import("@/lib/admin/fns/inv-adjustments");
        const page = await listStockCountProducts({
          data: {
            keyword: keyword.trim() === "" ? null : keyword.trim(),
            categoryId: null,
            productType: null,
            lowStockOnly: false,
            page: 0,
            pageSize: 100,
          },
        });
        if (!cancelled) setRows(page.rows);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "商品清單讀取失敗");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, keyword]);

  function toggle(row: StockCountProductRow) {
    const id = row.inv_product_id;
    setPicked((cur) => {
      if (!(id in cur)) return { ...cur, [id]: { row, value: "" } };
      const { [id]: _drop, ...rest } = cur;
      return rest;
    });
  }

  function setValue(id: string, value: string) {
    setPicked((cur) => (id in cur ? { ...cur, [id]: { ...cur[id], value } } : cur));
  }

  const filled = Object.values(picked)
    .filter((e) => e.value.trim() !== "")
    .map((e) => ({ row: e.row, actual: Number(e.value) }))
    .filter((e) => Number.isInteger(e.actual) && e.actual >= 0);

  const shrinkage = filled.filter((e) => e.actual < e.row.stock_quantity);
  const surplus = filled.filter((e) => e.actual > e.row.stock_quantity);
  const sum = (list: typeof filled) =>
    list.reduce((acc, e) => acc + Math.abs(e.actual - e.row.stock_quantity), 0);

  async function submit() {
    const parsed = stockCountSchema.safeParse({
      rows: filled.map((e) => ({ product_id: e.row.inv_product_id, actual_quantity: e.actual })),
      options: {
        reason,
        notes: notes.trim() === "" ? null : notes,
        adjustment_date: todayInTaipei(),
      },
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查輸入的盤點數量");
      return;
    }

    setSaving(true);
    try {
      const { recordStockCount } = await import("@/lib/admin/fns/inv-adjustments");
      const result = await recordStockCount({ data: parsed.data });
      const tail = result.skipped > 0 ? `，${result.skipped} 件沒有差異已跳過` : "";
      if (result.created === 0) {
        toast.info(`這 ${result.skipped} 件的帳面數與實盤數都相同，沒有產生任何調整單`);
      } else if (result.needs_approval) {
        toast.success(`已建立 ${result.created} 筆盤點，已送出待審核，核准後庫存才會更新${tail}`);
      } else {
        toast.success(
          `盤點完成：盤虧 ${result.shrinkage} 件、盤盈 ${result.surplus} 件，庫存已更新${tail}`,
        );
      }
      onOpenChange(false);
      await onDone();
    } catch (err) {
      // 這支 RPC 是整批一起成功或整批失敗，所以失敗訊息不用列出哪一筆壞掉。
      toast.error(err instanceof Error ? err.message : "盤點失敗，整批都沒有寫進去");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4" aria-hidden="true" />
            批次庫存盤點
          </DialogTitle>
          <DialogDescription>
            勾選商品、填實際數到的數量，一次送出。只有<strong>有填數字</strong>的會被送出；
            {approvalOn ? "盤點調整目前需要審核。" : "盤點調整目前不需要審核，送出後立即生效。"}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="搜尋商品名稱、期數、系列、條碼"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>

        <BatchStockCountTable
          rows={rows}
          loading={loading}
          picked={picked}
          onToggle={toggle}
          onValueChange={setValue}
        />

        <div className="flex flex-wrap gap-4 rounded-md bg-muted/30 p-3 text-sm text-muted-foreground">
          <span>
            已勾選 <strong className="text-foreground">{Object.keys(picked).length}</strong>{" "}
            件・待送出 <strong className="text-foreground">{filled.length}</strong> 件
          </span>
          {shrinkage.length > 0 ? (
            <span className="text-destructive">
              盤虧 {shrinkage.length} 項，共 {sum(shrinkage)} 件
            </span>
          ) : null}
          {surplus.length > 0 ? (
            <span className="text-emerald-700">
              盤盈 {surplus.length} 項，共 {sum(surplus)} 件
            </span>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <ReasonSelect label="統一調整原因" value={reason} onChange={setReason} />
          <div className="space-y-1.5">
            <Label htmlFor="bsc-notes">備註（整批共用）</Label>
            <Textarea
              id="bsc-notes"
              rows={2}
              placeholder="補充說明（選填）"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={submit} disabled={saving || filled.length === 0}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            送出盤點（{filled.length} 件）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

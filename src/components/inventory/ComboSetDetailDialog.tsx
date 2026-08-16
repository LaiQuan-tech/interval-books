/**
 * 套餐詳情（唯讀）：組成品項與庫存、分攤預覽、最近的套餐銷售。
 *
 * ⚠️ 開啟時**重抓一次**套餐與組成品項（getAdminComboSet），不吃清單頁那份快取 ——
 *    詳情是拿來做決定的地方，看到別人五分鐘前改掉的內容比少一次請求重要。
 *
 * ⚠️ 分攤預覽是預覽。實際入帳金額由資料庫在結帳當下算，見
 *    lib/admin/combo-allocation.ts 的檔頭。
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ApprovalStatusBadge } from "@/components/inventory/ApprovalStatusBadge";
import { ComboSetAllocationPreview } from "@/components/inventory/ComboSetAllocationPreview";
import { ComboSetBasisHint } from "@/components/inventory/ComboSetBasisBadge";
import { ComboSetSalesList } from "@/components/inventory/ComboSetSalesList";
import { money, productLabel } from "@/lib/admin/inv-combo-labels";
import type {
  AdminComboItemRow,
  AdminComboSaleRow,
  AdminComboSetRow,
} from "@/server/repos/inv-combos";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: AdminComboSetRow | null;
};

function when(iso: string | null) {
  return iso ? new Date(iso).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }) : "—";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export function ComboSetDetailDialog({ open, onOpenChange, row }: Props) {
  const [set, setSet] = useState<AdminComboSetRow | null>(null);
  const [items, setItems] = useState<AdminComboItemRow[]>([]);
  const [sales, setSales] = useState<AdminComboSaleRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !row) return;
    let cancelled = false;
    setLoading(true);
    setSet(row);
    setItems([]);
    setSales([]);
    void (async () => {
      try {
        const { getAdminComboSet, listComboSales } = await import("@/lib/admin/fns/inv-combos");
        const [detail, saleRows] = await Promise.all([
          getAdminComboSet({ data: { id: row.combo_set_id } }),
          // 不限日期：套餐一年賣不到幾百份，最近 50 筆就是完整的故事。
          listComboSales({
            data: { comboSetId: row.combo_set_id, dateFrom: null, dateTo: null, limit: 50 },
          }),
        ]);
        if (cancelled) return;
        if (detail.set) setSet(detail.set);
        setItems(detail.items);
        setSales(saleRows);
      } catch (err) {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "套餐詳情讀取失敗");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, row]);

  if (!row) return null;
  const current = set ?? row;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{current.name}</DialogTitle>
          <DialogDescription>
            組合價 {money(current.selling_price)}・共 {current.item_count} 件組成品項
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={current.is_active ? "default" : "outline"} className="font-normal">
            {current.is_active ? "已上架" : "已下架"}
          </Badge>
          <ApprovalStatusBadge status={current.approval_status} />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="還能組幾份">
            {current.max_sets === null ? "—（沒有組成品項）" : `${current.max_sets} 份`}
          </Field>
          <Field label="已售組數">{current.sold_sets} 組</Field>
          <Field label="累計營收">{money(current.sold_revenue)}</Field>
          <Field label="建立者">{current.creator_name ?? "—"}</Field>
          <Field label="審核者">{current.approved_by_name ?? "—"}</Field>
          <Field label="審核時間">{when(current.approved_at)}</Field>
        </div>

        {current.notes ? (
          <Field label="備註">
            <p className="whitespace-pre-wrap">{current.notes}</p>
          </Field>
        ) : null}

        <ComboSetBasisHint
          basis={current.allocation_basis}
          zeroPricedItems={current.zero_priced_items}
        />

        <Separator />

        <div className="space-y-2">
          <p className="text-sm font-medium">組成品項與庫存</p>
          {loading && items.length === 0 ? (
            <div className="flex h-24 items-center justify-center rounded-md border border-border">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
              這個套餐沒有組成品項，資料庫會擋下販售（COMBO_NO_ITEMS）。
            </p>
          ) : (
            <ul className="space-y-1.5">
              {items.map((item) => (
                <li
                  key={item.item_id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2 text-sm"
                >
                  <span>
                    {productLabel(item.product_name, item.issue_number)}
                    <span className="text-muted-foreground"> × {item.quantity}</span>
                    {item.product_active ? null : (
                      <Badge variant="destructive" className="ml-1.5 font-normal">
                        已停用
                      </Badge>
                    )}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    定價 {item.selling_price > 0 ? money(item.selling_price) : "未填"}・庫存{" "}
                    {item.stock_quantity}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <ComboSetAllocationPreview
          sellingPrice={current.selling_price}
          items={items.map((item) => ({
            product_id: item.product_id,
            quantity: item.quantity,
            selling_price: item.selling_price,
            name: item.product_name,
            issue_number: item.issue_number,
          }))}
        />

        <Separator />

        <div className="space-y-2">
          <p className="text-sm font-medium">套餐銷售（最近 50 筆）</p>
          <ComboSetSalesList rows={sales} loading={loading} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

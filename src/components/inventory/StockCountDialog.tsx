/**
 * 單筆盤點。
 *
 * ── 送出去的是「實盤數量」，不是差異 ──────────────────────────────────────
 * payload 只有 `{ product_id, actual_quantity }`。差異由 inv_record_stock_count()
 * 用**當下**的 stock_quantity 算。畫面上那個「預估差異」純粹是給人看的參考值 ——
 * 店員開著這個對話框，櫃檯中間賣掉三本，正確的差異就不是畫面上那個數字了。
 * 來源系統在瀏覽器算完差異才送出，所以那三本會被重複扣掉。
 *
 * ── status 不在這裡決定 ──────────────────────────────────────────────────
 * `approvalOn` 只拿來寫下面那句提示文字。payload 裡根本沒有 status 這個欄位 ——
 * 要不要進待審是 inv.stock_adjustment_initial_status() 在資料庫算的。來源的這支
 * 對話框把 status 硬寫成 'confirmed'，等於審核開關對盤點完全無效。
 */
import { useEffect, useState } from "react";
import { ClipboardCheck, Loader2 } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ADJUSTMENT_REASON_OPTIONS } from "@/lib/admin/inv-adjustment-labels";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import { stockCountSchema, type InvAdjustmentReason } from "@/lib/admin/schemas";
import type { StockCountProductRow } from "@/server/repos/inv-adjustments";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: StockCountProductRow | null;
  approvalOn: boolean;
  onDone: () => Promise<void>;
};

/**
 * 六個調整原因的下拉。單筆與批次盤點共用同一份選項 —— 來源把這六個字串抄在四個
 * 檔案裡，使用者看到的是最後被 render 的那一份。
 */
export function ReasonSelect({
  label = "調整原因",
  value,
  onChange,
}: {
  label?: string;
  value: InvAdjustmentReason;
  onChange: (v: InvAdjustmentReason) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as InvAdjustmentReason)}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ADJUSTMENT_REASON_OPTIONS.map((o) => (
            <SelectItem key={o.code} value={o.code}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** 差異的顯示規則：盤虧紅、盤盈綠、沒有差異就直說沒有差異。 */
export function DiffText({ diff }: { diff: number }) {
  if (diff === 0) return <span className="text-muted-foreground">無差異</span>;
  return (
    <span className={diff < 0 ? "font-medium text-destructive" : "font-medium text-emerald-700"}>
      {diff > 0 ? "+" : ""}
      {diff}（{diff < 0 ? "盤虧" : "盤盈"}）
    </span>
  );
}

export function StockCountDialog({ open, onOpenChange, product, approvalOn, onDone }: Props) {
  const [actual, setActual] = useState("");
  const [reason, setReason] = useState<InvAdjustmentReason>("count_error");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    // 不預填帳面數 —— 預填等於幫店員按了「沒有差異」。盤點要的是他親眼數到的數字。
    setActual("");
    setReason("count_error");
    setNotes("");
  }, [open, product]);

  if (!product) return null;

  const parsedActual = actual.trim() === "" ? null : Number(actual);
  const diff =
    parsedActual === null || Number.isNaN(parsedActual) ? null : parsedActual - product.stock_quantity;
  const consignmentShrinkage = product.product_type === "consignment" && diff !== null && diff < 0;

  async function submit() {
    if (!product) return;
    const payload = {
      rows: [{ product_id: product.inv_product_id, actual_quantity: Number(actual) }],
      options: { reason, notes: notes.trim() === "" ? null : notes, adjustment_date: todayInTaipei() },
    };
    const parsed = stockCountSchema.safeParse(payload);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查輸入的盤點數量");
      return;
    }

    setSaving(true);
    try {
      const { recordStockCount } = await import("@/lib/admin/fns/inv-adjustments");
      const result = await recordStockCount({ data: parsed.data });
      if (result.created === 0) {
        toast.info("帳面數與實盤數相同，沒有產生調整單");
      } else if (result.needs_approval) {
        toast.success("盤點已送出待審核，核准後庫存才會更新");
      } else {
        toast.success(
          `盤點完成：${result.shrinkage > 0 ? `盤虧 ${result.shrinkage} 件` : `盤盈 ${result.surplus} 件`}，庫存已更新`,
        );
      }
      onOpenChange(false);
      await onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "盤點失敗");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ClipboardCheck className="h-4 w-4" aria-hidden="true" />
            盤點「{product.name}」
          </DialogTitle>
          <DialogDescription>
            填<strong>實際數到的數量</strong>，差異由系統用當下的庫存算。
            {approvalOn
              ? "盤點調整目前需要審核：送出之後會進入待審核，核准後庫存才會更新。"
              : "盤點調整目前不需要審核，送出後庫存立即更新。"}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sc-actual">實際盤點數量</Label>
            <Input
              id="sc-actual"
              type="number"
              min={0}
              step={1}
              placeholder="數到幾件就填幾件"
              value={actual}
              onChange={(e) => setActual(e.target.value)}
            />
          </div>
          <ReasonSelect value={reason} onChange={setReason} />
        </div>

        <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">帳面數量</p>
            <p className="text-sm tabular-nums">{product.stock_quantity} 件</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">實盤數量</p>
            <p className="text-sm tabular-nums">{parsedActual === null ? "—" : `${parsedActual} 件`}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">預估差異</p>
            <p className="text-sm tabular-nums">{diff === null ? "—" : <DiffText diff={diff} />}</p>
          </div>
        </div>

        {consignmentShrinkage ? (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            此為<strong>寄賣商品</strong>，盤虧差異仍需支付廠商貨款。系統不會自動通知供應商，
            也不會產生應付款 —— 請另外跟供應商對帳。
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="sc-notes">備註</Label>
          <Textarea
            id="sc-notes"
            rows={3}
            placeholder="例如：架上找不到，倉庫也翻過了"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={submit} disabled={saving || actual.trim() === ""}>
            {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            送出盤點
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 在庫異動單詳情（唯讀）＋ 依狀態出現的動作。
 *
 * ⚠️ 沖帳關係印的是**單號**不是 UUID。來源的詳情頁直接印 `reversal_of`，店員看到的是
 *    一串 36 個字的亂碼。0017 的 view 已經把它 join 成 reversal_of_number 了。
 *
 * ⚠️ 沒有 approve_stock_adjustments 的人看不到審核按鈕，但那**只是畫面**。真正擋住
 *    直接 POST /_serverFn/… 的是 fns/inv-adjustments.ts 裡 approveRecord 那一次權限
 *    檢查（而且它重讀 staff_permissions，不信任前端送來的任何東西）。
 *
 * ⚠️ 三個破壞性動作（刪除草稿、退回、沖帳）不在這裡直接執行 —— 它們往上丟給
 *    AdjustmentDialogs 的 AlertDialog 再問一次。
 */
import { CheckCircle2, Loader2, RefreshCw, RotateCcw, Send, Trash2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  categoryLabel,
  categoryVariant,
  reasonLabel,
  statusLabel,
  statusVariant,
} from "@/lib/admin/inv-adjustment-labels";
import type { AdminAdjustmentRow } from "@/server/repos/inv-adjustments";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: AdminAdjustmentRow | null;
  canApprove: boolean;
  busy: boolean;
  onSubmit: (row: AdminAdjustmentRow) => void;
  onApprove: (row: AdminAdjustmentRow) => void;
  onResubmit: (row: AdminAdjustmentRow) => void;
  /** 破壞性動作：交給上層開 AlertDialog 再問一次。 */
  onAskDelete: (row: AdminAdjustmentRow) => void;
  onAskReject: (row: AdminAdjustmentRow) => void;
  onAskReverse: (row: AdminAdjustmentRow) => void;
};

function money(n: number | null) {
  return n === null || n === undefined ? "—" : `NT$ ${Number(n).toLocaleString("zh-TW")}`;
}

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

export function AdjustmentDetailDialog({
  open,
  onOpenChange,
  row,
  canApprove,
  busy,
  onSubmit,
  onApprove,
  onResubmit,
  onAskDelete,
  onAskReject,
  onAskReverse,
}: Props) {
  if (!row) return null;

  const reversible = row.status === "confirmed" && !row.reversal_of && !row.reversed_by_id;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{row.adjustment_number ?? "（無單號）"}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5">
            <Badge variant={categoryVariant(row.category)} className="font-normal">
              {categoryLabel(row.category)}
            </Badge>
            <Badge variant={statusVariant(row.status)} className="font-normal">
              {statusLabel(row.status)}
            </Badge>
            {row.reversal_of ? (
              <Badge variant="outline" className="font-normal">
                沖帳單
              </Badge>
            ) : null}
            {row.reversed_by_id ? (
              <Badge variant="outline" className="font-normal">
                已被沖帳
              </Badge>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="異動日期">{row.adjustment_date}</Field>
          <Field label="商品">
            {row.product_name ?? "未知商品"}
            {row.issue_number ? ` #${row.issue_number}` : ""}
          </Field>
          <Field label="系列 / 分類">
            {[row.series, row.category_name].filter(Boolean).join(" ・ ") || "—"}
          </Field>
          <Field label="異動數量">
            <span
              className={row.quantity < 0 ? "font-medium text-destructive" : "font-medium text-emerald-700"}
            >
              {row.quantity > 0 ? "+" : ""}
              {row.quantity}
            </span>
          </Field>
          <Field label="異動前庫存">
            {row.stock_before === null ? "—" : `${row.stock_before} 件`}
          </Field>
          <Field label="目前庫存">
            {row.product_stock_quantity === null ? "—" : `${row.product_stock_quantity} 件`}
          </Field>
          <Field label="單位成本">{money(row.unit_cost)}</Field>
          <Field label="異動總成本">{money(row.total_cost)}</Field>
          <Field label="原因">{reasonLabel(row.reason)}</Field>
        </div>

        {row.notes ? (
          <>
            <Separator />
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">備註</p>
              <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-sm">{row.notes}</p>
            </div>
          </>
        ) : null}

        <Separator />

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="建立者">
            {row.creator_name ?? "—"}・{when(row.created_at)}
          </Field>
          <Field label="審核">
            {row.approved_at ? `${row.approved_by_name ?? "—"}・${when(row.approved_at)}` : "尚未審核"}
          </Field>
          <Field label="沖帳原單">
            {row.reversal_of_number ? (
              <span className="font-mono">{row.reversal_of_number}</span>
            ) : (
              "—"
            )}
          </Field>
          <Field label="已被哪一張沖掉">
            {row.reversed_by_number ? (
              <span className="font-mono">{row.reversed_by_number}</span>
            ) : (
              "—"
            )}
          </Field>
        </div>

        {row.status === "pending_approval" && !canApprove ? (
          <p className="text-xs text-muted-foreground">
            這張單在等審核，但你沒有審核權限（approve_stock_adjustments）。請找管理員授權，
            或請有權限的同事處理。
          </p>
        ) : null}

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            關閉
          </Button>

          {row.status === "draft" ? (
            <>
              <Button
                variant="outline"
                className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
                disabled={busy}
                onClick={() => onAskDelete(row)}
              >
                <Trash2 className="h-4 w-4" />
                刪除草稿
              </Button>
              <Button className="gap-1.5" disabled={busy} onClick={() => onSubmit(row)}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                送出
              </Button>
            </>
          ) : null}

          {row.status === "pending_approval" && canApprove ? (
            <>
              <Button
                variant="outline"
                className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
                disabled={busy}
                onClick={() => onAskReject(row)}
              >
                <XCircle className="h-4 w-4" />
                退回
              </Button>
              <Button
                variant="outline"
                className="gap-1.5 border-emerald-600/40 text-emerald-700 hover:bg-emerald-600/10"
                disabled={busy}
                onClick={() => onApprove(row)}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                審核通過
              </Button>
            </>
          ) : null}

          {row.status === "rejected" ? (
            <Button variant="outline" className="gap-1.5" disabled={busy} onClick={() => onResubmit(row)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              重新送審
            </Button>
          ) : null}

          {reversible ? (
            <Button variant="outline" className="gap-1.5" disabled={busy} onClick={() => onAskReverse(row)}>
              <RotateCcw className="h-4 w-4" />
              沖帳
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

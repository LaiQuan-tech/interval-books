/**
 * 審核／退回／重新送審的三顆按鈕。
 *
 * ⚠️ `canApprove` 只控制**畫面**。按鈕藏起來不是授權 —— 擋住直接 POST
 *    /_serverFn/… 的是 lib/admin/fns/inv-products.ts 那一層的 middleware 加上
 *    module → permission 的對照，兩者都在 server 端。這裡把按鈕變成 disabled
 *    而不是整個拿掉，是為了讓沒有權限的人看得到「有這個動作，但我不能做」，
 *    而不是以為系統壞了。
 *
 * 退回會問一次。通過不問 —— 通過是這一頁最常做的事（一天可能幾十次），每次都
 * 跳一個對話框只會訓練出「看到就按確定」。退回是例外事件，值得停一下。
 */
import { useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

type Props = {
  status: string;
  canApprove: boolean;
  busy: boolean;
  productName: string;
  onApprove: () => void;
  onReject: () => void;
  onResubmit: () => void;
  /** 沒有權限時滑鼠移上去要說得出來缺哪一個。 */
  permissionName?: string;
};

export function ApprovalActions({
  status,
  canApprove,
  busy,
  productName,
  onApprove,
  onReject,
  onResubmit,
  permissionName = "approve_products",
}: Props) {
  const [confirmReject, setConfirmReject] = useState(false);
  const blockedTitle = canApprove ? undefined : `需要「${permissionName}」權限`;

  if (status === "rejected") {
    return (
      <Button size="sm" variant="outline" className="gap-1.5" disabled={busy} onClick={onResubmit}>
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        重新送審
      </Button>
    );
  }

  if (status !== "pending") return null;

  return (
    <>
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 border-emerald-600/40 text-emerald-700 hover:bg-emerald-600/10"
          disabled={busy || !canApprove}
          title={blockedTitle}
          onClick={onApprove}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          通過
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
          disabled={busy || !canApprove}
          title={blockedTitle}
          onClick={() => setConfirmReject(true)}
        >
          <XCircle className="h-3.5 w-3.5" />
          退回
        </Button>
      </div>

      <AlertDialog open={confirmReject} onOpenChange={setConfirmReject}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">退回「{productName}」？</AlertDialogTitle>
            <AlertDialogDescription>
              退回之後這件商品不會出現在櫃檯，也不能上架。建立的人可以改完再送一次審。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReject(false);
                onReject();
              }}
            >
              確認退回
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

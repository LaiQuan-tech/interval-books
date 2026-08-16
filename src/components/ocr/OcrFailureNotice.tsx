/**
 * 辨識失敗時的畫面。兩個對話框共用。
 *
 * ── 一條驗收線：失敗之後一定還能繼續把事情做完 ────────────────────────────
 * 這個元件**永遠**會渲染一顆「改用手動輸入」。不管是額度用完、逾時、圖看不懂、
 * 服務掛掉，還是網路直接斷線（那是 throw 出來的，被 toOcrFailure() 收成 service），
 * 店員都要能在同一個畫面上一鍵切到平常的新增表單。
 *
 * 沒有任何一條路會停在「只有一個轉圈圈」或「只有一顆關閉」——「辨識壞了」不該
 * 等於「今天這批貨不能入帳」。來源那兩支 edge function 失敗時就只有一句 toast，
 * 對話框留在原地，店員只能自己關掉再重找入口。
 */
import { AlertTriangle, PencilLine, RefreshCw, Camera } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ocrFailureAdvice, type OcrFailure } from "@/lib/admin/ocr-scan";

type Props = {
  failure: OcrFailure;
  /** 用同一張已上傳的圖再辨識一次。逾時／服務異常時才給。 */
  onRetry: () => void;
  /** 回到第一步重拍或重選檔案。 */
  onRecapture: () => void;
  /** 關掉這個對話框，打開平常的新增表單。**一定要有**。 */
  onManual: () => void;
};

export function OcrFailureNotice({ failure, onRetry, onRecapture, onManual }: Props) {
  const advice = ocrFailureAdvice(failure.kind);

  return (
    <div className="space-y-4">
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        <AlertTitle className="text-sm">{advice.title}</AlertTitle>
        <AlertDescription className="space-y-1.5 text-sm">
          {/* 伺服器給的那一句照原文顯示 —— 它比任何前端猜測都準。 */}
          <p>{failure.message}</p>
          <p className="text-xs">{advice.hint}</p>
        </AlertDescription>
      </Alert>

      <div className="rounded-md border border-border p-3">
        <p className="text-sm font-medium">辨識失敗不影響手動作業</p>
        <p className="mt-1 text-xs text-muted-foreground">
          拍照辨識只是幫忙把欄位先填好。按下面這顆會直接開啟平常的新增表單， 該記的帳照樣記得完。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" onClick={onManual}>
            <PencilLine className="mr-1.5 h-4 w-4" aria-hidden="true" />
            改用手動輸入
          </Button>

          {advice.action === "retry" ? (
            <Button type="button" variant="outline" onClick={onRetry}>
              <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
              用同一張圖再辨識一次
            </Button>
          ) : null}

          <Button type="button" variant="outline" onClick={onRecapture}>
            <Camera className="mr-1.5 h-4 w-4" aria-hidden="true" />
            重新拍照
          </Button>
        </div>

        {advice.action === "wait" ? (
          <p className="mt-2 text-xs text-muted-foreground">
            ⚠️ 這一種失敗現在重試沒有用（額度／頻率上限），請隔幾分鐘再拍。
          </p>
        ) : null}
      </div>
    </div>
  );
}

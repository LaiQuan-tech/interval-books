/**
 * WebcamCapture 的 SSR 安全外殼。
 *
 * ⚠️ 這個檔案存在的唯一理由：**讓 WebcamCapture 只在瀏覽器被載入**。它整支建立在
 *    navigator.mediaDevices 與 canvas 上，這個專案是 SSR 的（TanStack Start），
 *    靜態 import 會把它拉進伺服器端的 import 圖裡。做法逐字照抄
 *    pos/ScannerInput.tsx 對 html5-qrcode 的那一段：
 *      · await import() 寫在 effect 裡，不是模組頂層
 *      · 用 cancelled 旗標擋住「載完之前元件就被卸載」
 *      · 型別用本地結構型別，不從那個模組 import —— 型別雖然會被編譯器抹掉，
 *        但寫在這裡就不會有人哪天順手把 `import type` 改成 `import`。
 *
 * 順便在載入前先擋掉 http：window.isSecureContext 是 false 的話，getUserMedia
 * 一定失敗，那還不如在按下去之前就講清楚為什麼。
 */
import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

/** 本地結構型別 —— 不要 import WebcamCapture 的型別（見檔頭）。 */
type CaptureComponent = (props: {
  onCapture: (blob: Blob) => void;
  onCancel: () => void;
}) => React.ReactElement | null;

type Props = {
  onCapture: (blob: Blob) => void;
  onCancel: () => void;
};

export function WebcamPanel({ onCapture, onCancel }: Props) {
  const [Capture, setCapture] = useState<CaptureComponent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    (async () => {
      try {
        if (typeof window === "undefined") return;
        if (!window.isSecureContext) {
          setError(
            "瀏覽器只在 https（或 localhost）下才給相機權限。請改用 https 網址，或用「選擇照片」上傳。",
          );
          return;
        }
        // ← 這一行就是整個檔案的重點。靜態 import 會在 SSR 端載到相機那段程式。
        const mod = await import("@/components/ocr/WebcamCapture");
        if (cancelled) return;
        // setState 收到 function 會被當成 updater，所以要包一層。
        setCapture(() => mod.WebcamCapture as CaptureComponent);
      } catch (err) {
        if (cancelled) return;
        setError(
          `相機元件載入失敗：${err instanceof Error ? err.message : "未知錯誤"}。可以改用「選擇照片」上傳。`,
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (error) {
    return (
      <div className="space-y-3">
        <Alert variant="destructive">
          <AlertDescription className="text-sm">{error}</AlertDescription>
        </Alert>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAttempt((n) => n + 1)}
          >
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
            重試
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            取消
          </Button>
        </div>
      </div>
    );
  }

  if (!Capture) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border border-border">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="ml-2 text-sm text-muted-foreground">正在載入相機…</span>
      </div>
    );
  }

  return <Capture onCapture={onCapture} onCancel={onCancel} />;
}

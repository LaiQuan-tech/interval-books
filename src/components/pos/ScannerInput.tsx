import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CameraOff, Keyboard, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";

/**
 * 條碼輸入 —— 相機掃描 + 手動輸入。
 *
 * ⚠️ html5-qrcode 在 import 時就會碰 `window`，所以它**只能**在 effect 裡 dynamic
 *    import。這個專案是 SSR 的（TanStack Start），靜態 import 會在伺服器端直接炸。
 *
 * ⚠️ 手動輸入不是「相機壞掉時的備案」，是主要入口：993 個品項裡只有 27 個有條碼。
 *    所以預設就是手動輸入框有焦點，相機要按才開 —— 不要為了一個很酷的功能，讓
 *    97% 的情況多按一次。
 */
type Props = {
  /** 掃到或輸入了一個條碼。呼叫端負責比對商品。 */
  onBarcode: (barcode: string) => void;
  /** 找不到商品時由呼叫端傳回來，顯示在輸入框下面。 */
  notFound?: string | null;
  disabled?: boolean;
};

/** 同一個條碼在這段時間內重複掃到就忽略。 */
const DEDUPE_MS = 1500;

export function ScannerInput({ onBarcode, notFound, disabled }: Props) {
  const [manual, setManual] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // html5-qrcode 的 instance。型別用 unknown + 區域斷言，避免把它的型別拉進
  // 這個檔案的 import 圖裡（那會讓它在 SSR 端被載入）。
  const scannerRef = useRef<{ stop: () => Promise<void>; clear: () => void } | null>(null);
  const lastScanRef = useRef<{ text: string; at: number }>({ text: "", at: 0 });
  const onBarcodeRef = useRef(onBarcode);
  onBarcodeRef.current = onBarcode;

  const handleDetected = useCallback((decodedText: string) => {
    const text = decodedText.trim();
    if (!text) return;

    // 來源系統沒有這一段：它靠 pause() + 500ms 後 resume()，所以同一個條碼還在
    // 鏡頭裡時會被重複計數一次 —— 在櫃檯就是客人被多收一次錢。
    const now = Date.now();
    const last = lastScanRef.current;
    if (last.text === text && now - last.at < DEDUPE_MS) return;
    lastScanRef.current = { text, at: now };

    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(40);
    onBarcodeRef.current(text);
  }, []);

  useEffect(() => {
    if (!cameraOn) return;

    let cancelled = false;
    setStarting(true);
    setCameraError(null);

    (async () => {
      try {
        // ← 這一行就是整個檔案的重點。靜態 import 會在 SSR 端執行到 window。
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        if (cancelled) return;

        const instance = new Html5Qrcode("pos-scanner-region", {
          verbose: false,
          // 來源系統沒有限制格式，等於每一幀都試著解所有 QR 與一維碼。書店的條碼
          // 就是 EAN-13 / EAN-8 / CODE-128，限定之後辨識更快也更不會誤判。
          formatsToSupport: [
            Html5QrcodeSupportedFormats.EAN_13,
            Html5QrcodeSupportedFormats.EAN_8,
            Html5QrcodeSupportedFormats.CODE_128,
            Html5QrcodeSupportedFormats.CODE_39,
            Html5QrcodeSupportedFormats.UPC_A,
            Html5QrcodeSupportedFormats.QR_CODE,
          ],
        });

        await instance.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 260, height: 140 }, aspectRatio: 1.6 },
          handleDetected,
          undefined, // 每一幀解不出來都會呼叫，不是錯誤，不要理它
        );

        if (cancelled) {
          await instance.stop().catch(() => {});
          instance.clear();
          return;
        }
        scannerRef.current = instance;
      } catch (err) {
        if (cancelled) return;
        setCameraError(describeCameraError(err));
        setCameraOn(false);
      } finally {
        if (!cancelled) setStarting(false);
      }
    })();

    return () => {
      cancelled = true;
      const instance = scannerRef.current;
      scannerRef.current = null;
      if (instance) {
        instance
          .stop()
          .then(() => instance.clear())
          .catch(() => {});
      }
    };
  }, [cameraOn, handleDetected]);

  function submitManual(event: React.FormEvent) {
    event.preventDefault();
    const text = manual.trim();
    if (!text) return;
    onBarcode(text);
    setManual("");
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submitManual} className="flex gap-2">
        <div className="relative flex-1">
          <Keyboard
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            // autoFocus 是刻意的：櫃檯的雷射掃描槍就是一個鍵盤，它會把條碼打進
            // 目前有焦點的欄位再送一個 Enter。沒有焦點就等於掃了沒反應。
            autoFocus
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="掃描或輸入條碼，按 Enter"
            className="pl-8"
            disabled={disabled}
            aria-label="條碼"
            inputMode="text"
          />
        </div>
        <Button type="submit" variant="secondary" disabled={disabled || !manual.trim()}>
          查詢
        </Button>
        <Button
          type="button"
          variant={cameraOn ? "default" : "outline"}
          size="icon"
          onClick={() => setCameraOn((on) => !on)}
          disabled={disabled || starting}
          aria-pressed={cameraOn}
          aria-label={cameraOn ? "關閉相機" : "用相機掃描"}
          title={cameraOn ? "關閉相機" : "用相機掃描"}
        >
          {starting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : cameraOn ? (
            <CameraOff className="h-4 w-4" />
          ) : (
            <Camera className="h-4 w-4" />
          )}
        </Button>
      </form>

      {/* 相機關著時這個 div 必須留在 DOM 裡：html5-qrcode 用 getElementById 找它，
          在 effect 裡才建立會遇到 React 還沒把它掛上去。 */}
      <div
        id="pos-scanner-region"
        className={cameraOn ? "overflow-hidden rounded-md border border-border" : "hidden"}
      />

      {cameraError ? (
        <Alert variant="destructive">
          <AlertDescription className="text-sm">{cameraError}</AlertDescription>
        </Alert>
      ) : null}

      {notFound ? (
        <Alert>
          <AlertDescription className="text-sm">{notFound}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * 相機失敗的原因分開講。
 *
 * 來源系統對所有失敗都回同一句「請確認已授權相機權限」，於是在沒有鏡頭的桌機、
 * 在被別的分頁佔用相機時、在 http 網址下，店員都會去翻權限設定，然後翻不到。
 */
function describeCameraError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);

  if (name === "NotAllowedError" || /permission/i.test(message)) {
    return "相機權限被拒絕。請在網址列左邊的鎖頭圖示裡允許相機，然後再按一次。";
  }
  if (name === "NotFoundError" || /no camera|not found/i.test(message)) {
    return "這台裝置找不到相機。請直接用掃描槍或手動輸入條碼。";
  }
  if (name === "NotReadableError" || /in use|could not start/i.test(message)) {
    return "相機正被其他程式或分頁占用。關掉它們再試一次。";
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "瀏覽器只在 https（或 localhost）下才給相機權限。請改用 https 網址。";
  }
  return `相機啟動失敗：${message}`;
}

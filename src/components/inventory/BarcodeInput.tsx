/**
 * 條碼欄位 —— 手打或用相機掃。
 *
 * ⚠️ html5-qrcode 一定要 **dynamic import**。它在模組頂層就會碰 `window`，靜態
 *    import 會在 SSR 端直接炸掉整頁（0014 的 ScannerInput 為了同一個理由這樣寫，
 *    pos-counter-selftest 有一條測試在守它）。
 *
 * 容器 id 帶上 useId()。來源寫死 'barcode-scanner-container'，所以同一頁只要有
 * 兩個實例（新增對話框 + 編輯對話框同時掛著），第二個會 render 到第一個的容器裡。
 */
import { useEffect, useId, useRef, useState } from "react";
import { Camera, CameraOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Props = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
};

// html5-qrcode 沒有匯出好用的實例型別，而我們只用到四個方法。
type Scanner = {
  start: (
    camera: { facingMode: string },
    config: { fps: number; qrbox: { width: number; height: number }; aspectRatio: number },
    onSuccess: (text: string) => void,
    onError: () => void,
  ) => Promise<void>;
  stop: () => Promise<void>;
  clear: () => void;
  getState: () => number;
};

export function BarcodeInput({ value, onChange, disabled, id }: Props) {
  const containerId = `barcode-scanner-${useId().replace(/:/g, "")}`;
  const scannerRef = useRef<Scanner | null>(null);
  const [scanning, setScanning] = useState(false);
  const [starting, setStarting] = useState(false);

  // 元件被卸載（對話框關掉）時相機一定要停。不停的話手機上的鏡頭燈會一直亮著，
  // 而且下一次開啟會拿不到裝置。
  useEffect(() => {
    return () => {
      const scanner = scannerRef.current;
      if (!scanner) return;
      scanner
        .stop()
        .then(() => scanner.clear())
        .catch(() => undefined);
      scannerRef.current = null;
    };
  }, []);

  async function startScan() {
    setStarting(true);
    try {
      const { Html5Qrcode } = await import("html5-qrcode");
      const scanner = new Html5Qrcode(containerId) as unknown as Scanner;
      scannerRef.current = scanner;
      setScanning(true);
      await scanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 100 }, aspectRatio: 2.5 },
        (text) => {
          onChange(text.trim());
          toast.success(`已掃到條碼 ${text.trim()}`);
          void stopScan();
        },
        () => undefined, // 每一格沒掃到都會呼叫這個，不要吵使用者
      );
    } catch (err) {
      setScanning(false);
      scannerRef.current = null;
      toast.error(err instanceof Error ? err.message : "相機啟動失敗，請改用手動輸入");
    } finally {
      setStarting(false);
    }
  }

  async function stopScan() {
    const scanner = scannerRef.current;
    setScanning(false);
    if (!scanner) return;
    try {
      await scanner.stop();
      scanner.clear();
    } catch {
      // 已經停掉了。不是錯誤。
    }
    scannerRef.current = null;
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          disabled={disabled}
          placeholder="手動輸入或用相機掃描"
          maxLength={64}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={disabled || starting}
          title={scanning ? "停止掃描" : "用相機掃描"}
          onClick={() => (scanning ? void stopScan() : void startScan())}
        >
          {starting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : scanning ? (
            <CameraOff className="h-4 w-4" />
          ) : (
            <Camera className="h-4 w-4" />
          )}
          <span className="sr-only">{scanning ? "停止掃描" : "用相機掃描"}</span>
        </Button>
      </div>
      {/* 容器一直在 DOM 裡，只是沒掃描時高度為 0 —— html5-qrcode 需要它在 start()
          之前就存在，條件渲染會讓它找不到節點。 */}
      <div
        id={containerId}
        className={scanning ? "overflow-hidden rounded-md border border-border" : "hidden"}
      />
    </div>
  );
}

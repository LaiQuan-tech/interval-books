/**
 * 相機取景 → 拍一張 → 確認要用它。移植自來源的 ui/webcam-capture.tsx。
 *
 * ⚠️ **這個檔案只能被 dynamic import**（見 WebcamPanel.tsx）。它整支都建立在
 *    navigator.mediaDevices 與 canvas 上，SSR 端沒有這兩個東西 —— 與
 *    pos/ScannerInput.tsx 對 html5-qrcode 的規矩同一條。
 *
 * ── 與來源的四個差別 ──────────────────────────────────────────────────────
 * 1. **交出去的是 Blob，不是 data URL**。來源 `canvas.toDataURL()` 之後把那串
 *    base64 一路送進 edge function。這裡走 canvas.toBlob，後面接
 *    compressImage → uploadOcrScan，server fn 只看得到 storage key。
 * 2. **開相機只有一個 effect**。來源有兩個 useEffect 都會呼叫 startCamera（一個
 *    掛載時、一個 facingMode 變時），掛載當下兩個都跑 —— 相機被開兩次、第一條
 *    stream 沒人關。這裡用 [captured, facing, attempt] 一個 effect 管完，cleanup
 *    一定把 track 停掉。
 * 3. **錯誤分得出種類**。來源只認 NotAllowedError 與 NotFoundError，其餘一句
 *    「無法開啟相機」。被別的分頁占用（NotReadableError）與 http 網址（沒有
 *    isSecureContext）是完全不同的兩件事，講錯了店員會去翻找不到的設定。
 * 4. **物件網址會被 revoke**。預覽圖用 createObjectURL，換一張或關掉都要收回去。
 */
import { useEffect, useRef, useState } from "react";
import { Camera, Check, RefreshCw, SwitchCamera, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";

type Props = {
  /** 使用者按下「使用這張」。呼叫端負責壓縮與上傳。 */
  onCapture: (blob: Blob) => void;
  onCancel: () => void;
};

/** 拍出來的 JPEG 品質。後面還會被 compressImage 重壓一次，這裡不用壓到底。 */
const CAPTURE_QUALITY = 0.92;

export function WebcamCapture({ onCapture, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captured, setCaptured] = useState<{ blob: Blob; url: string } | null>(null);
  const [facing, setFacing] = useState<"user" | "environment">("environment");
  /** 按「重試」時 +1，讓 effect 重跑。 */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // 已經拍好了就不要再開相機 —— 這一段同時也是「拍完自動關鏡頭」的實作：
    // captured 一變，cleanup 先跑，track 就停了。
    if (captured) return;

    let cancelled = false;
    // effect 開始時就抓住 video 節點，cleanup 用這一份（見下面 cleanup 的註解）。
    const videoEl = videoRef.current;
    setError(null);
    setStreaming(false);

    (async () => {
      try {
        if (!window.isSecureContext) {
          throw new Error("INSECURE_CONTEXT");
        }
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error("UNSUPPORTED");
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: facing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;

        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          // play() 在部分瀏覽器會因為自動播放政策 reject；畫面照樣有影像，不要
          // 因為這個把整個相機判成失敗。
          await video.play().catch(() => {});
        }
        if (cancelled) return;
        setStreaming(true);
      } catch (err) {
        if (cancelled) return;
        setError(describeCameraError(err));
      }
    })();

    return () => {
      cancelled = true;
      const stream = streamRef.current;
      streamRef.current = null;
      // 先停軌道再清 srcObject。停軌道是真正關掉鏡頭的那一步（分頁上的紅點會滅）；
      // 只清 srcObject 的話鏡頭會一直亮著。
      if (stream) stream.getTracks().forEach((track) => track.stop());
      // ⚠️ 用 effect 一開始就抓住的那個 video 節點，不是 cleanup 執行當下的
      //    videoRef.current —— 後者到這一刻可能已經指向別的節點（或 null），
      //    於是舊節點的 srcObject 沒被清掉，會抓著已經停掉的 stream 不放。
      if (videoEl) videoEl.srcObject = null;
    };
  }, [captured, facing, attempt]);

  /** 預覽用的物件網址一定要收回去，否則整張照片會留在記憶體裡直到重新整理。 */
  useEffect(() => {
    const url = captured?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [captured]);

  function capture() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !streaming) return;

    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("這個瀏覽器不支援 canvas，無法拍照。請改用「選擇照片」上傳。");
      return;
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // ⚠️ 不用 toDataURL。要交出去的是 Blob —— base64 只會在送出前被再轉一次，
    //    而且來源就是被那串字撐爆 request body 的。
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setError("拍照失敗，請再試一次，或改用「選擇照片」上傳。");
          return;
        }
        setCaptured({ blob, url: URL.createObjectURL(blob) });
      },
      "image/jpeg",
      CAPTURE_QUALITY,
    );
  }

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

  if (captured) {
    return (
      <div className="space-y-3">
        <img
          src={captured.url}
          alt="剛拍的照片"
          className="max-h-[380px] w-full rounded-md border border-border object-contain"
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => onCapture(captured.blob)}>
            <Check className="mr-1.5 h-4 w-4" aria-hidden="true" />
            使用這張
          </Button>
          <Button type="button" variant="outline" onClick={() => setCaptured(null)}>
            <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden="true" />
            重拍
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            取消
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <canvas ref={canvasRef} className="hidden" />
      <div className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-black">
        <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
        {!streaming ? (
          <div className="absolute inset-0 flex items-center justify-center bg-muted">
            <p className="text-sm text-muted-foreground">正在開啟相機…</p>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={capture} disabled={!streaming}>
          <Camera className="mr-1.5 h-4 w-4" aria-hidden="true" />
          拍照
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
          title="切換前後鏡頭"
        >
          <SwitchCamera className="mr-1.5 h-4 w-4" aria-hidden="true" />
          切換鏡頭
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          <X className="mr-1.5 h-4 w-4" aria-hidden="true" />
          取消
        </Button>
      </div>
    </div>
  );
}

/**
 * 相機失敗的原因分開講。與 pos/ScannerInput.tsx 的 describeCameraError 同一套說法
 * —— 兩邊講一樣的話，店員只要學一次。
 */
function describeCameraError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);

  if (message === "INSECURE_CONTEXT") {
    return "瀏覽器只在 https（或 localhost）下才給相機權限。請改用 https 網址，或改用「選擇照片」上傳。";
  }
  if (message === "UNSUPPORTED") {
    return "這個瀏覽器不支援相機存取。請改用「選擇照片」上傳，手機上也可以直接選相機拍。";
  }
  if (name === "NotAllowedError" || /permission|denied/i.test(message)) {
    return "相機權限被拒絕。請在網址列左邊的鎖頭圖示裡允許相機，然後按「重試」。";
  }
  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    /no camera|not found/i.test(message)
  ) {
    return "這台裝置找不到相機。請改用「選擇照片」上傳已經拍好的檔案。";
  }
  if (
    name === "NotReadableError" ||
    name === "TrackStartError" ||
    /in use|could not start/i.test(message)
  ) {
    return "相機正被其他程式或分頁占用。關掉它們之後按「重試」。";
  }
  if (name === "OverconstrainedError") {
    return "這台裝置的相機不支援要求的解析度。按「切換鏡頭」換一顆，或改用「選擇照片」上傳。";
  }
  return `相機啟動失敗：${message || "未知錯誤"}。可以按「重試」，或改用「選擇照片」上傳。`;
}

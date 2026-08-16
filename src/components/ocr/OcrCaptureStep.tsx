/**
 * 拍照辨識的第一步：拿到一張圖。兩個入口，進貨單與書封共用。
 *
 *   · 選擇照片 —— `<input type="file" accept="image/*">`。手機上點下去就是相簿或
 *     相機二選一，桌機上就是選檔。這是**主要**入口。
 *   · 開啟相機 —— WebcamPanel（dynamic import，見那個檔案的檔頭）。桌機接 webcam
 *     或平板架在櫃檯時才用得到。
 *
 * ⚠️ 兩個入口交出來的都是 File / Blob，**不是 data URL**。壓縮與上傳在
 *    lib/admin/ocr-scan.ts，server fn 只會看到 storage key。
 */
import { useRef, useState } from "react";
import { Camera, ImageUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WebcamPanel } from "@/components/ocr/WebcamPanel";

type Props = {
  /** 上傳／辨識進行中。這段期間兩個入口都鎖住。 */
  busy: boolean;
  /** 轉圈圈時要說現在在做什麼（「上傳中…」「辨識中…」）。 */
  busyLabel: string;
  /** 這一個對話框要拍什麼的說明。 */
  hint: string;
  onImage: (source: File | Blob) => void;
};

export function OcrCaptureStep({ busy, busyLabel, hint, onImage }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [cameraOn, setCameraOn] = useState(false);

  function pickFile(files: FileList | null) {
    const file = files?.[0];
    // input 的值要清掉，否則同一個檔案選第二次不會觸發 change。
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    onImage(file);
  }

  if (busy) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-md border border-border">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">{busyLabel}</p>
        <p className="text-xs text-muted-foreground">辨識最多 30 秒，逾時會告訴你可以重試。</p>
      </div>
    );
  }

  if (cameraOn) {
    return (
      <WebcamPanel
        onCapture={(blob) => {
          setCameraOn(false);
          onImage(blob);
        }}
        onCancel={() => setCameraOn(false)}
      />
    );
  }

  return (
    <div className="space-y-3">
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => pickFile(e.target.files)}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="flex w-full flex-col items-center gap-2 rounded-md border border-dashed border-border p-10 transition-colors hover:border-primary"
      >
        <ImageUp className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium">點這裡選擇照片</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </button>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setCameraOn(true)}>
          <Camera className="mr-1.5 h-4 w-4" aria-hidden="true" />
          開啟相機拍照
        </Button>
        <p className="text-xs text-muted-foreground">
          相機需要 https；沒有相機或不想授權都可以直接選檔案。
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        照片會先在瀏覽器縮到長邊 1600px 再上傳（EXIF 與定位資訊會一起被洗掉）， 辨識結果是
        <strong>建議</strong>—— 下一步可以逐欄修改，確認之後才會寫進資料庫。
      </p>
    </div>
  );
}

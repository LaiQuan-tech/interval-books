/**
 * Admin gallery picker：一組有序的圖片 key（events.gallery_keys，0031），可以
 * 上傳新照片、從圖庫挑一張、刪除、以及用上移／下移調整順序。
 *
 * ── 為什麼不是把 ImageField 包裝成多選 ──────────────────────────────────────
 * ImageField 的整個內部狀態（localPreview、pickerOpen…）都是為了「一個 key」
 * 設計的，硬要塞進陣列語意只會把它的每一個 state 都變成 array-indexed，程式碼
 * 可讀性反而更差。這裡**沿用它證明過的那一半**——上傳管線（uploadImage() 這支
 * server fn、compressImage() 的前端壓縮、IMAGE_BY_KEY 的圖庫挑選）——不重寫一套
 * 新的上傳邏輯，只是圍著它組一個「陣列版」的殼。任何上傳／壓縮邏輯的改動只有
 * ImageField 與這裡兩個呼叫點，且都是呼叫同一支 uploadSiteImage()。
 *
 * ── 排序不是遠端 RPC ─────────────────────────────────────────────────────
 * 跟 EventBlockEditor 的上移／下移不一樣：那裡的 event_blocks 是獨立的一張表，
 * 兩列互換要在同一個交易裡完成（見該檔案的說明），所以每次移動都要打一次 RPC。
 * gallery_keys 只是活動表單裡的一個陣列欄位，順序調整只是本地 state 的
 * array-swap，跟拖動 image_key 的欄位順序沒有兩樣——真正落地是使用者按下整個
 * 表單的「儲存」按鈕那一刻，跟 highlights 等七個清單欄位是同一個節奏。
 */
import { useState } from "react";
import { toast } from "sonner";
import { Check, ChevronDown, ChevronUp, ImagePlus, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { imageFor, IMAGE_BY_KEY } from "@/lib/images";
import { uploadImage } from "@/lib/admin/fns/upload";
import {
  compressImage,
  extensionFor,
  IMAGE_MAX_EDGE_PX,
  IMAGE_WEBP_QUALITY,
} from "@/lib/admin/image-compress";

export type GalleryFieldProps = {
  /** 目前的相簿：一個有序的 image_key 陣列。 */
  value: string[];
  /** 每次新增／刪除／排序都會整組送回來（不是單一項的差異）。 */
  onChange: (keys: string[]) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
};

async function compressForUpload(file: File): Promise<Blob> {
  return compressImage(file, { maxEdge: IMAGE_MAX_EDGE_PX, quality: IMAGE_WEBP_QUALITY });
}

export function GalleryField({ value, onChange, label, disabled, className }: GalleryFieldProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const controlsDisabled = disabled || busy;

  async function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);

    if (!file.type.startsWith("image/")) {
      setError("請選擇圖片檔案");
      return;
    }

    setBusy(true);
    try {
      const compressed = await compressForUpload(file);
      const ext = extensionFor(compressed);
      const formData = new FormData();
      formData.append("file", compressed, `upload.${ext}`);

      const result = await uploadImage({ data: formData });
      // 新照片加在最後面——跟 highlights 等清單欄位「新增一項就接在後面」是同一個
      // 直覺，使用者不必去猜新的一張會插在哪裡。
      onChange([...value, result.key]);
      toast.success("圖片已上傳");
    } catch (err) {
      const message = err instanceof Error ? err.message : "上傳失敗，請再試一次";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  function pickBundled(key: string) {
    setError(null);
    onChange([...value, key]);
    setPickerOpen(false);
  }

  function removeAt(index: number) {
    const next = [...value];
    next.splice(index, 1);
    onChange(next);
  }

  function moveAt(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const moved = next[index];
    next[index] = next[target];
    next[target] = moved;
    onChange(next);
  }

  return (
    <div className={cn("space-y-3", className)}>
      {label ? <p className="text-sm font-medium">{label}</p> : null}

      {value.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          還沒有照片。上傳的第一張會出現在活動頁的「更多照片」區。
        </p>
      ) : (
        <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {value.map((key, index) => (
            // key 用 index：陣列本身沒有穩定 id，元素也可能重複（同一張圖用兩次），
            // 這一頁本來就跟著陣列順序整組重繪，跟七個清單欄位的 textarea 是同一個
            // 決定，不是這裡漏想過。
            <li key={`${key}-${index}`} className="space-y-1">
              <div className="relative aspect-square overflow-hidden rounded-md border border-border bg-muted">
                <img
                  src={imageFor(key, "")}
                  alt={`第 ${index + 1} 張`}
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="flex items-center justify-between gap-1">
                <div className="flex">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    aria-label="往前移"
                    disabled={index === 0 || controlsDisabled}
                    onClick={() => moveAt(index, -1)}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    aria-label="往後移"
                    disabled={index === value.length - 1 || controlsDisabled}
                    onClick={() => moveAt(index, 1)}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive"
                  aria-label="刪除這張照片"
                  disabled={controlsDisabled}
                  onClick={() => removeAt(index)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          id="gallery-field-upload"
          type="file"
          accept="image/*"
          className="hidden"
          disabled={controlsDisabled}
          onChange={(e) => {
            void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={controlsDisabled}
          onClick={() => document.getElementById("gallery-field-upload")?.click()}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          上傳新照片
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={controlsDisabled}
          onClick={() => setPickerOpen((v) => !v)}
        >
          <ImagePlus className="size-4" />
          從圖庫加入
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        會自動壓縮並轉為 WebP 格式（最長邊 {IMAGE_MAX_EDGE_PX}px）。僅接受 JPEG、PNG、WebP。
        活動頁沒有相簿就不會畫出這一區——不必刻意留空。
      </p>

      {error ? (
        <Alert variant="destructive" className="py-2">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      ) : null}

      {pickerOpen ? (
        <div className="grid grid-cols-3 gap-2 rounded-md border border-border p-3 sm:grid-cols-4 md:grid-cols-7">
          {Object.entries(IMAGE_BY_KEY).map(([key, src]) => (
            <button
              key={key}
              type="button"
              disabled={controlsDisabled}
              onClick={() => pickBundled(key)}
              title={key}
              className="group relative aspect-square overflow-hidden rounded-md border-2 border-transparent transition-colors hover:border-border"
            >
              <img src={src} alt={key} className="h-full w-full object-cover" />
              {value.includes(key) ? (
                <span className="absolute inset-0 flex items-center justify-center bg-primary/20">
                  <Check className="size-5 text-primary-foreground drop-shadow" />
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

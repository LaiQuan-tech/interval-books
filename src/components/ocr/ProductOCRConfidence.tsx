/**
 * 辨識信心的橫幅。**三個等級長得不一樣**，這是刻意的。
 *
 * 模型自己回報的 confidence 是這整條流程裡唯一一個「它知道自己讀得準不準」的訊號。
 * 把 high 與 low 畫成同一個樣子，等於把那個訊號丟掉 —— 店員會用同樣的速度按下
 * 「建立商品」，然後某一天發現條碼是錯的。
 *
 * · high   綠色、一句「仍請確認條碼」
 * · medium 琥珀色、明確要求逐欄核對
 * · low    紅色、預設**當作沒讀到**在講話：建議重拍或直接手動輸入
 *
 * （none 在伺服器端就被擋成 no_content 了，不會走到這裡；還是留一個分支，因為
 *   「理論上不會發生」不是驗收條件。）
 */
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";

type Confidence = "high" | "medium" | "low" | "none";

const STYLES: Record<Confidence, { label: string; hint: string; className: string }> = {
  high: {
    label: "辨識信心：高",
    hint: "封面讀得很清楚。條碼與售價仍請看一眼再送出 —— 這兩個錯了最貴。",
    className: "border-emerald-500/40 bg-emerald-500/5 text-emerald-900 dark:text-emerald-200",
  },
  medium: {
    label: "辨識信心：中",
    hint: "有些欄位模型自己也不太確定。請逐欄核對書名、期數與條碼再送出。",
    className: "border-amber-500/40 bg-amber-500/5 text-amber-900 dark:text-amber-200",
  },
  low: {
    label: "辨識信心：低",
    hint: "只讀到零星文字，這一份結果很可能是錯的。建議靠近一點重拍，或直接手動輸入。",
    className: "border-destructive/50 bg-destructive/5 text-destructive",
  },
  none: {
    label: "辨識信心：無",
    hint: "模型看不出這是什麼。請重拍或直接手動輸入。",
    className: "border-destructive/50 bg-destructive/5 text-destructive",
  },
};

type Props = {
  confidence: Confidence;
  /** 模型在封面上讀到的原文。低信心時特別有用 —— 看得出它到底看到了什麼。 */
  detectedText: string | null;
};

export function ProductOCRConfidence({ confidence, detectedText }: Props) {
  const style = STYLES[confidence] ?? STYLES.low;
  const Icon =
    confidence === "high" ? CheckCircle2 : confidence === "medium" ? Info : AlertTriangle;

  return (
    <div className={cn("space-y-1.5 rounded-md border p-3", style.className)}>
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {style.label}
      </p>
      <p className="text-xs">{style.hint}</p>
      {detectedText ? (
        <details className="text-xs">
          <summary className="cursor-pointer select-none">看模型在封面上讀到的文字</summary>
          <p className="mt-1 whitespace-pre-wrap break-words opacity-80">{detectedText}</p>
        </details>
      ) : null}
    </div>
  );
}

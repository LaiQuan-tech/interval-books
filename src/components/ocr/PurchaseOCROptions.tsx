/**
 * 進貨單辨識確認畫面上方的四個共用欄位：廠商、進貨日期、分類、備註。
 *
 * 這四個在一張單子上只會有一組（同一張進貨單就是同一天、同一個廠商），所以放在
 * 表格外面填一次，而不是每一列重複一次。
 *
 * ⚠️ 廠商有兩個欄位不是重複：對得到名單就走 vendor_id（之後查得到「跟誰進的」），
 *    對不到才留自由文字。兩個都留著的話，沒有人回答得出這批貨到底是哪一家 ——
 *    與 Excel 匯入（purchase-import.ts）同一條規矩。
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { VendorOption } from "@/components/inventory/VendorSelect";

/** Radix Select 不收空字串當 value。 */
const NONE = "__none__";

export type OcrPurchaseOptions = {
  vendor_id: string;
  vendor: string;
  category_id: string;
  purchase_date: string;
  notes: string;
};

type Props = {
  options: OcrPurchaseOptions;
  onOptionsChange: (next: OcrPurchaseOptions) => void;
  vendors: VendorOption[];
  categories: { category_id: string; name: string }[];
};

export function PurchaseOCROptions({ options, onOptionsChange, vendors, categories }: Props) {
  const set = (patch: Partial<OcrPurchaseOptions>) => onOptionsChange({ ...options, ...patch });

  return (
    <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label className="text-xs">供應商（名單）</Label>
        <Select
          value={options.vendor_id || NONE}
          onValueChange={(v) => set({ vendor_id: v === NONE ? "" : v, vendor: "" })}
        >
          <SelectTrigger aria-label="供應商">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>不指定</SelectItem>
            {vendors.map((v) => (
              <SelectItem key={v.vendor_id} value={v.vendor_id}>
                {v.short_name || v.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ocr-vendor-text" className="text-xs">
          供應商（辨識到的文字）
        </Label>
        <Input
          id="ocr-vendor-text"
          value={options.vendor}
          maxLength={200}
          disabled={options.vendor_id !== ""}
          placeholder={options.vendor_id ? "已從名單選了供應商" : "名單裡沒有時填這裡"}
          onChange={(e) => set({ vendor: e.target.value })}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ocr-date" className="text-xs">
          進貨日期
        </Label>
        <Input
          id="ocr-date"
          type="date"
          value={options.purchase_date}
          onChange={(e) => set({ purchase_date: e.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          單據上讀不到日期時，這裡預設是今天（台北）。
        </p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">分類（新建商品用）</Label>
        <Select
          value={options.category_id || NONE}
          onValueChange={(v) => set({ category_id: v === NONE ? "" : v })}
        >
          <SelectTrigger aria-label="分類">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>不指定</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.category_id} value={c.category_id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="ocr-notes" className="text-xs">
          備註（會寫進每一筆進貨）
        </Label>
        <Textarea
          id="ocr-notes"
          rows={2}
          maxLength={2000}
          value={options.notes}
          placeholder="單據上的其他備註"
          onChange={(e) => set({ notes: e.target.value })}
        />
      </div>
    </div>
  );
}

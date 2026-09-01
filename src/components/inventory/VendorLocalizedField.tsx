/**
 * 「核准並上架」那張表單裡的三語欄位。
 *
 * 從 VendorSubmissionQueue 抽出來（原檔 476 行，元件檔的上限是 300）。
 *
 * ⚠️ 這是**唯一一個**出現在進銷存底下的三語欄位，而且它填的不是進銷存的資料 ——
 *    是官網商品（inv_approve_vendor_product 會順便寫進上架那張表）。進銷存自己的
 *    name 是單語 text，別把這個元件借去填 inv.products。
 */
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type Localized = { zh: string; en: string; ja: string };

/**
 * 三語一組的欄位。
 *
 * ⚠️ 三個都是必填 —— localizedSchema 鏡射的是資料庫的 is_localized() CHECK，
 *    少一個會變成 23514，而那是一個店員看不懂的 Postgres 錯誤碼。
 */
export function VendorLocalizedField({
  label,
  idPrefix,
  value,
  onChange,
}: {
  label: string;
  idPrefix: string;
  value: Localized;
  onChange: (next: Localized) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}（三語都要填）</Label>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input
          id={`${idPrefix}-zh`}
          placeholder="中文"
          value={value.zh}
          onChange={(e) => onChange({ ...value, zh: e.target.value })}
        />
        <Input
          id={`${idPrefix}-en`}
          placeholder="English"
          value={value.en}
          onChange={(e) => onChange({ ...value, en: e.target.value })}
        />
        <Input
          id={`${idPrefix}-ja`}
          placeholder="日本語"
          value={value.ja}
          onChange={(e) => onChange({ ...value, ja: e.target.value })}
        />
      </div>
    </div>
  );
}

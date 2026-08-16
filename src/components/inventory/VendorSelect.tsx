/**
 * 供應商選擇器。
 *
 * ── 為什麼一個欄位要兩個值 ────────────────────────────────────────────────
 * inv.purchases 同時有 vendor_id（外鍵，指向 inv.vendors）與 vendor（自由文字）。
 * 這不是重複：0009 從舊系統搬進來的進貨有一大半只留下一個供應商名字，對不到任何
 * 一筆 vendors。把文字欄拿掉等於把那些資料洗掉，所以這個元件同時管兩個值，而且
 * **兩者互斥** —— 選了名單上的供應商就把文字清空，打了自由文字就把 id 清空。
 * 兩個都留著，之後沒有人能回答「這批貨到底是跟誰進的」。
 *
 * 來源的 VendorSelect 會在下拉裡直接開一個「新增供應商」的表單。這裡沒有搬：
 * inv.vendors 有 42 欄含身分證字號與稅籍（0016 §5c），在進貨的對話框裡順手建一筆
 * 只會建出一堆只有名字的空殼。要建供應商去供應商那一頁建，這裡先用自由文字擋著。
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

export type VendorOption = { vendor_id: string; name: string; short_name: string | null };

/** Radix Select 不收空字串當 value，所以兩個特殊選項用哨兵值。 */
const NONE = "__none__";
const CUSTOM = "__custom__";

export type VendorValue = { vendor_id: string | null; vendor: string | null };

type Props = {
  value: VendorValue;
  onChange: (next: VendorValue) => void;
  vendors: VendorOption[];
  disabled?: boolean;
  /** 兩個控制項要各自的 id，同一頁出現兩個 VendorSelect 時 label 才不會指錯。 */
  idPrefix?: string;
  label?: string;
};

export function VendorSelect({
  value,
  onChange,
  vendors,
  disabled,
  idPrefix = "vendor",
  label = "供應商",
}: Props) {
  // vendor_id 優先。兩個都空 = 沒指定；只有文字 = 自由輸入模式。
  const mode = value.vendor_id ? value.vendor_id : value.vendor !== null ? CUSTOM : NONE;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${idPrefix}-select`} className="text-xs">
        {label}
      </Label>
      <Select
        value={mode}
        disabled={disabled}
        onValueChange={(v) => {
          if (v === NONE) onChange({ vendor_id: null, vendor: null });
          else if (v === CUSTOM) onChange({ vendor_id: null, vendor: "" });
          else onChange({ vendor_id: v, vendor: null });
        }}
      >
        <SelectTrigger id={`${idPrefix}-select`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>不指定</SelectItem>
          {vendors.map((v) => (
            <SelectItem key={v.vendor_id} value={v.vendor_id}>
              {v.short_name || v.name}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>自行輸入名稱…</SelectItem>
        </SelectContent>
      </Select>

      {mode === CUSTOM ? (
        <Input
          id={`${idPrefix}-text`}
          value={value.vendor ?? ""}
          maxLength={200}
          disabled={disabled}
          placeholder="供應商名稱（不會建立供應商資料）"
          aria-label={`${label}名稱`}
          onChange={(e) => onChange({ vendor_id: null, vendor: e.target.value })}
        />
      ) : null}
    </div>
  );
}

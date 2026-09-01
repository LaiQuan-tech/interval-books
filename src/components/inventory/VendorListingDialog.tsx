/**
 * 核准廠商送審商品時「順便上架到官網」的表單。
 *
 * 從 VendorSubmissionQueue 抽出來（原檔 476 行，元件檔的上限是 300）：佇列那半邊管
 * 的是「有哪些要審、按核准或退回」，這半邊管的是「上架要填什麼」，兩件事各自會變動。
 *
 * ⚠️ 核准與上架在**同一個資料庫交易**裡（inv_approve_vendor_product），不會出現
 *    「審過了但沒上架」這種半套狀態。網址代稱撞號會拿到 23505，資料庫那一層已經
 *    翻成「這個網址代稱已經被用掉了，請換一個」。
 *
 * ⚠️ 三語文案**是店員填的，廠商送不進來** —— 沒有人能從「紅烏龍茶餅」自動生出可以
 *    放在英文站上的商品名，所以這一步只能是人工。
 */
import { useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { VendorLocalizedField, type Localized } from "@/components/inventory/VendorLocalizedField";
import { money } from "@/components/inventory/VendorFormParsers";
import {
  vendorSubmissionApprovalSchema,
  type VendorSubmissionApprovalValues,
} from "@/lib/admin/schemas";
import type { VendorSubmissionRow } from "@/server/repos/inv-vendors";

type ListingDraft = {
  slug: string;
  product_type: "goods" | "book";
  title: Localized;
  summary: Localized;
  description: Localized;
  price: string;
  units_per_sale: string;
  status: "draft" | "active";
};

function emptyDraft(row: VendorSubmissionRow): ListingDraft {
  return {
    slug: "",
    product_type: "goods",
    // 中文先帶廠商送的名字（那是唯一一個有把握的欄位），英日文一定要人填。
    title: { zh: row.name, en: "", ja: "" },
    summary: { zh: "", en: "", ja: "" },
    description: { zh: "", en: "", ja: "" },
    price: row.selling_price === null ? "" : String(Math.round(row.selling_price)),
    units_per_sale: "1",
    status: "draft",
  };
}

export function VendorListingDialog({
  row,
  onClose,
  onSubmit,
}: {
  row: VendorSubmissionRow | null;
  onClose: () => void;
  onSubmit: (row: VendorSubmissionRow, listing: VendorSubmissionApprovalValues["listing"]) => void;
}) {
  const [draft, setDraft] = useState<ListingDraft | null>(null);

  // row 換人（或第一次開）就重建草稿。用 render 期間比對而不是 useEffect：
  // useEffect 會先畫一次上一件商品的內容再被蓋掉。
  const [lastId, setLastId] = useState<string | null>(null);
  if (row && row.inv_product_id !== lastId) {
    setLastId(row.inv_product_id);
    setDraft(emptyDraft(row));
  }

  if (!row || !draft) return null;

  function submit() {
    if (!row || !draft) return;
    const parsed = vendorSubmissionApprovalSchema.safeParse({
      id: row.inv_product_id,
      approved: true,
      listing: {
        slug: draft.slug,
        product_type: draft.product_type,
        title: draft.title,
        summary: draft.summary,
        description: draft.description,
        price: Number(draft.price.trim() === "" ? Number.NaN : draft.price),
        units_per_sale: Number(
          draft.units_per_sale.trim() === "" ? Number.NaN : draft.units_per_sale,
        ),
        // 廠商上傳的圖直接沿用。沒有就是 null，上架後再到商品那一頁補。
        image_key: row.image_key,
        status: draft.status,
      },
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查上架資料");
      return;
    }
    onSubmit(row, parsed.data.listing);
  }

  return (
    <Dialog open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">核准並上架「{row.name}」</DialogTitle>
          <DialogDescription>
            核准與上架在同一個資料庫交易裡完成，不會出現「審過了但沒上架」。三語文案是 店員填的 ——
            廠商送不進來。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="listing-slug">網址代稱</Label>
            <Input
              id="listing-slug"
              placeholder="只能用小寫英數字與連字號，例：red-oolong-cake"
              value={draft.slug}
              onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="listing-type">商品類型</Label>
            <Select
              value={draft.product_type}
              onValueChange={(v) => setDraft({ ...draft, product_type: v as "goods" | "book" })}
            >
              <SelectTrigger id="listing-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="goods">選品</SelectItem>
                <SelectItem value="book">書</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="listing-price">官網定價</Label>
            <Input
              id="listing-price"
              type="number"
              min={0}
              step={1}
              value={draft.price}
              onChange={(e) => setDraft({ ...draft, price: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              廠商建議 {money(row.selling_price)} —— 官網賣多少由店家決定。
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="listing-units">一次賣幾件</Label>
            <Input
              id="listing-units"
              type="number"
              min={1}
              max={999}
              value={draft.units_per_sale}
              onChange={(e) => setDraft({ ...draft, units_per_sale: e.target.value })}
            />
          </div>
        </div>

        <Separator />

        <VendorLocalizedField
          label="商品名稱"
          idPrefix="listing-title"
          value={draft.title}
          onChange={(v) => setDraft({ ...draft, title: v })}
        />
        <VendorLocalizedField
          label="簡介"
          idPrefix="listing-summary"
          value={draft.summary}
          onChange={(v) => setDraft({ ...draft, summary: v })}
        />
        <VendorLocalizedField
          label="詳細說明"
          idPrefix="listing-description"
          value={draft.description}
          onChange={(v) => setDraft({ ...draft, description: v })}
        />

        <div className="flex items-center gap-2 rounded-md border border-border p-3">
          <Switch
            id="listing-status"
            checked={draft.status === "active"}
            onCheckedChange={(v) => setDraft({ ...draft, status: v ? "active" : "draft" })}
          />
          <Label htmlFor="listing-status" className="cursor-pointer">
            上架後直接公開（關掉就是先存成草稿）
          </Label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button className="gap-1.5" onClick={submit}>
            <CheckCircle2 className="h-4 w-4" />
            核准並上架
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

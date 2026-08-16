/**
 * 廠商送審的商品佇列（店家這一側）。
 *
 * ── 這一區在解什麼問題 ────────────────────────────────────────────────────
 * 廠商從自助入口送進來的商品**不會**出現在 /admin/inventory-products 的待審清單裡：
 * 那個 view 只收店員自己建的（0019 §7.8 的 inv_admin_vendor_submissions 專門過濾
 * submitted_via = 'vendor_portal'）。兩者的審核標準本來就不同 —— 廠商送的要對照合約，
 * 店員建的要對照進貨單。沒有這一區的話，廠商送出去的東西會靜靜躺在資料庫裡：送的人
 * 以為在等，審的人根本不知道有東西要審。
 *
 * ── 核准的時候可以順便上架 ────────────────────────────────────────────────
 * 勾了「同時上架到官網」就要填三語文案。**那是店員填的，廠商送不進來** —— 沒有人能
 * 從「紅烏龍茶餅」自動生出可以放在英文站上的商品名，所以這一步只能是人工。
 *
 * ⚠️ 核准與上架在**同一個資料庫交易**裡（inv_approve_vendor_product），不會出現
 *    「審過了但沒上架」這種半套狀態。網址代稱撞號會拿到 23505，資料庫那一層已經
 *    翻成「這個網址代稱已經被用掉了，請換一個」。
 *
 * ⚠️ `canApprove` 只控制**畫面**。這一區要的是 **approve_products**，不是
 *    approve_vendors —— 一個能簽核廠商的人不見得該決定哪本書上架。按鈕變灰不是
 *    授權，真正擋住直接 POST /_serverFn/… 的是 fns/inv-vendors.ts 裡
 *    approveVendorSubmission 那一次 requirePermission()，而它從 staff_permissions
 *    重讀權限，不看前端。
 */
import { useState } from "react";
import { CheckCircle2, Loader2, PackageCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
import { ApprovalStatusBadge } from "@/components/inventory/ApprovalStatusBadge";
import {
  vendorSubmissionApprovalSchema,
  type VendorSubmissionApprovalValues,
} from "@/lib/admin/schemas";
import type { VendorSubmissionRow } from "@/server/repos/inv-vendors";

type SubmissionStatus = "all" | "pending" | "approved" | "rejected";

type Props = {
  rows: VendorSubmissionRow[];
  status: SubmissionStatus;
  onStatusChange: (next: SubmissionStatus) => void;
  busyId: string | null;
  loading: boolean;
  canApprove: boolean;
  onDecide: (
    row: VendorSubmissionRow,
    approved: boolean,
    listing: VendorSubmissionApprovalValues["listing"],
  ) => void;
};

const STATUS_OPTIONS: { code: SubmissionStatus; label: string }[] = [
  { code: "pending", label: "待審核" },
  { code: "approved", label: "已核准" },
  { code: "rejected", label: "已退回" },
  { code: "all", label: "全部" },
];

type Localized = { zh: string; en: string; ja: string };

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

function money(value: number | null): string {
  return value === null ? "—" : `NT$ ${Number(value).toLocaleString("zh-TW")}`;
}

export function VendorSubmissionQueue({
  rows,
  status,
  onStatusChange,
  busyId,
  loading,
  canApprove,
  onDecide,
}: Props) {
  const [listingFor, setListingFor] = useState<VendorSubmissionRow | null>(null);

  const blockedTitle = canApprove ? undefined : "需要「approve_products」權限";

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PackageCheck className="h-4 w-4" aria-hidden="true" />
          <p className="text-sm font-medium">廠商送審的商品</p>
          <Badge variant="secondary" className="font-normal">
            {rows.length}
          </Badge>
        </div>
        <Select
          value={status}
          disabled={loading}
          onValueChange={(v) => onStatusChange(v as SubmissionStatus)}
        >
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.code} value={o.code}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="text-sm text-muted-foreground">
        這些是廠商從自助入口送進來的商品，不會出現在商品管理的待審清單裡。核准的時候可以
        順便上架到官網，但三語文案要店員自己填。
      </p>

      {loading ? (
        <div className="flex h-24 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">目前沒有符合條件的送審商品。</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const busy = busyId === row.inv_product_id;
            return (
              <li
                key={row.inv_product_id}
                className={`flex flex-wrap items-start justify-between gap-3 rounded-md border border-border p-3 ${
                  busy ? "opacity-60" : ""
                }`}
              >
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">
                    {row.name}
                    {row.issue_number ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {row.issue_number}
                      </span>
                    ) : null}
                    <ApprovalStatusBadge status={row.approval_status} className="ml-1.5" />
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {row.vendor_name ?? "未知廠商"}
                    {row.vendor_code ? `（${row.vendor_code}）` : ""}
                    ・建議售價 {money(row.selling_price)}
                    {row.vendor_is_consignment
                      ? `・寄售抽成 ${
                          row.vendor_commission_rate === null
                            ? "未設定"
                            : `${Number((row.vendor_commission_rate * 100).toFixed(2))}%`
                        }`
                      : "・買斷"}
                  </p>
                  {row.publisher || row.series ? (
                    <p className="text-xs text-muted-foreground">
                      {[row.publisher, row.series].filter(Boolean).join("・")}
                    </p>
                  ) : null}
                  {row.notes ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{row.notes}</p>
                  ) : null}
                </div>

                {row.approval_status === "pending" ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 border-emerald-600/40 text-emerald-700 hover:bg-emerald-600/10"
                      disabled={busy || !canApprove}
                      title={blockedTitle}
                      onClick={() => onDecide(row, true, null)}
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      )}
                      核准
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      disabled={busy || !canApprove}
                      title={blockedTitle}
                      onClick={() => setListingFor(row)}
                    >
                      核准並上架
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10"
                      disabled={busy || !canApprove}
                      title={blockedTitle}
                      onClick={() => onDecide(row, false, null)}
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      退回
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {!canApprove ? (
        <p className="text-xs text-muted-foreground">
          你沒有「approve_products」權限，所以這一區的按鈕是灰的。這與廠商本身的審核權
          （approve_vendors）是兩件事。
        </p>
      ) : null}

      <ListingDialog
        row={listingFor}
        onClose={() => setListingFor(null)}
        onSubmit={(row, listing) => {
          setListingFor(null);
          onDecide(row, true, listing);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 核准並上架
// ---------------------------------------------------------------------------

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

function ListingDialog({
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

        <LocalizedField
          label="商品名稱"
          idPrefix="listing-title"
          value={draft.title}
          onChange={(v) => setDraft({ ...draft, title: v })}
        />
        <LocalizedField
          label="簡介"
          idPrefix="listing-summary"
          value={draft.summary}
          onChange={(v) => setDraft({ ...draft, summary: v })}
        />
        <LocalizedField
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

/**
 * 三語一組的欄位。
 *
 * ⚠️ 三個都是必填 —— localizedSchema 鏡射的是資料庫的 is_localized() CHECK，
 *    少一個會變成 23514，而那是一個店員看不懂的 Postgres 錯誤碼。
 */
function LocalizedField({
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

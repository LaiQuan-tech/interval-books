import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { ImageField } from "@/components/admin/ImageField";
import { productSchema, type ProductFormValues } from "@/lib/admin/schemas";
import { listProducts, removeProduct, upsertProduct } from "@/lib/admin/fns/products";
import { imageFor, curatedObjects } from "@/lib/images";
import { formatUpdatedAt } from "@/lib/admin/format";

type ProductRow = Awaited<ReturnType<typeof listProducts>>[number];
type ProductType = ProductFormValues["product_type"];
type ProductStatus = ProductFormValues["status"];
type ProductSourceType = NonNullable<ProductFormValues["source_type"]>;

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

/** goods/book ship physically; event/journey are bookings with capacity —
 * mirrors the comment on products.product_type in
 * supabase/migrations/0004_commerce_products.sql. */
const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  goods: "商品（實體）",
  book: "書籍",
  event: "活動",
  journey: "策旅",
};

const PRODUCT_STATUS_LABEL: Record<ProductStatus, string> = {
  draft: "草稿",
  active: "上架",
  archived: "下架封存",
};

const PRODUCT_STATUS_BADGE: Record<ProductStatus, "default" | "secondary" | "outline"> = {
  draft: "secondary",
  active: "default",
  archived: "outline",
};

const PRODUCT_SOURCE_TYPE_LABEL: Record<ProductSourceType, string> = {
  event: "活動",
  journey: "策旅",
  curated_item: "選品",
};

/** Sentinel for the "不關聯" option — Radix <Select.Item> rejects an empty-string value. */
const NONE_SOURCE_TYPE = "__none__";

function isBookableType(type: ProductType): boolean {
  return type === "event" || type === "journey";
}

function isShippableType(type: ProductType): boolean {
  return type === "goods" || type === "book";
}

function formatTWD(n: number): string {
  return `NT$${n.toLocaleString("zh-Hant-TW")}`;
}

/** List-table / read-only summary of stock or capacity, e.g. "已報名 3 / 20" or "庫存 12". */
function inventoryLabel(p: ProductRow): string {
  if (p.capacity != null) return `已報名 ${p.seats_taken} / ${p.capacity}`;
  if (p.stock != null) return `庫存 ${p.stock}`;
  return "—";
}

export const Route = createFileRoute("/admin/_shell/products")({
  loader: async () => {
    const products = await listProducts();
    return { products };
  },
  head: () => ({
    meta: [{ title: "商品｜小時光書店後台" }],
  }),
  component: AdminProductsPage,
});

function toFormValues(row: ProductRow): ProductFormValues {
  return {
    id: row.id,
    slug: row.slug,
    product_type: row.product_type,
    source_type: row.source_type,
    source_id: row.source_id,
    title: row.title,
    summary: row.summary,
    description: row.description,
    price: row.price,
    compare_at_price: row.compare_at_price,
    stock: row.stock,
    capacity: row.capacity,
    image_key: row.image_key,
    requires_shipping: row.requires_shipping,
    status: row.status,
    sort_order: row.sort_order,
  };
}

function AdminProductsPage() {
  const { products } = Route.useLoaderData();
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProductRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(row: ProductRow) {
    setEditing(row);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function handleSubmit(values: ProductFormValues) {
    setSubmitting(true);
    try {
      await upsertProduct({ data: editing ? { ...values, id: editing.id } : values });
      toast.success(editing ? "已更新商品" : "已新增商品");
      setDialogOpen(false);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await removeProduct({ data: { id: deleteTarget.id } });
      toast.success("已刪除商品");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  const nextSortOrder = products.reduce((max, p) => Math.max(max, p.sort_order), 0) + 1;

  const defaultValues: ProductFormValues = editing
    ? toFormValues(editing)
    : {
        slug: "",
        product_type: "goods",
        source_type: null,
        source_id: null,
        title: { ...EMPTY_LOCALIZED },
        summary: { ...EMPTY_LOCALIZED },
        description: { ...EMPTY_LOCALIZED },
        price: 0,
        compare_at_price: null,
        stock: null,
        capacity: null,
        image_key: null,
        requires_shipping: true,
        status: "draft",
        sort_order: nextSortOrder,
      };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">商品</h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {products.length} 件</p>
        </div>
        <Button onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          新增商品
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead className="w-16">圖片</TableHead>
              <TableHead>標題</TableHead>
              <TableHead>類型</TableHead>
              <TableHead>價格</TableHead>
              <TableHead>名額／庫存</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="hidden w-36 lg:table-cell">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增商品」開始。
                </TableCell>
              </TableRow>
            ) : (
              products.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-muted-foreground">{p.sort_order}</TableCell>
                  <TableCell>
                    <img
                      src={imageFor(p.image_key, curatedObjects)}
                      alt=""
                      className="h-10 w-14 rounded-sm border border-border object-cover"
                    />
                  </TableCell>
                  <TableCell className="max-w-sm truncate font-medium">{p.title.zh}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{PRODUCT_TYPE_LABEL[p.product_type]}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.compare_at_price != null && p.compare_at_price > p.price ? (
                      <span className="mr-1 text-xs line-through opacity-60">
                        {formatTWD(p.compare_at_price)}
                      </span>
                    ) : null}
                    {formatTWD(p.price)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{inventoryLabel(p)}</TableCell>
                  <TableCell>
                    <Badge variant={PRODUCT_STATUS_BADGE[p.status]}>
                      {PRODUCT_STATUS_LABEL[p.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                    {formatUpdatedAt(p.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(p)}>
                        編輯
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(p)}
                      >
                        刪除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "編輯商品" : "新增商品"}</DialogTitle>
            <DialogDescription>
              中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。
            </DialogDescription>
          </DialogHeader>
          <ProductForm
            key={formKey}
            defaultValues={defaultValues}
            seatsTaken={editing ? editing.seats_taken : null}
            onSubmit={handleSubmit}
            submitting={submitting}
            submitLabel={editing ? "儲存變更" : "新增"}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要刪除這件商品嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.title.zh}」刪除後無法復原。
              {deleteTarget && deleteTarget.seats_taken > 0 ? (
                <span className="mt-2 block font-medium text-destructive">
                  此商品已有 {deleteTarget.seats_taken}{" "}
                  筆報名／訂位紀錄，刪除前請確認不會影響既有訂單。
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void handleDelete();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "刪除中…" : "刪除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type ProductFormProps = {
  defaultValues: ProductFormValues;
  /** editing row's seats_taken, or null when creating (there is nothing to show yet). Read-only — see repo file header. */
  seatsTaken: number | null;
  onSubmit: (values: ProductFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

function ProductForm({
  defaultValues,
  seatsTaken,
  onSubmit,
  submitting,
  submitLabel,
}: ProductFormProps) {
  const form = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues,
  });

  const productType = useWatch({ control: form.control, name: "product_type" });
  const capacityValue = useWatch({ control: form.control, name: "capacity" });
  const bookable = isBookableType(productType);
  const shippable = isShippableType(productType);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="product_type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>商品類型</FormLabel>
                <Select
                  value={field.value}
                  onValueChange={(next) => {
                    field.onChange(next);
                    // Clear whichever of stock/capacity no longer applies —
                    // otherwise a stale hidden value rides along to the
                    // server (e.g. an "event" product still carrying a
                    // leftover stock number from when it was "goods").
                    if (isBookableType(next as ProductType)) {
                      form.setValue("stock", null, { shouldValidate: true });
                    } else {
                      form.setValue("capacity", null, { shouldValidate: true });
                    }
                  }}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {(Object.keys(PRODUCT_TYPE_LABEL) as ProductType[]).map((v) => (
                      <SelectItem key={v} value={v}>
                        {PRODUCT_TYPE_LABEL[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>決定下面顯示「庫存」還是「名額」欄位。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>狀態</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {(Object.keys(PRODUCT_STATUS_LABEL) as ProductStatus[]).map((v) => (
                      <SelectItem key={v} value={v}>
                        {PRODUCT_STATUS_LABEL[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>網址代稱</FormLabel>
              <FormControl>
                <Input placeholder="例如 spring-tea-set" {...field} />
              </FormControl>
              <FormDescription>建議使用半形英數字與連字號，且不能與其他商品重複。</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <LocalizedField name="title" label="標題" />
        <LocalizedField name="summary" label="摘要" multiline />
        <LocalizedField name="description" label="說明" multiline />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="price"
            render={({ field }) => (
              <FormItem>
                <FormLabel>價格（元）</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value}
                    onChange={(e) =>
                      field.onChange(e.target.value === "" ? 0 : Math.trunc(Number(e.target.value)))
                    }
                  />
                </FormControl>
                <FormDescription>新台幣整數，不接受小數。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="compare_at_price"
            render={({ field }) => (
              <FormItem>
                <FormLabel>原價（選填）</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ""}
                    onChange={(e) =>
                      field.onChange(
                        e.target.value === "" ? null : Math.trunc(Number(e.target.value)),
                      )
                    }
                  />
                </FormControl>
                <FormDescription>要顯示劃線比價時才填，單位同為元。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {shippable ? (
          <div className="grid grid-cols-2 gap-4 rounded-md border border-border p-4">
            <FormField
              control={form.control}
              name="stock"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>庫存（選填）</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      step={1}
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === "" ? null : Math.trunc(Number(e.target.value)),
                        )
                      }
                    />
                  </FormControl>
                  <FormDescription>留白表示不管理庫存（可持續下單）。</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="requires_shipping"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>需要寄送</FormLabel>
                  <div className="flex h-9 items-center gap-2">
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <span className="text-sm text-muted-foreground">
                      {field.value ? "是" : "否（例如電子憑證）"}
                    </span>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        ) : null}

        {bookable ? (
          <div className="space-y-2 rounded-md border border-border p-4">
            <FormField
              control={form.control}
              name="capacity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>名額</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      step={1}
                      name={field.name}
                      ref={field.ref}
                      onBlur={field.onBlur}
                      value={field.value ?? ""}
                      onChange={(e) =>
                        field.onChange(
                          e.target.value === "" ? null : Math.trunc(Number(e.target.value)),
                        )
                      }
                    />
                  </FormControl>
                  <FormDescription>
                    活動／策旅商品必填——資料庫會拒絕沒有名額的活動類商品。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {seatsTaken != null ? (
              <p className="text-sm text-muted-foreground">
                已報名 {seatsTaken} / {capacityValue ?? "—"}{" "}
                ——唯讀，由訂位系統（reserve_product_seat）自動維護，無法在此編輯。
              </p>
            ) : null}
          </div>
        ) : null}

        <FormField
          control={form.control}
          name="image_key"
          render={({ field }) => (
            <FormItem>
              <FormLabel>商品圖片</FormLabel>
              {/* Not wrapped in <FormControl> (a Radix Slot): ImageField is a plain
                  composite component, not a forwardRef primitive like Input/Switch,
                  so Slot's ref-cloning would warn in the console for no benefit. */}
              <ImageField
                value={field.value ?? null}
                onChange={field.onChange}
                fallback={curatedObjects}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="source_type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>關聯來源類型（選填）</FormLabel>
              <Select
                value={field.value ?? NONE_SOURCE_TYPE}
                onValueChange={(next) => field.onChange(next === NONE_SOURCE_TYPE ? null : next)}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={NONE_SOURCE_TYPE}>不關聯</SelectItem>
                  {(Object.keys(PRODUCT_SOURCE_TYPE_LABEL) as ProductSourceType[]).map((v) => (
                    <SelectItem key={v} value={v}>
                      {PRODUCT_SOURCE_TYPE_LABEL[v]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                用來把商品連回既有的活動或選品內容（例如賣一場活動的票）。與下方 ID
                請一起填寫或一起留白；留白表示這是獨立商品。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="source_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>關聯來源 ID（選填）</FormLabel>
              <FormControl>
                <Input
                  placeholder="對應活動／策旅／選品項目的 id"
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value === "" ? null : e.target.value)}
                />
              </FormControl>
              <FormDescription>
                純文字，不會檢查是否存在——請自行從對應頁面複製正確的 id。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="sort_order"
          render={({ field }) => (
            <FormItem>
              <FormLabel>排序（數字越小越前面）</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={field.value}
                  onChange={(e) =>
                    field.onChange(e.target.value === "" ? 0 : Number(e.target.value))
                  }
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? "儲存中…" : submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

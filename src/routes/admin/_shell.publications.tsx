/**
 * /admin/publications —— 地方刊物展
 *
 * 126 本刊物的列表、三語校稿、換封面、排序、上下架，以及**把一本刊物連到庫存
 * 商品**。最後那一項是這一頁存在的主要理由：
 *
 *   匯入當下有貨又有定價的只有一小部分，其餘的在進銷存裡是 0 元（寄售／出借尚未
 *   定價）或根本沒有對應品項。等店裡把價格補完，這一頁挑品項、填價格、按連結，
 *   前台下一次載入就長出購買鈕 —— 不用重跑匯入，也不用改任何一行程式。
 *
 * 連結背後走的是既有的上架路徑（0011 的 product_inventory_links + 0012 的
 * inv_listing_candidates），不是這一頁自己發明的第二套，見
 * src/server/repos/publications.ts#linkPublicationToInventory。
 */
import { useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link2, Link2Off, Pencil, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
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
import { ImageField } from "@/components/admin/ImageField";
import { LocalizedField } from "@/components/admin/LocalizedField";
import {
  publicationLinkSchema,
  publicationSchema,
  type PublicationFormValues,
  type PublicationLinkFormValues,
} from "@/lib/admin/schemas";
import {
  linkPublicationToInventory,
  listPublicationNameMatches,
  listPublications,
  unlinkPublication,
  updatePublication,
} from "@/lib/admin/fns/publications";
import {
  listInventoryCandidates,
  listListedInventoryProducts,
} from "@/lib/admin/fns/inventory-listing";
import { imageFor } from "@/lib/images";
import bookstoreImg from "@/assets/bookstore-interior.jpg";

export const Route = createFileRoute("/admin/_shell/publications")({
  loader: async () => {
    const [publications, nameMatches, candidates, listed] = await Promise.all([
      listPublications(),
      listPublicationNameMatches(),
      listInventoryCandidates(),
      listListedInventoryProducts(),
    ]);
    return { publications, nameMatches, candidates, listed };
  },
  head: () => ({ meta: [{ title: "地方刊物展｜小時光書店後台" }] }),
  component: AdminPublicationsPage,
});

type Publication = Awaited<ReturnType<typeof listPublications>>[number];
type NameMatch = Awaited<ReturnType<typeof listPublicationNameMatches>>[number];
type Candidate = Awaited<ReturnType<typeof listInventoryCandidates>>[number];
type Listed = Awaited<ReturnType<typeof listListedInventoryProducts>>[number];

const SHEET_LABEL: Record<string, string> = { tw: "台灣", jp: "日本" };
const formatTWD = (n: number) => `NT$${n.toLocaleString("zh-Hant-TW")}`;

function AdminPublicationsPage() {
  const { publications, nameMatches, candidates, listed } = Route.useLoaderData();
  const router = useRouter();

  const [keyword, setKeyword] = useState("");
  const [sheet, setSheet] = useState<"all" | "tw" | "jp">("all");
  const [linkState, setLinkState] = useState<"all" | "linked" | "unlinked">("all");
  const [editTarget, setEditTarget] = useState<Publication | null>(null);
  const [linkTarget, setLinkTarget] = useState<Publication | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<Publication | null>(null);
  const [busy, setBusy] = useState(false);

  /** product_id → 已上架商品的數字，讓列表直接看得到可售量。 */
  const listedByProduct = useMemo(
    () => new Map<string, Listed>(listed.map((l) => [l.product_id, l])),
    [listed],
  );
  const matchesByPublication = useMemo(() => {
    const m = new Map<string, NameMatch[]>();
    for (const row of nameMatches) {
      const list = m.get(row.publication_id) ?? [];
      list.push(row);
      m.set(row.publication_id, list);
    }
    return m;
  }, [nameMatches]);

  const rows = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    return publications.filter((p) => {
      if (sheet !== "all" && p.sheet !== sheet) return false;
      if (linkState === "linked" && !p.product_id) return false;
      if (linkState === "unlinked" && p.product_id) return false;
      if (!k) return true;
      return (
        p.title.zh.toLowerCase().includes(k) ||
        p.title.en.toLowerCase().includes(k) ||
        p.title.ja.toLowerCase().includes(k) ||
        p.region.toLowerCase().includes(k) ||
        p.slug.includes(k)
      );
    });
  }, [publications, keyword, sheet, linkState]);

  const linkedCount = publications.filter((p) => p.product_id).length;

  async function handleSave(values: PublicationFormValues) {
    setBusy(true);
    try {
      await updatePublication({ data: values });
      toast.success("已儲存");
      setEditTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  }

  async function handleLink(values: PublicationLinkFormValues) {
    setBusy(true);
    try {
      await linkPublicationToInventory({ data: values });
      toast.success("已連結，前台立刻可以買");
      setLinkTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "連結失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  }

  async function handleUnlink() {
    if (!unlinkTarget) return;
    setBusy(true);
    try {
      await unlinkPublication({ data: { publication_id: unlinkTarget.id } });
      toast.success("已解除連結（進銷存的庫存與紀錄不受影響）");
      setUnlinkTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "解除失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium">地方刊物展</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          共 {publications.length} 本，其中 {linkedCount} 本已連到庫存商品（前台有購買鈕）。
          其餘只在展覽頁展示 —— 等進銷存那側補完定價，在這裡連結就能賣。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜尋刊名、地域、代稱"
            className="w-64 pl-8"
          />
        </div>
        <Select value={sheet} onValueChange={(v) => setSheet(v as typeof sheet)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部地區</SelectItem>
            <SelectItem value="tw">台灣刊物</SelectItem>
            <SelectItem value="jp">日本刊物</SelectItem>
          </SelectContent>
        </Select>
        <Select value={linkState} onValueChange={(v) => setLinkState(v as typeof linkState)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部</SelectItem>
            <SelectItem value="linked">已連結（可買）</SelectItem>
            <SelectItem value="unlinked">未連結（只展示）</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground tabular-nums">顯示 {rows.length} 筆</span>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">封面</TableHead>
              <TableHead className="w-20">代稱</TableHead>
              <TableHead>刊名</TableHead>
              <TableHead>關注地域</TableHead>
              <TableHead>商品</TableHead>
              <TableHead className="text-right">售價</TableHead>
              <TableHead className="text-right">可售</TableHead>
              <TableHead className="text-right">排序</TableHead>
              <TableHead>狀態</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="h-24 text-center text-muted-foreground">
                  沒有符合條件的刊物。
                </TableCell>
              </TableRow>
            ) : (
              rows.map((p) => {
                const l = p.product_id ? listedByProduct.get(p.product_id) : undefined;
                return (
                  <TableRow key={p.id}>
                    <TableCell>
                      <img
                        src={imageFor(p.cover_image_key, bookstoreImg)}
                        alt=""
                        className="h-12 w-12 rounded border border-border object-cover"
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {p.slug}
                    </TableCell>
                    <TableCell>
                      <span className="font-medium">{p.title.zh}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {SHEET_LABEL[p.sheet] ?? p.sheet}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.region || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {l ? l.inv_name : p.product_id ? "（商品已建立）" : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {l ? formatTWD(l.price) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {l ? l.available : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{p.sort_order}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={p.is_published ? "default" : "secondary"}>
                          {p.is_published ? "展出中" : "已下架"}
                        </Badge>
                        {p.product_id ? (
                          <Badge variant="outline">可買</Badge>
                        ) : (
                          <Badge variant="secondary">只展示</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`編輯 ${p.title.zh}`}
                          onClick={() => setEditTarget(p)}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        {p.product_id ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`解除連結 ${p.title.zh}`}
                            onClick={() => setUnlinkTarget(p)}
                          >
                            <Link2Off className="h-4 w-4" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`連到庫存商品 ${p.title.zh}`}
                            onClick={() => setLinkTarget(p)}
                          >
                            <Link2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editTarget !== null} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>編輯「{editTarget?.title.zh}」</DialogTitle>
            <DialogDescription>
              刊名、製作單位與介紹都是三語，缺一語前台那一語就會是空白。代稱與原始序號 不開放修改 ——
              它們是回頭對照原始清單的憑據。
            </DialogDescription>
          </DialogHeader>
          {editTarget && (
            <PublicationForm
              key={editTarget.id}
              publication={editTarget}
              onSubmit={handleSave}
              submitting={busy}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={linkTarget !== null} onOpenChange={(o) => !o && setLinkTarget(null)}>
        <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>把「{linkTarget?.title.zh}」連到庫存商品</DialogTitle>
            <DialogDescription>
              挑一個進銷存品項、填上售價，前台立刻長出購買鈕。三語文案與封面直接沿用
              這本刊物的，不用重打。
            </DialogDescription>
          </DialogHeader>
          {linkTarget && (
            <LinkForm
              key={linkTarget.id}
              publication={linkTarget}
              suggested={matchesByPublication.get(linkTarget.id) ?? []}
              candidates={candidates}
              onSubmit={handleLink}
              submitting={busy}
            />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={unlinkTarget !== null} onOpenChange={(o) => !o && setUnlinkTarget(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>解除「{unlinkTarget?.title.zh}」的商品連結？</AlertDialogTitle>
          <AlertDialogHeader>
            <AlertDialogDescription>
              前台的購買鈕會消失，這本刊物仍留在展覽頁上。進銷存那一側的庫存、銷售
              紀錄與成本完全不受影響。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void handleUnlink();
              }}
            >
              {busy ? "處理中…" : "確定解除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PublicationForm({
  publication,
  onSubmit,
  submitting,
}: {
  publication: Publication;
  onSubmit: (values: PublicationFormValues) => void | Promise<void>;
  submitting: boolean;
}) {
  const form = useForm<PublicationFormValues>({
    resolver: zodResolver(publicationSchema),
    defaultValues: {
      id: publication.id,
      title: publication.title,
      publisher: publication.publisher,
      intro: publication.intro,
      region: publication.region,
      issues: publication.issues ?? "",
      external_url: publication.external_url ?? "",
      cover_image_key: publication.cover_image_key ?? "",
      is_published: publication.is_published,
      sort_order: publication.sort_order,
    },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="cover_image_key"
          render={({ field }) => (
            <FormItem>
              {/* 不包在 <FormControl>（Radix Slot）裡：ImageField 是複合元件，
                  不是 forwardRef 的原生元件，Slot 的 ref cloning 只會噴 warning。
                  與 _shell.exhibitions.tsx、_shell.pages.$slug.tsx 同一個寫法；
                  scripts/event-assembler-selftest.mjs 用 AST 掃整個 src/ 守著它。 */}
              <ImageField
                label="封面"
                value={field.value}
                onChange={(key) => field.onChange(key ?? "")}
                fallback={bookstoreImg}
                disabled={submitting}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <LocalizedField name="title" label="刊名" />
        <LocalizedField name="publisher" label="製作單位" />
        <LocalizedField name="intro" label="刊物介紹" multiline rows={6} />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="region"
            render={({ field }) => (
              <FormItem>
                <FormLabel>關注地域</FormLabel>
                <FormControl>
                  <Input placeholder="例如 基隆-八斗子" {...field} />
                </FormControl>
                <FormDescription>
                  原文照抄的自由文字。前台的地域篩選會把它歸到粗分類，改這裡就會換組。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="issues"
            render={({ field }) => (
              <FormItem>
                <FormLabel>集數</FormLabel>
                <FormControl>
                  <Input placeholder="例如 2016 秋、2017 秋" {...field} value={field.value ?? ""} />
                </FormControl>
                <FormDescription>留空代表原始資料沒有這一欄。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="external_url"
            render={({ field }) => (
              <FormItem className="sm:col-span-2">
                <FormLabel>刊物網址</FormLabel>
                <FormControl>
                  <Input placeholder="https://…" {...field} value={field.value ?? ""} />
                </FormControl>
                <FormDescription>留空則前台不顯示連結。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="sort_order"
            render={({ field }) => (
              <FormItem>
                <FormLabel>排序</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? 0}
                    onChange={(e) =>
                      field.onChange(e.target.value === "" ? 0 : Math.trunc(Number(e.target.value)))
                    }
                  />
                </FormControl>
                <FormDescription>數字小的排前面，同組內再照原始序號。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="is_published"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between rounded-md border border-border p-3">
                <div>
                  <FormLabel>在展覽頁顯示</FormLabel>
                  <FormDescription>關掉之後前台看不到這一本。</FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? "儲存中…" : "儲存"}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

function LinkForm({
  publication,
  suggested,
  candidates,
  onSubmit,
  submitting,
}: {
  publication: Publication;
  suggested: NameMatch[];
  candidates: Candidate[];
  onSubmit: (values: PublicationLinkFormValues) => void | Promise<void>;
  submitting: boolean;
}) {
  const form = useForm<PublicationLinkFormValues>({
    resolver: zodResolver(publicationLinkSchema),
    defaultValues: {
      publication_id: publication.id,
      inv_product_id: "",
      price: 0,
      units_per_sale: 1,
    },
  });

  // 同名的排最前面，其餘照原順序接在後面。刻意不把「其餘」藏起來 ——
  // 原始清單的刊名與進貨時打的品名常常差一個副標，同名比對找不到很正常。
  const suggestedIds = new Set(suggested.map((s) => s.inv_product_id));
  const rest = candidates.filter((c) => !suggestedIds.has(c.inv_product_id));

  function pick(id: string) {
    form.setValue("inv_product_id", id, { shouldDirty: true, shouldValidate: true });
    const hit =
      suggested.find((s) => s.inv_product_id === id) ??
      candidates.find((c) => c.inv_product_id === id);
    // 進銷存的 selling_price 是 numeric、型錄是整數元。四捨五入而不是捨去，
    // 與上架頁同一條規則（見 _shell.inventory-listing.tsx#applyCandidate）。
    if (hit && !form.getValues("price")) {
      form.setValue("price", Math.round(Number(hit.selling_price)), { shouldDirty: true });
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="inv_product_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>進銷存品項</FormLabel>
              <Select value={field.value || undefined} onValueChange={pick}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="選一個品項" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent className="max-h-72">
                  {suggested.map((s) => (
                    <SelectItem key={s.inv_product_id} value={s.inv_product_id}>
                      ★ {s.name}（庫存 {s.stock_quantity}／
                      {formatTWD(Math.round(Number(s.selling_price)))}）
                    </SelectItem>
                  ))}
                  {rest.map((c) => (
                    <SelectItem key={c.inv_product_id} value={c.inv_product_id}>
                      {c.name}（庫存 {c.stock_quantity}／
                      {formatTWD(Math.round(Number(c.selling_price)))}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>
                ★ 是與這本刊名相同的品項。只列出已核准、未停用、有庫存，而且還沒被別的
                商品佔用的品項。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="price"
            render={({ field }) => (
              <FormItem>
                <FormLabel>網站售價（元）</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    min={1}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ""}
                    onChange={(e) =>
                      field.onChange(e.target.value === "" ? 0 : Math.trunc(Number(e.target.value)))
                    }
                  />
                </FormControl>
                <FormDescription>
                  進銷存售價是 0 的品項要在這裡填真正的價格，不然不能賣。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="units_per_sale"
            render={({ field }) => (
              <FormItem>
                <FormLabel>每件出貨數</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="numeric"
                    step={1}
                    min={1}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? 1}
                    onChange={(e) =>
                      field.onChange(e.target.value === "" ? 1 : Math.trunc(Number(e.target.value)))
                    }
                  />
                </FormControl>
                <FormDescription>一般是 1。</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? "連結中…" : "連結並上架"}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

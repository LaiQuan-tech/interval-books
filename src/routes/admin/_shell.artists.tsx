import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
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
import { ImageField } from "@/components/admin/ImageField";
import { artistSchema, type ArtistFormValues } from "@/lib/admin/schemas";
import {
  countEventsBySpeaker,
  listArtists,
  removeArtist,
  upsertArtist,
} from "@/lib/admin/fns/artists";
import { eventReading } from "@/lib/images";
import { formatUpdatedAt } from "@/lib/admin/format";

type ArtistRow = Awaited<ReturnType<typeof listArtists>>[number];

/**
 * 講者後台（public.artists）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 為什麼是 Dialog，不是 /admin/artists + /admin/artists/$slug 兩支路由
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 這個 repo 的後台其實有兩種形狀，而挑哪一種是由**資料的形狀**決定的：
 *
 *   · 列表 + 詳情路由（_shell.pages.tsx + _shell.pages.$slug.tsx）—— 因為一個
 *     page 底下掛著 page_blocks 與 page_list_items 兩張子表，每一張都要能新增、
 *     刪除、排序。那是一整個編輯器，塞不進一個對話框，而且需要自己的網址才能
 *     重新整理不掉資料。
 *
 *   · 表格 + Dialog（_shell.exhibitions.tsx、_shell.collaborations.tsx）——
 *     因為那是一張平表，一列就是幾個純量欄位。
 *
 * artists 是後者：一張平表，沒有任何子表，可編輯的全部是純量欄位（其中最長的
 * long_bio 也只是一個 textarea）。所以照 _shell.exhibitions.tsx 的形狀做 ——
 * 它是最貼近的一支：同樣有 slug、有 image_key、有排序、有啟用開關。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 語言：這一頁**沒有** <LocalizedField>，而那是故意的
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * public.artists 的 bio / long_bio / discipline 在資料庫裡是 `text`，不是三語
 * jsonb（0019_vendors_pii_portal.sql:2146-2160）。整張表唯一的第二語言是 name 與
 * name_en，而那是兩個各自獨立的欄位，不是一個 {zh,en,ja} 物件。
 *
 * 所以這一頁用的是普通的 <Input> / <Textarea>，而且每一個單語欄位底下都寫著
 * 「此欄不分語言，三種語系都會顯示同一份內容」。那句話不是客套，是這一頁唯一
 * 會被人讀到的地方：型別擋得住程式碼寫錯，擋不住店家以為自己填的是中文版。
 *
 * ⚠️ 不要「為了跟其他頁一致」就把 bio 換成 <LocalizedField>。那個元件讀寫的是
 *    `bio.zh` 這種路徑，套在字串欄位上會把資料寫成 {zh: …} 存進一個 text 欄位。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ vendor_id：看得到，改不動
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 表格裡有一欄「廠商」，但它只顯示「已綁定／未綁定」，而且表單裡**沒有**這個
 * 欄位。artists.vendor_id 指到 inv.vendors —— 那張表有身分證字號與匯款帳號。
 * 「這位講者的介紹長怎樣」與「這家廠商的錢匯到哪」是兩個不同的授權決定。
 *
 * 這件事不是靠這一頁少放一個輸入框來保證的（那只是畫面）：artistSchema 沒有
 * vendor_id 這個 key，repo 的 upsert payload 也沒有。見
 * src/server/repos/artists.ts 的檔頭。
 */
export const Route = createFileRoute("/admin/_shell/artists")({
  loader: async () => {
    const [artists, eventCounts] = await Promise.all([listArtists(), countEventsBySpeaker()]);
    return { artists, eventCounts };
  },
  head: () => ({
    meta: [{ title: "講者｜小時光書店後台" }],
  }),
  component: AdminArtistsPage,
});

function toFormValues(row: ArtistRow): ArtistFormValues {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    name_en: row.name_en ?? "",
    discipline: row.discipline ?? "",
    bio: row.bio ?? "",
    long_bio: row.long_bio ?? "",
    image_key: row.image_key,
    portal_url: row.portal_url ?? "",
    sort_order: row.sort_order,
    is_active: row.is_active,
  };
}

function AdminArtistsPage() {
  const { artists, eventCounts } = Route.useLoaderData();
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ArtistRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ArtistRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(row: ArtistRow) {
    setEditing(row);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function handleSubmit(values: ArtistFormValues) {
    setSubmitting(true);
    try {
      await upsertArtist({ data: editing ? { ...values, id: editing.id } : values });
      toast.success(editing ? "已更新講者" : "已新增講者");
      setDialogOpen(false);
      await router.invalidate();
    } catch (err) {
      // 不吞掉：upsertArtist（src/server/repos/artists.ts）在 slug 撞唯一鍵時會丟
      // 一個指名那個代稱的訊息，那個訊息就是這裡要顯示的東西。
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await removeArtist({ data: { id: deleteTarget.id } });
      toast.success("已刪除講者");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  const nextSortOrder = artists.reduce((max, a) => Math.max(max, a.sort_order), 0) + 1;

  const defaultValues: ArtistFormValues = editing
    ? toFormValues(editing)
    : {
        slug: "",
        name: "",
        name_en: "",
        discipline: "",
        bio: "",
        long_bio: "",
        image_key: null,
        portal_url: "",
        sort_order: nextSortOrder,
        is_active: true,
      };

  const deleteTargetEventCount = deleteTarget ? (eventCounts[deleteTarget.id] ?? 0) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">講者</h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {artists.length} 位</p>
        </div>
        <Button onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          新增講者
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>姓名</TableHead>
              <TableHead>領域</TableHead>
              <TableHead className="w-24">活動</TableHead>
              <TableHead className="w-28">廠商</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="hidden w-36 lg:table-cell">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {artists.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增講者」開始。
                </TableCell>
              </TableRow>
            ) : (
              artists.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="text-muted-foreground">{a.sort_order}</TableCell>
                  <TableCell className="max-w-sm font-medium">
                    <span className="block truncate">{a.name}</span>
                    {a.name_en ? (
                      <span className="block truncate text-xs font-normal text-muted-foreground">
                        {a.name_en}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{a.discipline ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {eventCounts[a.id] ? `${eventCounts[a.id]} 場` : "—"}
                  </TableCell>
                  <TableCell>
                    {/* 唯讀。這裡刻意只說「有沒有綁」，不顯示是哪一家、更不能改 ——
                        inv.vendors 是會計面，見本檔檔頭。 */}
                    <Badge variant={a.vendor_id ? "outline" : "secondary"}>
                      {a.vendor_id ? "已綁定" : "未綁定"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={a.is_active ? "default" : "secondary"}>
                      {a.is_active ? "啟用中" : "已停用"}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                    {formatUpdatedAt(a.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(a)}>
                        編輯
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(a)}
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
            <DialogTitle>{editing ? "編輯講者" : "新增講者"}</DialogTitle>
            <DialogDescription>
              這一頁的欄位除了「姓名（英文）」之外**都不分語言**，中／英／日三種語系會顯示同一份內容。
            </DialogDescription>
          </DialogHeader>
          <ArtistForm
            key={formKey}
            defaultValues={defaultValues}
            vendorLinked={Boolean(editing?.vendor_id)}
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
            <AlertDialogTitle>確定要刪除這位講者嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.name}」刪除後無法復原。
              {deleteTargetEventCount > 0 ? (
                <>
                  {" "}
                  這位講者目前掛在 {deleteTargetEventCount} 場活動上——
                  <strong>那些活動不會被刪除</strong>
                  ，只會變成沒有指定講者，之後可以再掛上別人。
                </>
              ) : (
                " 目前沒有任何活動掛著這位講者。"
              )}
              {deleteTarget?.vendor_id ? (
                <>
                  {" "}
                  另外，這位講者有綁定的廠商資料；刪除只會影響這裡的介紹資料，進銷存那一側的廠商不受影響。
                </>
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

type ArtistFormProps = {
  defaultValues: ArtistFormValues;
  /** 唯讀顯示用。表單永遠不寫這個值，見本檔檔頭。 */
  vendorLinked: boolean;
  onSubmit: (values: ArtistFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

/** 每一個單語欄位底下都掛這一句，理由見本檔檔頭的「語言」那一段。 */
const SINGLE_LANGUAGE_NOTE = "此欄目前不分語言，中／英／日三種語系都會顯示同一份內容。";

function ArtistForm({
  defaultValues,
  vendorLinked,
  onSubmit,
  submitting,
  submitLabel,
}: ArtistFormProps) {
  const form = useForm<ArtistFormValues>({
    resolver: zodResolver(artistSchema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>網址代稱</FormLabel>
              <FormControl>
                <Input placeholder="例如 wang-xiaoming" {...field} />
              </FormControl>
              <FormDescription>建議使用半形英數字與連字號，且不能與其他講者重複。</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>姓名</FormLabel>
                <FormControl>
                  <Input placeholder="例如 王小明" {...field} />
                </FormControl>
                <FormDescription>
                  {SINGLE_LANGUAGE_NOTE}人名不會被自動翻譯，右邊的英文名要自己填。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="name_en"
            render={({ field }) => (
              <FormItem>
                <FormLabel>姓名（英文，選填）</FormLabel>
                <FormControl>
                  <Input
                    placeholder="例如 Wang Xiaoming"
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={field.value ?? ""}
                    onChange={field.onChange}
                  />
                </FormControl>
                <FormDescription>
                  這是整張表唯一有第二語言的欄位。留空就三種語系都顯示左邊的姓名。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="discipline"
          render={({ field }) => (
            <FormItem>
              <FormLabel>領域／頭銜（選填）</FormLabel>
              <FormControl>
                <Input
                  placeholder="例如 作家、攝影師、獨立書店店主"
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={field.value ?? ""}
                  onChange={field.onChange}
                />
              </FormControl>
              <FormDescription>{SINGLE_LANGUAGE_NOTE}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="bio"
          render={({ field }) => (
            <FormItem>
              <FormLabel>短介紹（選填）</FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  placeholder="一兩句話，列表與卡片上會用到"
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={field.value ?? ""}
                  onChange={field.onChange}
                />
              </FormControl>
              <FormDescription>{SINGLE_LANGUAGE_NOTE}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="long_bio"
          render={({ field }) => (
            <FormItem>
              <FormLabel>完整介紹（選填）</FormLabel>
              <FormControl>
                <Textarea
                  rows={8}
                  placeholder="活動頁「講者介紹」那一塊會顯示的完整經歷"
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={field.value ?? ""}
                  onChange={field.onChange}
                />
              </FormControl>
              <FormDescription>{SINGLE_LANGUAGE_NOTE}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="portal_url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>個人網站／社群連結（選填）</FormLabel>
              <FormControl>
                <Input
                  type="url"
                  placeholder="https://example.com"
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={field.value ?? ""}
                  onChange={field.onChange}
                />
              </FormControl>
              <FormDescription>留空代表沒有；有填的話必須是完整網址。</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="image_key"
          render={({ field }) => (
            <FormItem>
              <FormLabel>講者照片</FormLabel>
              {/* 不包在 <FormControl>（Radix Slot）裡：ImageField 是一個複合元件，
                  不是 Input/Switch 那種 forwardRef 原生元件，Slot 的 ref 複製只會
                  在 console 噴警告，沒有任何好處。同 _shell.exhibitions.tsx。 */}
              <ImageField
                value={field.value ?? null}
                onChange={field.onChange}
                fallback={eventReading}
              />
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
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

          <FormField
            control={form.control}
            name="is_active"
            render={({ field }) => (
              <FormItem>
                <FormLabel>啟用狀態</FormLabel>
                <div className="flex h-9 items-center gap-2">
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <span className="text-sm text-muted-foreground">
                    {field.value ? "啟用中" : "已停用"}
                  </span>
                </div>
                <FormDescription>
                  停用之後前台不再顯示，活動後台的「主講人」下拉也不再列出——但已經掛上的活動不受影響。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* 唯讀的一列。**沒有輸入框，也沒有註冊到表單裡** —— 見本檔檔頭。 */}
        <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5">
          <p className="text-sm font-medium">
            進銷存廠商綁定：
            <span className="font-normal text-muted-foreground">
              {vendorLinked ? "已綁定" : "未綁定"}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            唯讀。廠商資料裡有統編、身分證字號與匯款帳號，屬於進銷存那一側的授權範圍，不能從這一頁修改。要調整綁定請到「廠商」頁。
          </p>
        </div>

        <DialogFooter>
          <Button type="submit" disabled={submitting}>
            {submitting ? "儲存中…" : submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

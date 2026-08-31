import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { LocalizedField } from "@/components/admin/LocalizedField";
import { eventSchema, type EventFormValues } from "@/lib/admin/schemas";
import { countEventsByCategory, listEvents, removeEvent, upsertEvent } from "@/lib/admin/fns/events";
import { listEventCategories } from "@/lib/admin/fns/event-categories";
import { listArtistOptions } from "@/lib/admin/fns/artists";
import { formatUpdatedAt } from "@/lib/admin/format";

type EventRow = Awaited<ReturnType<typeof listEvents>>[number];
type EventCategoryRow = Awaited<ReturnType<typeof listEventCategories>>[number];
type ArtistOption = Awaited<ReturnType<typeof listArtistOptions>>[number];

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

/**
 * Radix 的 <SelectItem> 不接受 value=""（空字串是「沒有選任何東西」的內部狀態，
 * 拿來當選項值會讓 placeholder 與「已選不指定」變成同一件事）。所以「不指定
 * 主講人」用一個哨兵值，送進表單之前再換回 null。
 */
const NO_SPEAKER = "__none__";

const REGISTRATION_TYPE_LABEL: Record<EventFormValues["registration_type"], string> = {
  external: "外部連結報名",
  internal: "站內報名",
};

/**
 * Pathless-layout child route for /admin/events. Loads event_categories
 * alongside events (not just events) because the category field on the form
 * below is a dropdown sourced from the DB, never free text — typing an id
 * that doesn't exist in event_categories would fail events.category's FK
 * (supabase/migrations/0001_init.sql:182-183).
 *
 * public.artists 一起載入，理由完全一樣：「主講人」也是外鍵
 * （events.speaker_id -> artists.id，supabase/migrations/0025_event_speaker.sql），
 * 所以它是**下拉不是自由輸入**。自由輸入的話，同一位講者會以「王小明」「王 小明」
 * 「Wang Xiaoming」三種寫法散在不同活動上 —— 那就是講者資料永遠對不齊的起點，
 * 而且打錯一個字會直接吃 Postgres 23503。
 */
export const Route = createFileRoute("/admin/_shell/events")({
  loader: async () => {
    const [events, categories, artists] = await Promise.all([
      listEvents(),
      listEventCategories(),
      listArtistOptions(),
    ]);
    return { events, categories, artists };
  },
  head: () => ({
    meta: [{ title: "活動｜小時光書店後台" }],
  }),
  component: AdminEventsPage,
});

function toFormValues(row: EventRow): EventFormValues {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    description: row.description,
    display_date: row.display_date,
    iso_date: row.iso_date ?? "",
    category: row.category,
    speaker_id: row.speaker_id,
    external_url: row.external_url,
    registration_type: row.registration_type,
    payment_enabled: row.payment_enabled,
    is_published: row.is_published,
    sort_order: row.sort_order,
  };
}

function AdminEventsPage() {
  const { events, categories, artists } = Route.useLoaderData();
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<EventRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EventRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(row: EventRow) {
    setEditing(row);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function handleSubmit(values: EventFormValues) {
    setSubmitting(true);
    try {
      await upsertEvent({ data: editing ? { ...values, id: editing.id } : values });
      toast.success(editing ? "已更新活動" : "已新增活動");
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
      await removeEvent({ data: { id: deleteTarget.id } });
      toast.success("已刪除活動");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  const nextSortOrder = events.reduce((max, e) => Math.max(max, e.sort_order), 0) + 1;

  const defaultValues: EventFormValues = editing
    ? toFormValues(editing)
    : {
        title: { ...EMPTY_LOCALIZED },
        summary: { ...EMPTY_LOCALIZED },
        description: { ...EMPTY_LOCALIZED },
        display_date: "",
        iso_date: "",
        category: "",
        speaker_id: null,
        external_url: "",
        registration_type: "external",
        payment_enabled: false,
        is_published: true,
        sort_order: nextSortOrder,
      };

  function categoryLabel(id: string): string {
    return categories.find((c) => c.id === id)?.label.zh ?? id;
  }

  function speakerLabel(id: string | null): string {
    if (!id) return "—";
    return artists.find((a) => a.id === id)?.name ?? id;
  }

  /**
   * 下拉要列出來的講者：啟用中的，**加上**這一場目前掛著的那一位（就算他已經
   * 被停用）。
   *
   * 少了後面那半句就是一個無聲的資料流失：講者停用之後，去編輯任何一場已經掛著
   * 他的舊活動，下拉裡選不到目前這個值，隨手按個儲存就把講者洗成空的。
   */
  function optionsFor(current: string | null | undefined): ArtistOption[] {
    return artists.filter((a) => a.is_active || a.id === current);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">活動</h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {events.length} 場</p>
        </div>
        <Button onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          新增活動
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead>標題</TableHead>
              <TableHead>分類</TableHead>
              <TableHead>主講人</TableHead>
              <TableHead>顯示日期</TableHead>
              <TableHead>報名方式</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="hidden w-36 lg:table-cell">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增活動」開始。
                </TableCell>
              </TableRow>
            ) : (
              events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-muted-foreground">{e.sort_order}</TableCell>
                  <TableCell className="max-w-sm truncate font-medium">{e.title.zh}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{categoryLabel(e.category)}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {speakerLabel(e.speaker_id)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{e.display_date}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {REGISTRATION_TYPE_LABEL[e.registration_type]}
                    {e.payment_enabled ? "・需付款" : ""}
                  </TableCell>
                  <TableCell>
                    <Badge variant={e.is_published ? "default" : "secondary"}>
                      {e.is_published ? "已發布" : "草稿"}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-muted-foreground lg:table-cell">
                    {formatUpdatedAt(e.updated_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(e)}>
                        編輯
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteTarget(e)}
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
            <DialogTitle>{editing ? "編輯活動" : "新增活動"}</DialogTitle>
            <DialogDescription>
              中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。
            </DialogDescription>
          </DialogHeader>
          <EventForm
            key={formKey}
            defaultValues={defaultValues}
            categories={categories}
            artists={optionsFor(defaultValues.speaker_id)}
            onSubmit={handleSubmit}
            submitting={submitting}
            submitLabel={editing ? "儲存變更" : "新增"}
          />
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要刪除這場活動嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.title.zh}」刪除後無法復原。
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

type EventFormProps = {
  defaultValues: EventFormValues;
  categories: EventCategoryRow[];
  /** 已經篩過的講者選項（啟用中的＋這一場目前掛著的那一位），見 optionsFor()。 */
  artists: ArtistOption[];
  onSubmit: (values: EventFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

function EventForm({
  defaultValues,
  categories,
  artists,
  onSubmit,
  submitting,
  submitLabel,
}: EventFormProps) {
  const form = useForm<EventFormValues>({
    resolver: zodResolver(eventSchema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <LocalizedField name="title" label="標題" />
        <LocalizedField name="summary" label="摘要" multiline />
        <LocalizedField name="description" label="說明" multiline />

        <FormField
          control={form.control}
          name="category"
          render={({ field }) => (
            <FormItem>
              <FormLabel>分類</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="請選擇分類" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.label.zh}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {categories.length === 0 ? (
                <FormDescription className="text-destructive">
                  尚無分類，請先到「活動分類」頁新增至少一個分類。
                </FormDescription>
              ) : (
                <FormDescription>
                  選項來自「活動分類」頁——分類與活動之間有資料庫關聯，不能自由輸入。
                </FormDescription>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="speaker_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>主講人（選填）</FormLabel>
              <Select
                value={field.value ?? NO_SPEAKER}
                onValueChange={(v) => field.onChange(v === NO_SPEAKER ? null : v)}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="不指定" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={NO_SPEAKER}>不指定</SelectItem>
                  {artists.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {a.discipline ? `（${a.discipline}）` : ""}
                      {a.is_active ? "" : "・已停用"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {artists.length === 0 ? (
                <FormDescription>
                  尚無講者，請先到「講者」頁新增。這一欄可以留空，之後再回來補。
                </FormDescription>
              ) : (
                <FormDescription>
                  選項來自「講者」頁——講者與活動之間有資料庫關聯，不能自由輸入。留空代表這場不顯示講者介紹。
                </FormDescription>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="display_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>顯示用日期文字</FormLabel>
              <FormControl>
                <Input placeholder="例如 2026.05.24  Sat  19:30，或「即將公告」" {...field} />
              </FormControl>
              <FormDescription>自由文字，不會被當成日期解析，直接顯示在網站上。</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="iso_date"
          render={({ field }) => (
            <FormItem>
              <FormLabel>標準日期（選填）</FormLabel>
              <FormControl>
                <Input
                  type="date"
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value === "" ? null : e.target.value)}
                />
              </FormControl>
              <FormDescription>目前沒有任何頁面讀取這個欄位，保留給未來依日期排序、篩選使用。</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="external_url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>報名／活動網址</FormLabel>
              <FormControl>
                <Input type="url" placeholder="https://example.com/event" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="registration_type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>報名方式</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {(Object.keys(REGISTRATION_TYPE_LABEL) as EventFormValues["registration_type"][]).map((v) => (
                      <SelectItem key={v} value={v}>
                        {REGISTRATION_TYPE_LABEL[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="payment_enabled"
            render={({ field }) => (
              <FormItem>
                <FormLabel>需付款</FormLabel>
                <div className="flex h-9 items-center gap-2">
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <span className="text-sm text-muted-foreground">{field.value ? "是" : "否"}</span>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

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
                    onChange={(e) => field.onChange(e.target.value === "" ? 0 : Number(e.target.value))}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="is_published"
            render={({ field }) => (
              <FormItem>
                <FormLabel>發布狀態</FormLabel>
                <div className="flex h-9 items-center gap-2">
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <span className="text-sm text-muted-foreground">{field.value ? "已發布" : "草稿"}</span>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <DialogFooter>
          <Button type="submit" disabled={submitting || categories.length === 0}>
            {submitting ? "儲存中…" : submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </Form>
  );
}

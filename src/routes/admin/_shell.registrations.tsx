import { useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
import { eventSessionSchema, type EventSessionFormValues } from "@/lib/admin/schemas";
import {
  listBookableProducts,
  listEventSessions,
  removeEventSession,
  upsertEventSession,
} from "@/lib/admin/fns/event-sessions";
import {
  countRegistrationsBySession,
  listSessionRoster,
} from "@/lib/admin/fns/event-registrations";

type SessionRow = Awaited<ReturnType<typeof listEventSessions>>[number];
type ProductRow = Awaited<ReturnType<typeof listBookableProducts>>[number];
type RosterRow = Awaited<ReturnType<typeof listSessionRoster>>[number];

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

const STATUS_LABEL: Record<EventSessionFormValues["status"], string> = {
  open: "開放報名",
  closed: "未開放",
};

/**
 * /admin/registrations —— 活動場次與報名名單。
 *
 * 這一頁做兩件事，而它們是同一件事的兩面：**維護場次**（名額的唯一真相，
 * migration 0020 §1）與**看名單**（誰報名了）。分成兩頁的話，「這個梯次為什麼還有
 * 位子卻報不了名」就得在兩頁之間來回比對。
 *
 * ⚠️ 名單是**唯讀而且遮罩過的**。
 *    - 姓名是全名 —— 遮了現場點不了名，與 0019 讓廠商名稱明文、只遮識別碼是
 *      同一條線。
 *    - 電話與信箱只有遮罩值，而且遮罩是在 server 端做的
 *      （src/server/repos/event-registrations.ts）。這一頁拿不到明文，所以它也
 *      **不可能**不小心把明文印出來。
 *    - 沒有「顯示完整聯絡方式」與「匯出 CSV」。那兩條路都會產生明文，而明文出口
 *      必須先有 public.pii_access_log 的紀錄（0019 §1 的線）—— 那是 Phase 2 的
 *      0021 要做的事。**在那之前這裡不開任何明文出口。**
 *
 * 名額不在 /admin/products 上了：0020 把 products.capacity 綁成 null，所以那個
 * 欄位已經從商品表單移除，改由這裡按場次維護。
 */
export const Route = createFileRoute("/admin/_shell/registrations")({
  /**
   * ⚠️ 這一頁是整個 Phase 1 唯一**需要 0020 已經套用**才看得到東西的地方。
   *
   * 程式碼先上線、migration 後套用，中間那段時間 event_sessions 這張表還不存在，
   * 三支 loader 全部會炸掉 —— 而 repo 層的規矩是「錯誤一律 throw 不吞」，所以
   * 預設行為是整頁換成錯誤畫面，沒有任何一句話說明原因。
   *
   * 這裡把那個情況接起來，換成一句看得懂的說明。**只接這一種**：其餘的錯誤照樣
   * 往上丟（連線壞了、權限不對，那些不該被說成「還沒套 migration」）。
   *
   * 前台不需要這種處理：purchase 路徑的每一支查詢都有「購物車裡真的有活動才查」
   * 的前置判斷，全是書的購物車一次都不會碰到 event_sessions。
   */
  loader: async () => {
    try {
      const [sessions, products, counts] = await Promise.all([
        listEventSessions(),
        listBookableProducts(),
        countRegistrationsBySession(),
      ]);
      return { sessions, products, counts, schemaMissing: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // PostgREST 對「表不存在」回的是 PGRST205（schema cache 找不到），
      // 直連 Postgres 則是 42P01。兩個字串都認，因為這一段的重點是訊息本身。
      if (/PGRST205|42P01|does not exist|schema cache/i.test(message)) {
        return {
          sessions: [] as Awaited<ReturnType<typeof listEventSessions>>,
          products: [] as Awaited<ReturnType<typeof listBookableProducts>>,
          counts: {} as Awaited<ReturnType<typeof countRegistrationsBySession>>,
          schemaMissing: true,
        };
      }
      throw err;
    }
  },
  head: () => ({
    meta: [{ title: "活動報名｜小時光書店後台" }],
  }),
  component: AdminRegistrationsPage,
});

/**
 * timestamptz → `<input type="datetime-local">` 吃得下的字串。
 *
 * 用本地時間的欄位而不是 UTC：店員填的是「這場活動幾點開始」，那是牆上時鐘的
 * 時間。轉回 ISO 由 toIso() 負責，兩支必須成對修改。
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toIso(local: string): string {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function toFormValues(row: SessionRow): EventSessionFormValues {
  return {
    id: row.id,
    product_id: row.product_id,
    title: row.title,
    location: row.location,
    starts_at: toLocalInput(row.starts_at),
    ends_at: toLocalInput(row.ends_at),
    capacity: row.capacity,
    status: row.status,
    sort_order: row.sort_order,
  };
}

function AdminRegistrationsPage() {
  const { sessions, products, counts, schemaMissing } = Route.useLoaderData();
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<SessionRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [rosterOf, setRosterOf] = useState<SessionRow | null>(null);
  const [roster, setRoster] = useState<RosterRow[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(false);

  const productById = useMemo(
    () => new Map(products.map((p: ProductRow) => [p.id, p])),
    [products],
  );

  function productLabel(id: string): string {
    return productById.get(id)?.title.zh ?? id;
  }

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(row: SessionRow) {
    setEditing(row);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function openRoster(row: SessionRow) {
    setRosterOf(row);
    setRoster(null);
    setRosterLoading(true);
    try {
      setRoster(await listSessionRoster({ data: { sessionId: row.id } }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "名單讀取失敗");
      setRosterOf(null);
    } finally {
      setRosterLoading(false);
    }
  }

  async function handleSubmit(values: EventSessionFormValues) {
    setSubmitting(true);
    try {
      await upsertEventSession({
        data: {
          ...values,
          id: editing ? editing.id : undefined,
          starts_at: toIso(values.starts_at),
          ends_at: (values.ends_at ?? "").trim() ? toIso(values.ends_at!) : null,
        },
      });
      toast.success(editing ? "已更新場次" : "已新增場次");
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
      await removeEventSession({ data: { id: deleteTarget.id } });
      toast.success("已刪除場次");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      // 有人報名過的場次刪不掉（兩條 on delete restrict 外鍵）。原文往上丟，
      // 因為那句話正是店員需要知道的事。
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  const nextSortOrder = sessions.reduce((max, s) => Math.max(max, s.sort_order), 0) + 1;

  const defaultValues: EventSessionFormValues = editing
    ? toFormValues(editing)
    : {
        product_id: products[0]?.id ?? "",
        title: { ...EMPTY_LOCALIZED },
        location: { ...EMPTY_LOCALIZED },
        starts_at: "",
        ends_at: "",
        capacity: 20,
        // 新場次預設「未開放」，與 0020 回填的場次同一個立場：先建好、確認日期
        // 與名額之後再手動打開。fail-closed。
        status: "closed",
        sort_order: nextSortOrder,
      };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">活動報名</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            共 {sessions.length} 個場次。名額在這裡維護——商品頁不再有名額欄位。
          </p>
        </div>
        <Button onClick={openCreate} className="gap-1.5" disabled={products.length === 0}>
          <Plus className="h-4 w-4" />
          新增場次
        </Button>
      </div>

      {schemaMissing && (
        <p className="rounded-md border border-destructive/40 p-4 text-sm text-destructive">
          活動場次的資料表還沒建立。這一頁要等 migration
          0020_event_sessions_registrations.sql 套用到資料庫之後才會有內容——程式碼會
          先上線，資料庫是另一個步驟。
        </p>
      )}

      {!schemaMissing && products.length === 0 && (
        <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">
          目前沒有活動或策旅類型的商品。請先到「商品」新增一件 event／journey
          商品，才能為它建立場次。
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>活動商品</TableHead>
              <TableHead>場次</TableHead>
              <TableHead>時間</TableHead>
              <TableHead className="w-28">名額</TableHead>
              <TableHead className="w-32">報名</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="w-44 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  尚無場次。
                </TableCell>
              </TableRow>
            ) : (
              sessions.map((s) => {
                const count = counts[s.id] ?? { total: 0, paid: 0 };
                return (
                  <TableRow key={s.id}>
                    <TableCell className="max-w-xs truncate">{productLabel(s.product_id)}</TableCell>
                    <TableCell className="max-w-xs truncate font-medium">{s.title.zh}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatWhen(s.starts_at)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.seats_taken} / {s.capacity}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {count.paid} 已付款
                      {count.total !== count.paid ? `／${count.total} 筆` : ""}
                    </TableCell>
                    <TableCell>
                      <Badge variant={s.status === "open" ? "default" : "secondary"}>
                        {STATUS_LABEL[s.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" size="sm" onClick={() => void openRoster(s)}>
                          名單
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(s)}>
                          編輯
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleteTarget(s)}
                        >
                          刪除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "編輯場次" : "新增場次"}</DialogTitle>
            <DialogDescription>
              中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。名額只能調整
              上限，已報名人數由系統維護。
            </DialogDescription>
          </DialogHeader>
          <SessionForm
            key={formKey}
            defaultValues={defaultValues}
            products={products}
            seatsTaken={editing ? editing.seats_taken : null}
            onSubmit={handleSubmit}
            submitting={submitting}
            submitLabel={editing ? "儲存變更" : "新增"}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={rosterOf !== null} onOpenChange={(open) => !open && setRosterOf(null)}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{rosterOf ? rosterOf.title.zh : ""} 報名名單</DialogTitle>
            <DialogDescription>
              電話與信箱只顯示遮罩值。完整聯絡方式與 CSV 匯出尚未開放——那兩條路都
              會留下存取紀錄，等下一期一起做。
            </DialogDescription>
          </DialogHeader>
          {rosterLoading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">讀取中…</p>
          ) : (roster?.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">尚無報名。</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12">#</TableHead>
                    <TableHead>姓名</TableHead>
                    <TableHead>信箱</TableHead>
                    <TableHead>電話</TableHead>
                    <TableHead>訂單</TableHead>
                    <TableHead className="w-24">付款</TableHead>
                    <TableHead className="w-24">注意事項</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(roster ?? []).map((r, i) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="text-muted-foreground">{r.email_masked ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{r.phone_masked ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {r.order_no}
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.payment_status === "paid" ? "default" : "secondary"}>
                          {r.payment_status === "paid" ? "已付款" : r.payment_status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {r.notice_ack_at ? "已同意" : "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要刪除這個場次嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.title.zh}」刪除後無法復原。已經有人報名或下過單的場次
              會被資料庫擋下來，那時請先處理那些訂單。
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

type SessionFormProps = {
  defaultValues: EventSessionFormValues;
  products: ProductRow[];
  /** 編輯時的已報名人數；新增時是 null（還沒有東西可以顯示）。唯讀。 */
  seatsTaken: number | null;
  onSubmit: (values: EventSessionFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

function SessionForm({
  defaultValues,
  products,
  seatsTaken,
  onSubmit,
  submitting,
  submitLabel,
}: SessionFormProps) {
  const form = useForm<EventSessionFormValues>({
    resolver: zodResolver(eventSessionSchema),
    defaultValues,
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="product_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>活動商品</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="請選擇活動商品" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.title.zh}
                      {p.status === "active" ? "" : "（未上架）"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <LocalizedField name="title" label="場次名稱" />
        <LocalizedField name="location" label="地點" />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="starts_at"
            render={({ field }) => (
              <FormItem>
                <FormLabel>開始時間</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="ends_at"
            render={({ field }) => (
              <FormItem>
                <FormLabel>結束時間（選填）</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} value={field.value ?? ""} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="capacity"
            render={({ field }) => (
              <FormItem>
                <FormLabel>名額上限</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    min={0}
                    step={1}
                    value={field.value}
                    onChange={(e) => field.onChange(Number(e.target.value))}
                  />
                </FormControl>
                <FormDescription>
                  {seatsTaken != null
                    ? `目前已佔用 ${seatsTaken} 個位子。調降到低於這個數字會被資料庫擋下來。`
                    : "已報名人數由系統維護，不能在這裡填。"}
                </FormDescription>
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
                    <SelectItem value="closed">未開放</SelectItem>
                    <SelectItem value="open">開放報名</SelectItem>
                  </SelectContent>
                </Select>
                <FormDescription>
                  只有「開放報名」的場次會出現在前台，也只有它收得了報名。
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="sort_order"
          render={({ field }) => (
            <FormItem>
              <FormLabel>排序</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  step={1}
                  value={field.value}
                  onChange={(e) => field.onChange(Number(e.target.value))}
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

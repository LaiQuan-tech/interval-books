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
import { exhibitionSchema, type ExhibitionFormValues } from "@/lib/admin/schemas";
import { listExhibitions, removeExhibition, upsertExhibition } from "@/lib/admin/fns/exhibitions";
import { imageFor, exhibitionCorner } from "@/lib/images";
import { formatUpdatedAt } from "@/lib/admin/format";

type ExhibitionRow = Awaited<ReturnType<typeof listExhibitions>>[number];

const EMPTY_LOCALIZED = { zh: "", en: "", ja: "" };

export const Route = createFileRoute("/admin/_shell/exhibitions")({
  loader: async () => {
    const exhibitions = await listExhibitions();
    return { exhibitions };
  },
  head: () => ({
    meta: [{ title: "展覽｜小時光書店後台" }],
  }),
  component: AdminExhibitionsPage,
});

function toFormValues(row: ExhibitionRow): ExhibitionFormValues {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    description: row.description,
    period: row.period,
    location: row.location,
    image_key: row.image_key,
    is_published: row.is_published,
    sort_order: row.sort_order,
  };
}

function AdminExhibitionsPage() {
  const { exhibitions } = Route.useLoaderData();
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ExhibitionRow | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ExhibitionRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openCreate() {
    setEditing(null);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  function openEdit(row: ExhibitionRow) {
    setEditing(row);
    setFormKey((k) => k + 1);
    setDialogOpen(true);
  }

  async function handleSubmit(values: ExhibitionFormValues) {
    setSubmitting(true);
    try {
      await upsertExhibition({ data: editing ? { ...values, id: editing.id } : values });
      toast.success(editing ? "已更新展覽" : "已新增展覽");
      setDialogOpen(false);
      await router.invalidate();
    } catch (err) {
      // Not swallowed: upsertExhibition (src/server/repos/exhibitions.ts) throws a
      // specific message naming the slug on a 23505 unique-constraint conflict,
      // and that message is what ends up in this toast.
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await removeExhibition({ data: { id: deleteTarget.id } });
      toast.success("已刪除展覽");
      setDeleteTarget(null);
      await router.invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setDeleting(false);
    }
  }

  const nextSortOrder = exhibitions.reduce((max, e) => Math.max(max, e.sort_order), 0) + 1;

  const defaultValues: ExhibitionFormValues = editing
    ? toFormValues(editing)
    : {
        slug: "",
        title: { ...EMPTY_LOCALIZED },
        summary: { ...EMPTY_LOCALIZED },
        description: { ...EMPTY_LOCALIZED },
        period: "",
        location: { ...EMPTY_LOCALIZED },
        image_key: null,
        is_published: true,
        sort_order: nextSortOrder,
      };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">展覽</h1>
          <p className="mt-1 text-sm text-muted-foreground">共 {exhibitions.length} 檔</p>
        </div>
        <Button onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" />
          新增展覽
        </Button>
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">排序</TableHead>
              <TableHead className="w-16">圖片</TableHead>
              <TableHead>標題</TableHead>
              <TableHead>網址代稱</TableHead>
              <TableHead>展期</TableHead>
              <TableHead className="w-24">狀態</TableHead>
              <TableHead className="hidden w-36 lg:table-cell">最後更新</TableHead>
              <TableHead className="w-36 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {exhibitions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                  尚無資料，點右上角「新增展覽」開始。
                </TableCell>
              </TableRow>
            ) : (
              exhibitions.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-muted-foreground">{e.sort_order}</TableCell>
                  <TableCell>
                    <img
                      src={imageFor(e.image_key, exhibitionCorner)}
                      alt=""
                      className="h-10 w-14 rounded-sm border border-border object-cover"
                    />
                  </TableCell>
                  <TableCell className="max-w-sm truncate font-medium">{e.title.zh}</TableCell>
                  <TableCell className="text-muted-foreground">{e.slug}</TableCell>
                  <TableCell className="text-muted-foreground">{e.period}</TableCell>
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
            <DialogTitle>{editing ? "編輯展覽" : "新增展覽"}</DialogTitle>
            <DialogDescription>
              中文、英文、日文皆為必填——資料庫要求三語齊備才能儲存。
            </DialogDescription>
          </DialogHeader>
          <ExhibitionForm
            key={formKey}
            defaultValues={defaultValues}
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
            <AlertDialogTitle>確定要刪除這檔展覽嗎？</AlertDialogTitle>
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

type ExhibitionFormProps = {
  defaultValues: ExhibitionFormValues;
  onSubmit: (values: ExhibitionFormValues) => Promise<void>;
  submitting: boolean;
  submitLabel: string;
};

function ExhibitionForm({ defaultValues, onSubmit, submitting, submitLabel }: ExhibitionFormProps) {
  const form = useForm<ExhibitionFormValues>({
    resolver: zodResolver(exhibitionSchema),
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
                <Input placeholder="例如 soil-and-page" {...field} />
              </FormControl>
              <FormDescription>
                作為這檔展覽的網址代稱（首頁展覽區塊會用它產生錨點連結），建議使用半形英數字與連字號，且不能與其他展覽重複。
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <LocalizedField name="title" label="標題" />
        <LocalizedField name="summary" label="摘要" multiline />
        <LocalizedField name="description" label="說明" multiline />

        <FormField
          control={form.control}
          name="period"
          render={({ field }) => (
            <FormItem>
              <FormLabel>展期</FormLabel>
              <FormControl>
                <Input placeholder="例如 2025.04.20 – 2025.06.15" {...field} />
              </FormControl>
              <FormDescription>自由文字，不會被當成日期解析，直接顯示在網站上。</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <LocalizedField name="location" label="地點" />

        <FormField
          control={form.control}
          name="image_key"
          render={({ field }) => (
            <FormItem>
              <FormLabel>展覽圖片</FormLabel>
              {/* Not wrapped in <FormControl> (a Radix Slot): ImageField is a plain
                  composite component, not a forwardRef primitive like Input/Switch,
                  so Slot's ref-cloning would warn in the console for no benefit. */}
              <ImageField
                value={field.value ?? null}
                onChange={field.onChange}
                fallback={exhibitionCorner}
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
            name="is_published"
            render={({ field }) => (
              <FormItem>
                <FormLabel>發布狀態</FormLabel>
                <div className="flex h-9 items-center gap-2">
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <span className="text-sm text-muted-foreground">
                    {field.value ? "已發布" : "草稿"}
                  </span>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />
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

/**
 * 一種 event_blocks（0027）的編輯器。**三種 kind 共用這一支**，靠
 * src/lib/admin/event-block-copy.ts 的三組文案分辨 —— 理由寫在那個檔案的檔頭
 * （三種的資料形狀完全相同，差別只有欄位叫什麼與 body 要不要多行）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 這一支存在的第一個理由：**內層的 FormProvider**
 * ═══════════════════════════════════════════════════════════════════════════
 * 活動頁組裝器（src/routes/admin/_shell.events.$id.tsx）整頁被一個
 * `<Form {...form}>` 包著，那是主表單的 FormProvider。而 LocalizedField 是從
 * `useFormContext()` 拿 control / getValues / setValue 的 —— 它不收 control 當 prop。
 *
 * 所以區塊編輯器**如果不自己再開一層 FormProvider**，它裡面那兩個 LocalizedField
 * 會綁到**主表單**的 control 上，後果是：
 *
 *   · 在 agenda 的「時間」裡打字 → 那些字被寫進主表單的 values（一個 `title` 欄位，
 *     剛好與活動標題同名，於是活動標題被蓋掉）；
 *   · 按主儲存 → 那些字跟著固定欄位一起送去 admin_upsert_event_with_session()；
 *   · 按區塊自己的儲存 → 讀 blockForm 拿到空的，什麼都沒存到。
 *
 * 而且**全程沒有任何錯誤訊息** —— 兩個表單的欄位名剛好都叫 title/body，型別也對。
 *
 * 解法就是下面那一行 `<Form {...blockForm}>`：內層 provider 遮蔽外層，
 * useFormContext() 回的是離它最近的那一個。scripts/event-block-editor-selftest.mjs
 * 用真的 react-hook-form 跑一次「打字」證明這件事，並且用「把內層拿掉」當突變測試。
 *
 * ── HTML 的 <form> 不能巢狀，但這裡沒有巢狀 ──────────────────────────────
 * 主表單是一個**空的隱藏 <form id="event-content">**，儲存鈕靠 form= 屬性歸隊
 * （見組裝器的 CONTENT_FORM_ID）。所以下面這個 <form> 是它的**兄弟**，不是子孫。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 這一支存在的第二個理由：**排序只有一個家**
 * ═══════════════════════════════════════════════════════════════════════════
 * 上移／下移送出去的是**整組 id 的完整新順序**，收在一次
 * reorderEventBlocks()（→ public.admin_reorder_event_blocks()，一個交易）。
 * 這裡沒有「先把 A 改成 2、再把 B 改成 1」那種 client 驅動的多步驟重排 ——
 * event_blocks 有 unique(event_id, kind, sort_order)，那種寫法中途一定撞 23505，
 * 而且失敗會把列留在停車位上。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚠️ 這一支**不可以**因為 rows 變了就 reset 自己的表單
 * ═══════════════════════════════════════════════════════════════════════════
 * 主儲存之後組裝器會 router.invalidate()，於是 rows 這個 prop 會換一份新的。這一支
 * 的 useForm 必須**活過那一次**：使用者可能正在 §5 打一半的字，而他按的是 §1 的儲存。
 * 所以這裡沒有任何 `useEffect(… , [rows])` 去 reset，呼叫端也不准用會隨資料變動的
 * key 讓它 remount（那是組裝器檔頭「雷 1」的同一件事）。
 * blockForm 只在**它自己存成功**、或使用者按「取消」時被 reset。
 */
import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { FieldErrors } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
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
import { LocalizedField } from "@/components/admin/LocalizedField";
import { EVENT_BLOCK_COPY } from "@/lib/admin/event-block-copy";
import { eventBlockSchema } from "@/lib/admin/schemas";
import { collectErrorPaths, invalidToastMessage } from "@/lib/admin/form-errors";
import {
  removeEventBlock,
  reorderEventBlocks,
  upsertEventBlock,
} from "@/lib/admin/fns/event-blocks";
import type { EventBlockKind } from "@/lib/event-blocks";
import type { Localized } from "@/i18n/types";

/** 這一支只顯示／編輯的那幾欄。與 repo 的 EventBlockRow 對得上。 */
export type EventBlockItem = {
  id: number;
  kind: EventBlockKind;
  title: Localized;
  body: Localized;
  sort_order: number;
};

/**
 * 表單上只有使用者真的會打的兩欄。
 *
 * 🔴 `id` / `event_id` / `kind` **不在表單上**：它們是 props 與 state，不是輸入。
 *    把它們放進表單等於多開一條「使用者改得到」的路，而 kind 改掉會撞
 *    unique(event_id, kind, sort_order)。sort_order 更不在 —— 排序只有 RPC 那一個家。
 */
const blockFormSchema = eventBlockSchema.pick({ title: true, body: true });
type BlockFormShape = z.infer<typeof blockFormSchema>;

const EMPTY_BLOCK: BlockFormShape = {
  title: { zh: "", en: "", ja: "" },
  body: { zh: "", en: "", ja: "" },
};

type EventBlockEditorProps = {
  eventId: string;
  kind: EventBlockKind;
  /** 這一種 kind 的列，**已經照 sort_order 排好**。 */
  rows: EventBlockItem[];
  /**
   * 這一段髒不髒。要是**穩定**的 callback（呼叫端 useCallback），否則下面那個
   * effect 每次 render 都會重跑。
   */
  onDirtyChange: (dirty: boolean) => void;
  /** 存／刪／排序成功之後叫一次，讓呼叫端重新載入 rows。 */
  onChanged: () => Promise<void> | void;
  /** 活動還沒建立（/admin/events/new）—— 段落掛在 events.id 上，還沒有 id 可掛。 */
  disabledReason?: string | null;
};

export function EventBlockEditor({
  eventId,
  kind,
  rows,
  onDirtyChange,
  onChanged,
  disabledReason = null,
}: EventBlockEditorProps) {
  const copy = EVENT_BLOCK_COPY[kind];

  /* 🔴 就是這一個。它與組裝器的主表單是兩個獨立的 useForm，下面用 <Form {...blockForm}>
     把它蓋在主表單的 provider 上面。 */
  const blockForm = useForm<BlockFormShape>({
    resolver: zodResolver(blockFormSchema),
    defaultValues: EMPTY_BLOCK,
  });

  const [editingId, setEditingId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EventBlockItem | null>(null);

  /* 髒狀態往上報（組裝器的 dirty-sections 登記簿收）。編輯中的那一列也算 —— 使用者
     改了字卻沒按「儲存這一列」就離開，那些字一樣會消失。 */
  const isDirty = blockForm.formState.isDirty;
  useEffect(() => {
    onDirtyChange(isDirty);
  }, [isDirty, onDirtyChange]);

  // 元件被拿掉時把自己從登記簿上撤掉，否則 sticky bar 會一直說有一段沒存。
  useEffect(() => {
    return () => onDirtyChange(false);
  }, [onDirtyChange]);

  const startCreate = useCallback(() => {
    setEditingId(null);
    blockForm.reset(EMPTY_BLOCK);
  }, [blockForm]);

  const startEdit = useCallback(
    (row: EventBlockItem) => {
      setEditingId(row.id);
      // reset（不是 setValue 三次）：reset 會把 isDirty 一起歸零，於是「剛點開編輯」
      // 不會被算成一段沒存的變更。
      blockForm.reset({ title: { ...row.title }, body: { ...row.body } });
    },
    [blockForm],
  );

  async function handleValid(values: BlockFormShape) {
    setSubmitting(true);
    try {
      await upsertEventBlock({
        data: {
          id: editingId,
          event_id: eventId,
          kind,
          title: values.title,
          body: values.body,
        },
      });
      toast.success(editingId == null ? "已新增一列" : "已更新這一列");
      // 存完回到「新增」狀態：表單清空、isDirty 歸零。這不是 remount，rows 那一側
      // 的資料由 onChanged() 重新載入。
      setEditingId(null);
      blockForm.reset(EMPTY_BLOCK);
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "儲存失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * 🔴 與組裝器的主表單同一條規則（那邊的「雷 3」）：handleSubmit 一定要有第二個參數。
   * 少了它，驗證失敗時按下去會**什麼都不發生** —— 而這一段的紅字可能在摺疊起來的
   * 英日文欄位裡，畫面上一點線索都沒有。
   */
  function handleInvalid(errors: FieldErrors<BlockFormShape>) {
    toast.error(
      invalidToastMessage(collectErrorPaths(errors), {
        title: copy.titleLabel,
        body: copy.bodyLabel,
      }),
    );
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    try {
      await removeEventBlock({ data: { id: deleteTarget.id } });
      // 正在編輯的就是被刪掉的那一列 → 回到新增狀態，否則下一次送出會去 update
      // 一個已經不存在的 id。
      if (editingId === deleteTarget.id) {
        setEditingId(null);
        blockForm.reset(EMPTY_BLOCK);
      }
      setDeleteTarget(null);
      toast.success("已刪除這一列");
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刪除失敗，請稍後再試");
    } finally {
      setBusyId(null);
    }
  }

  /**
   * 上移／下移。
   *
   * 🔴 送出去的是**整組的完整 id 順序**，一次 RPC。這裡刻意沒有「只更新被交換的那
   *    兩列」那條捷徑：event_blocks 有 unique(event_id, kind, sort_order)，兩列互換
   *    無論先寫哪一列都會撞 23505；而繞過它的唯一辦法（先停到負數再寫）必須在同一個
   *    交易裡，也就是必須在 SQL 那一側 —— public.admin_reorder_event_blocks()（0027）。
   */
  async function handleMove(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= rows.length) return;

    const next = [...rows];
    const moved = next[index];
    next[index] = next[target];
    next[target] = moved;

    setBusyId(moved.id);
    try {
      await reorderEventBlocks({
        data: { event_id: eventId, kind, ids: next.map((r) => r.id) },
      });
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "排序失敗，請稍後再試");
    } finally {
      setBusyId(null);
    }
  }

  if (disabledReason) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        {disabledReason}
      </p>
    );
  }

  const editing = editingId == null ? null : (rows.find((r) => r.id === editingId) ?? null);

  return (
    <div className="space-y-4">
      {copy.hint ? <p className="text-sm text-muted-foreground">{copy.hint}</p> : null}

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          {copy.emptyText}
        </p>
      ) : (
        <ol className="space-y-2">
          {/* key 就是 row.id —— 不可以摻進 updated_at 之類會隨儲存改變的東西，那等於
              每次存完都 remount 一次這一列。 */}
          {rows.map((row, index) => (
            <li
              key={row.id}
              className={`flex items-start gap-3 rounded-md border p-3 ${
                editingId === row.id ? "border-primary bg-primary/5" : "border-border"
              }`}
            >
              <div className="flex shrink-0 flex-col">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  aria-label="上移"
                  disabled={index === 0 || busyId !== null}
                  onClick={() => handleMove(index, -1)}
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  aria-label="下移"
                  disabled={index === rows.length - 1 || busyId !== null}
                  onClick={() => handleMove(index, 1)}
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{row.title.zh || "（未填中文）"}</p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">
                  {row.body.zh || "（未填中文）"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="編輯"
                  disabled={busyId !== null}
                  onClick={() => startEdit(row)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-destructive"
                  aria-label="刪除"
                  disabled={busyId !== null}
                  onClick={() => setDeleteTarget(row)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          🔴 內層的 FormProvider。見檔頭 —— 少了這一層，下面兩個 LocalizedField
             會綁到組裝器主表單的 control 上，打進去的字會變成活動的欄位值。
          ══════════════════════════════════════════════════════════════════ */}
      <Form {...blockForm}>
        <form
          id={`event-block-${kind}`}
          onSubmit={blockForm.handleSubmit(handleValid, handleInvalid)}
          className="space-y-3 rounded-md border border-border bg-muted/20 p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">
              {editing
                ? `編輯第 ${rows.findIndex((r) => r.id === editing.id) + 1} 列`
                : copy.addTitle}
            </h3>
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-auto gap-1.5 px-2 py-1 text-xs"
                onClick={startCreate}
              >
                <X className="h-3.5 w-3.5" />
                取消編輯
              </Button>
            ) : null}
          </div>

          <LocalizedField name="title" label={copy.titleLabel} />
          <LocalizedField
            name="body"
            label={copy.bodyLabel}
            multiline={copy.bodyMultiline}
            rows={copy.bodyMultiline ? 3 : 2}
          />

          <div className="flex justify-end">
            <Button type="submit" size="sm" className="gap-1.5" disabled={submitting}>
              {editing ? null : <Plus className="h-4 w-4" />}
              {submitting ? "儲存中…" : editing ? "儲存這一列" : "新增這一列"}
            </Button>
          </div>
        </form>
      </Form>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>要刪除這一列嗎？</AlertDialogTitle>
            <AlertDialogDescription>
              「{deleteTarget?.title.zh || "（未填中文）"}
              」會被刪掉，剩下的列會自動補號。這個動作沒有復原。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              刪除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

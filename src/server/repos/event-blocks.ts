/**
 * Data layer for public.event_blocks（0027）—— 一場活動的可重複段落。
 *
 * 檔案切法沿用 events 家族既有的一表一檔（event-sessions.ts / event-registrations.ts /
 * event-categories.ts），不是塞進 events.ts：那一支已經同時管 events 與 products 的
 * 投影規則了。
 *
 * 每一個 Supabase 錯誤都往上丟，不吞 —— 理由見 src/server/repos/news.ts 的檔頭
 * （後台在 DB 出錯時安靜地回空陣列，跟「這場活動真的沒有段落」在畫面上長得一模一樣）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 排序只有一個家：public.admin_reorder_event_blocks()
 * ═══════════════════════════════════════════════════════════════════════════
 * event_blocks 有 unique (event_id, kind, sort_order)。**一列一列改成最終位置，中途
 * 一定會撞上那個約束**（交換兩列時無論先改哪一列都是 23505）。0027 那支 RPC 的做法是
 * 先把要動的列停到負數、再寫最終值，而 plpgsql 的函式本體是一個交易，所以那些負數
 * 對別人從來不存在。
 *
 * ⚠️ **這個檔案裡沒有任何一行 UPDATE sort_order 在既有的列上**，而且不准有。
 *    client 驅動的多步驟重排（讀 → 停 → 寫 → 再讀）的第 3 步失敗時，資料會**留在
 *    停車位**上：使用者看到一個錯誤訊息，然後整份清單的順序變成負數亂序，沒有任何
 *    東西會把它救回來。sort_order 只在**新增**時被寫（append 到 max+1），那不是重排。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { EventBlockKind } from "@/lib/event-blocks";
import type { Localized } from "@/i18n/types";

const COLUMNS = "id, event_id, kind, title, body, sort_order, created_at, updated_at";

export type EventBlockRow = {
  /** bigint generated always as identity（0027）—— 重排不會換掉它。 */
  id: number;
  event_id: string;
  kind: EventBlockKind;
  /** faq 的問題／info_row 的標籤／agenda 的時間。not null。 */
  title: Localized;
  /** faq 的答案／info_row 的值／agenda 的內容。not null。 */
  body: Localized;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/**
 * 新增或更新一列。
 *
 * ⚠️ **更新分支不碰 sort_order。** 排序只走下面的 reorderEventBlocks()（見檔頭）。
 *    新增分支才寫 sort_order，而且是 append 到「這一組現有的最大值 + 1」——
 *    那是在一個空位上 INSERT，不是重排。
 */
export type EventBlockUpsertInput = {
  id?: number | null;
  event_id: string;
  kind: EventBlockKind;
  title: Localized;
  body: Localized;
};

/**
 * 這場活動的所有段落，三種 kind 一起回，依 (kind, sort_order) 排。
 *
 * 一場活動的段落是個位數到十幾列，三種各查一次是三個來回卻換不到任何東西，所以
 * 一次撈完、由呼叫端自己分組。
 */
export async function listEventBlocks(eventId: string): Promise<EventBlockRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("event_blocks")
    .select(COLUMNS)
    .eq("event_id", eventId)
    .order("kind", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/event-blocks] listEventBlocks 失敗：${error.message}`);
  return (data ?? []) as unknown as EventBlockRow[];
}

/**
 * 這一組（event_id + kind）現在最大的 sort_order。沒有列就回 0，所以新的一列是 1。
 *
 * 用 order+limit(1) 而不是把整組撈回來自己 max()：這一支唯一的用途是決定 append 的
 * 位置，撈回一堆用不到的 title/body 只是多花頻寬。
 */
async function maxSortOrder(eventId: string, kind: EventBlockKind): Promise<number> {
  const { data, error } = await supabaseAdmin()
    .from("event_blocks")
    .select("sort_order")
    .eq("event_id", eventId)
    .eq("kind", kind)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(`[repo/event-blocks] maxSortOrder 失敗：${error.message}`);
  return (data as { sort_order: number } | null)?.sort_order ?? 0;
}

export async function upsertEventBlock(input: EventBlockUpsertInput): Promise<EventBlockRow> {
  if (input.id != null) {
    // 🔴 更新分支**刻意不含 sort_order**，也不含 event_id / kind：換一列屬於哪一場
    //    活動、換它是哪一種段落，都不是「編輯」而是「搬家」，而搬家會撞上
    //    unique(event_id, kind, sort_order)。要換就刪掉重加。
    const { data, error } = await supabaseAdmin()
      .from("event_blocks")
      .update({ title: input.title, body: input.body })
      .eq("id", input.id)
      .select(COLUMNS)
      .single();

    if (error) throw new Error(`[repo/event-blocks] updateEventBlock 失敗：${error.message}`);
    return data as unknown as EventBlockRow;
  }

  const { data, error } = await supabaseAdmin()
    .from("event_blocks")
    .insert({
      event_id: input.event_id,
      kind: input.kind,
      title: input.title,
      body: input.body,
      sort_order: (await maxSortOrder(input.event_id, input.kind)) + 1,
    })
    .select(COLUMNS)
    .single();

  if (error) throw new Error(`[repo/event-blocks] insertEventBlock 失敗：${error.message}`);
  return data as unknown as EventBlockRow;
}

/**
 * 刪掉一列，然後把**同一組剩下的列重新編號成 1…n**，讓 sort_order 不留洞。
 *
 * 重新編號那一步走的是 admin_reorder_event_blocks()（一個交易），不是逐列 UPDATE ——
 * 也就是說這裡仍然沒有 client 驅動的多步驟重排。
 *
 * ⚠️ 誠實說清楚這一支的原子性：DELETE 與重新編號是**兩個語句**，而這一期不准新增
 *    migration，所以包不進同一個交易。中間斷掉的後果是 sort_order 留一個洞
 *    （例如 1,3），**不是**留在負數停車位上：
 *      · 洞是無害的 —— 前台與後台都 `order by sort_order`，1,3 與 1,2 畫出來一模一樣，
 *        下一次刪除或重排就會把它補平。
 *      · 停車位才是壞掉的 —— 負數會讓整份清單倒過來，而且沒有東西會修它。
 *    這個差別正是排序不准搬到 client 的理由；把它寫在這裡，是為了讓下一個想「順手
 *    把重新編號也拆成幾個 UPDATE」的人先讀到。
 */
export async function removeEventBlock(id: number): Promise<void> {
  // 一個來回同時做到「刪掉」與「知道它屬於哪一組」。先查再刪會多一個來回，而且
  // 中間那一瞬間別人可能已經刪了它。
  const { data, error } = await supabaseAdmin()
    .from("event_blocks")
    .delete()
    .eq("id", id)
    .select("event_id, kind")
    .maybeSingle();

  if (error) throw new Error(`[repo/event-blocks] removeEventBlock 失敗：${error.message}`);
  // 已經被刪掉了 —— 這不是錯誤（後台兩個分頁各按一次刪除就會這樣），沒有東西要補號。
  if (!data) return;

  const { event_id, kind } = data as { event_id: string; kind: EventBlockKind };
  const remaining = await listEventBlocks(event_id);
  const ids = remaining.filter((b) => b.kind === kind).map((b) => b.id);
  if (ids.length === 0) return;

  await reorderEventBlocks(event_id, kind, ids);
}

/**
 * 把一組（event_id + kind）重排成 `ids` 的順序，**陣列位置就是新的 sort_order（1-based）**。
 *
 * `ids` 要是那一組的**完整**清單，不是「被移動的那兩列」——RPC 只會寫它收到的那幾個
 * id，漏掉的列會留在舊位置上，於是那一組同時存在新舊兩種編號。
 *
 * 🔴 這是這個 repo 裡**唯一**會改到既有列 sort_order 的地方，而它只是一次 rpc()。
 */
export async function reorderEventBlocks(
  eventId: string,
  kind: EventBlockKind,
  ids: number[],
): Promise<void> {
  const { error } = await supabaseAdmin().rpc("admin_reorder_event_blocks", {
    p_event_id: eventId,
    p_kind: kind,
    p_ids: ids,
  });

  if (error) throw new Error(`[repo/event-blocks] reorderEventBlocks 失敗：${error.message}`);
}

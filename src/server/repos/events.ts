/**
 * Data layer for public.events — used exclusively by admin server functions.
 *
 * Mirrors src/server/repos/news.ts: every Supabase error is thrown, never
 * swallowed. A back office that silently returns null/empty on a permission
 * or connection error looks indistinguishable from "there is no data", and an
 * admin could believe a write succeeded when it never reached the database.
 * Callers (src/lib/admin/fns/events.ts) run behind adminFnMiddleware, which
 * already turns thrown errors into a rejected server-fn call the UI can show.
 *
 * Rows are returned exactly as Supabase returns them — snake_case columns,
 * no camelCase renaming — so what you see here matches
 * supabase/migrations/0001_init.sql:172-205 column-for-column, plus
 * `speaker_id`（0025）與 `slug` / `image_key`（0026）。
 *
 * ⚠️ **部署順序：0026 要先套上 live DB，才能推這個檔。** 下面的 COLUMNS 會 select
 *    slug 與 image_key；欄位還不存在時 PostgREST 回 42703，整個活動後台打不開。
 *    這個 repo 為了同一件事已經掛過一次（0025 的 speaker_id），那一次留下的降級
 *    程式碼在 0026 這一期連同它的護欄斷言一起刪掉了 —— 降級路徑會讓「migration
 *    沒套上」這件事變成一個安靜的次等狀態，而安靜正是上一次沒有人發現的原因。
 */
import "@tanstack/react-start/server-only";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const COLUMNS =
  "id, slug, title, summary, description, display_date, iso_date, category, speaker_id, image_key, external_url, registration_type, payment_enabled, is_published, sort_order, created_at, updated_at";

/** products 的欄位，只取活動後台要顯示的那幾個。 */
const PRODUCT_COLUMNS = "id, slug, source_id, price, compare_at_price, status, sort_order";

export type EventRegistrationType = "external" | "internal";

export type EventRow = {
  id: string;
  /**
   * 網址代稱，/events/<slug>（supabase/migrations/0026_event_product_link.sql）。
   *
   * ⚠️ 0026 把它回填成 `id`，所以在那之前發出去的每一個網址仍然有效。**改這一欄
   *    會讓已經發出去的連結 404** —— /events/$slug 對「查無此活動」是真的回 404。
   */
  slug: string;
  title: Localized;
  summary: Localized;
  description: Localized;
  display_date: string;
  /** Nullable in the DB and never populated by the original content (see
   * supabase/migrations/0001_init.sql:198) — phase-2 sorting field. */
  iso_date: string | null;
  /** FK -> event_categories.id, `on delete restrict` (see
   * supabase/migrations/0001_init.sql:182-183). */
  category: string;
  /**
   * 主講人。FK -> public.artists(id)，`on delete set null`（見
   * supabase/migrations/0025_event_speaker.sql）。NULL 代表這場沒有指定講者。
   *
   * ⚠️ 刪掉一位講者**不會**刪掉活動 —— 那個外鍵刻意不是 cascade。活動底下還掛著
   *    報名紀錄（0020）與訂單（0005），cascade 會把它們一起帶走。
   */
  speaker_id: string | null;
  /** 封面圖 key（0026）。NULL = 沒設，前台就不畫封面。會投影到 products.image_key。 */
  image_key: string | null;
  external_url: string;
  registration_type: EventRegistrationType;
  payment_enabled: boolean;
  is_published: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** Shape accepted by upsertEvent. `id` omitted (or empty) means "create". */
export type EventUpsertInput = {
  id?: string;
  /** 省略／null 時用 id 當 slug —— 與 0026 的回填規則同一條。 */
  slug?: string | null;
  title: Localized;
  summary: Localized;
  description: Localized;
  display_date: string;
  iso_date?: string | null;
  category: string;
  speaker_id?: string | null;
  image_key?: string | null;
  external_url: string;
  registration_type: EventRegistrationType;
  payment_enabled: boolean;
  is_published: boolean;
  sort_order: number;
};

export type ProductStatus = "draft" | "active" | "archived";

/** 一場活動對應到的那件商品，外加它有幾個場次。 */
export type EventProductRow = {
  id: string;
  slug: string;
  source_id: string;
  price: number;
  compare_at_price: number | null;
  status: ProductStatus;
  sort_order: number;
  /** public.event_sessions 掛在 products.id 上（0020），不是掛在 events.id 上。 */
  session_count: number;
};

/** 上架／改價時要送給 admin_upsert_event_with_session() 的那一段。 */
export type EventProductInput = {
  price: number;
  compare_at_price?: number | null;
  status: ProductStatus;
  sort_order?: number;
};

export async function listEvents(): Promise<EventRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("events")
    .select(COLUMNS)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/events] list 失敗：${error.message}`);
  return (data ?? []) as unknown as EventRow[];
}

export async function getEventById(id: string): Promise<EventRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("events")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/events] getById 失敗：${error.message}`);
  return (data as unknown as EventRow) ?? null;
}

/**
 * Creates or updates a row. `id` present -> update that row; `id` absent ->
 * insert a new row with a generated id. events.id has no DB default (it is a
 * plain `text primary key`, not an identity column — see
 * supabase/migrations/0001_init.sql:175-176, same shape as news.id), so id
 * generation has to happen here rather than being left to Postgres.
 *
 * ⚠️ 這一支只寫 public.events，**不碰商品**。要同時上架，走
 *    upsertEventWithProduct() —— 那一條路是一個交易，而且投影規則
 *    （products.description ← events.summary）只住在 SQL 那一支函式裡。
 */
export async function upsertEvent(input: EventUpsertInput): Promise<EventRow> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();
  const isoDate = input.iso_date && input.iso_date.trim() ? input.iso_date.trim() : null;
  // slug 省略時回落到 id：與 0026 的回填規則同一條，所以新增的活動網址一開始就是
  // 它的 id，跟既有那六場長得一樣。
  const slug = input.slug && input.slug.trim() ? input.slug.trim() : id;

  const { data, error } = await supabaseAdmin()
    .from("events")
    .upsert(
      {
        id,
        slug,
        title: input.title,
        summary: input.summary,
        description: input.description,
        display_date: input.display_date,
        iso_date: isoDate,
        category: input.category,
        // 空字串（下拉選了「不指定」）與 undefined 一律寫回 NULL —— 空字串不是
        // 合法的 artists.id，送出去只會吃 23503。
        speaker_id: input.speaker_id && input.speaker_id.trim() ? input.speaker_id.trim() : null,
        image_key: input.image_key && input.image_key.trim() ? input.image_key.trim() : null,
        external_url: input.external_url,
        registration_type: input.registration_type,
        payment_enabled: input.payment_enabled,
        is_published: input.is_published,
        sort_order: input.sort_order,
      },
      { onConflict: "id" },
    )
    .select(COLUMNS)
    .single();

  if (error) throw new Error(`[repo/events] upsert 失敗：${error.message}`);
  return data as unknown as EventRow;
}

/**
 * 建立／更新活動**並且**建立／更新它的商品，一個交易。
 *
 * 走 supabase/migrations/0026_event_product_link.sql 的
 * `admin_upsert_event_with_session(payload jsonb)`，而不是在這裡先寫 events 再寫
 * products。兩個理由：
 *
 *   1. **兩個 PostgREST 請求不是一個交易。** 第一個成功、第二個失敗，留下的是一場
 *      改好了但商品還是舊價格的活動，而畫面上會顯示「已儲存」。
 *   2. **投影規則只能有一個家。** products.description 取的是 events.summary（不是
 *      events.description），products.slug 是 `event-<events.slug>`。這兩條寫在 SQL
 *      函式裡，這裡就不會有第二份會分岔的抄本。
 *
 * payload 刻意是一個 jsonb 而不是二十個具名參數：`create or replace function` 不能
 * 改參數名或型別，加一個欄位就會留下兩支同名 overload 讓 PostgREST 挑錯。理由的
 * 完整版在 0026 的檔頭。
 */
export async function upsertEventWithProduct(
  input: EventUpsertInput,
  product: EventProductInput | null,
): Promise<{ event: EventRow; product: EventProductRow | null }> {
  const id = input.id && input.id.trim() ? input.id : randomUUID();

  const payload = {
    event: {
      id,
      slug: input.slug && input.slug.trim() ? input.slug.trim() : id,
      title: input.title,
      summary: input.summary,
      description: input.description,
      display_date: input.display_date,
      iso_date: input.iso_date && input.iso_date.trim() ? input.iso_date.trim() : null,
      category: input.category,
      speaker_id: input.speaker_id && input.speaker_id.trim() ? input.speaker_id.trim() : null,
      image_key: input.image_key && input.image_key.trim() ? input.image_key.trim() : null,
      external_url: input.external_url,
      registration_type: input.registration_type,
      payment_enabled: input.payment_enabled,
      is_published: input.is_published,
      sort_order: input.sort_order,
    },
    product: product
      ? {
          price: product.price,
          compare_at_price: product.compare_at_price ?? null,
          status: product.status,
          sort_order: product.sort_order ?? input.sort_order,
        }
      : null,
  };

  const { data, error } = await supabaseAdmin().rpc("admin_upsert_event_with_session", {
    payload,
  });

  if (error) throw new Error(`[repo/events] upsertEventWithProduct 失敗：${error.message}`);

  const result = (data ?? {}) as {
    event?: EventRow;
    product?: Omit<EventProductRow, "session_count"> | null;
    session_count?: number;
  };
  if (!result.event) {
    throw new Error("[repo/events] upsertEventWithProduct 失敗：RPC 沒有回傳 event");
  }

  return {
    event: result.event,
    product: result.product
      ? { ...result.product, session_count: result.session_count ?? 0 }
      : null,
  };
}

/**
 * 這場活動有幾個場次。
 *
 * ⚠️ 場次（public.event_sessions，0020）掛的是 **products.id**，不是 events.id。
 *    所以這裡是兩跳：先用 (source_type='event', source_id) 找到那件商品，再數它的
 *    場次。沒有商品就是 0 個場次 —— 不是錯誤，是「這場活動還沒上架」。
 *
 * maybeSingle() 在 0026 之後才是安全的：products 對活動來源有了唯一索引
 * （products_event_source_unique_idx），一場活動最多一件商品是資料庫層級的事實。
 * 在那之前這一行有可能吃 PGRST116。
 */
export async function countSessionsForEvent(eventId: string): Promise<number> {
  const { data: product, error: productError } = await supabaseAdmin()
    .from("products")
    .select("id")
    .eq("source_type", "event")
    .eq("source_id", eventId)
    .maybeSingle();

  if (productError) {
    throw new Error(`[repo/events] countSessionsForEvent 找商品失敗：${productError.message}`);
  }
  if (!product) return 0;

  const { count, error } = await supabaseAdmin()
    .from("event_sessions")
    .select("id", { count: "exact", head: true })
    .eq("product_id", (product as { id: string }).id);

  if (error) throw new Error(`[repo/events] countSessionsForEvent 失敗：${error.message}`);
  return count ?? 0;
}

/**
 * 每一場活動對應到的那件商品，keyed by events.id。
 *
 * 活動列表那一欄要顯示「已上架／草稿／未上架」與場次數，一場一場問就是 N+1。
 * 這裡固定兩個查詢：一次撈完所有 source_type='event' 的商品，再一次撈完那些商品的
 * 場次然後在 JS 裡數。活動總數是個位數，這樣就夠了。
 */
export async function listEventProducts(): Promise<Record<string, EventProductRow>> {
  const { data, error } = await supabaseAdmin()
    .from("products")
    .select(PRODUCT_COLUMNS)
    .eq("source_type", "event");

  if (error) throw new Error(`[repo/events] listEventProducts 失敗：${error.message}`);

  const rows = (data ?? []) as unknown as Omit<EventProductRow, "session_count">[];
  const byEventId: Record<string, EventProductRow> = {};
  for (const row of rows) {
    if (!row.source_id) continue;
    byEventId[row.source_id] = { ...row, session_count: 0 };
  }

  const productIds = rows.map((r) => r.id);
  if (productIds.length === 0) return byEventId;

  const { data: sessions, error: sessionError } = await supabaseAdmin()
    .from("event_sessions")
    .select("product_id")
    .in("product_id", productIds);

  if (sessionError) {
    throw new Error(`[repo/events] listEventProducts 數場次失敗：${sessionError.message}`);
  }

  const counts: Record<string, number> = {};
  for (const s of (sessions ?? []) as { product_id: string }[]) {
    counts[s.product_id] = (counts[s.product_id] ?? 0) + 1;
  }
  for (const key of Object.keys(byEventId)) {
    byEventId[key].session_count = counts[byEventId[key].id] ?? 0;
  }
  return byEventId;
}

export async function removeEvent(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("events").delete().eq("id", id);
  if (error) throw new Error(`[repo/events] remove 失敗：${error.message}`);
}

/**
 * Returns how many events currently reference each category id (all events,
 * published or not — the DB's `on delete restrict` FK does not care about
 * is_published). Used by the event-categories admin page to disable "刪除"
 * up front on any category still in use, instead of letting an admin hit a
 * raw Postgres 23503 foreign-key-violation error after the fact.
 *
 * There is no cheap PostgREST "group by" query via supabase-js, and with a
 * handful of events total, fetching just the `category` column and counting
 * in JS is simpler and fast enough than adding an RPC function.
 */
export async function countEventsByCategory(): Promise<Record<string, number>> {
  const { data, error } = await supabaseAdmin().from("events").select("category");
  if (error) throw new Error(`[repo/events] countEventsByCategory 失敗：${error.message}`);

  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { category: string }[]) {
    counts[row.category] = (counts[row.category] ?? 0) + 1;
  }
  return counts;
}

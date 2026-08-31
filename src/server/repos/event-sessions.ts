/**
 * Data layer for public.event_sessions — used exclusively by admin server
 * functions (src/lib/admin/fns/event-sessions.ts).
 *
 * Mirrors src/server/repos/events.ts: every Supabase error is thrown, never
 * swallowed. A back office that silently returns null/empty on a permission or
 * connection error looks indistinguishable from "there is no data", and an
 * admin could believe a write succeeded when it never reached the database.
 *
 * Rows are returned exactly as Supabase returns them — snake_case columns, no
 * camelCase renaming — so what you see here matches
 * supabase/migrations/0020_event_sessions_registrations.sql §1 column-for-column.
 *
 * WHAT THIS FILE MAY NOT WRITE
 * ----------------------------
 * `seats_taken`. It is not in SessionUpsertInput and must never be added to it.
 * That counter has exactly three writers, all of them SQL functions that hold
 * the session's row lock while they work: reserve_session_seat(),
 * release_session_seat() and expire_unpaid_orders(). A PATCH from here would be
 * a read-modify-write against a number two shoppers can be moving at the same
 * moment — the oversell bug the whole 0020 design exists to make impossible.
 * Same rule, same reason, as products.seats_taken in src/server/repos/products.ts.
 *
 * `capacity` IS writable, because lowering it is a legitimate back-office act.
 * The database refuses to let it go below seats_taken
 * (`event_sessions_seats_within_capacity`), so "cut the room down to 10 when 12
 * have already booked" fails loudly instead of producing a session that is
 * over its own limit.
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import type { Localized } from "@/i18n/types";

const COLUMNS =
  "id, product_id, title, location, starts_at, ends_at, capacity, seats_taken, status, sort_order, created_at, updated_at";

export type EventSessionStatus = "open" | "closed";

export type EventSessionRow = {
  id: string;
  product_id: string;
  title: Localized;
  location: Localized;
  starts_at: string;
  ends_at: string | null;
  capacity: number;
  /** Read-only here. See the file header. */
  seats_taken: number;
  status: EventSessionStatus;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

/** `id` omitted (or empty) means "create". */
export type SessionUpsertInput = {
  id?: string;
  product_id: string;
  title: Localized;
  location: Localized;
  starts_at: string;
  ends_at?: string | null;
  capacity: number;
  status: EventSessionStatus;
  sort_order: number;
};

/**
 * Every session, newest activity first, for the back-office list.
 *
 * Deliberately not filtered by product: the page this feeds answers "what is
 * coming up and who has signed up", which is a question about the calendar, not
 * about one product. The product's title is joined in by the caller
 * (src/lib/admin/fns/event-sessions.ts) rather than here, so this file stays a
 * plain one-table repo like every other repo in this directory.
 */
export async function listEventSessions(): Promise<EventSessionRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("event_sessions")
    .select(COLUMNS)
    .order("starts_at", { ascending: false })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/event-sessions] list 失敗：${error.message}`);
  return (data ?? []) as EventSessionRow[];
}

export async function getEventSessionById(id: string): Promise<EventSessionRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("event_sessions")
    .select(COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`[repo/event-sessions] getById 失敗：${error.message}`);
  return (data as EventSessionRow | null) ?? null;
}

/**
 * Creates or updates one session.
 *
 * `id` absent → insert (the column has a `gen_random_uuid()` default, so unlike
 * events.id there is nothing to generate here). `id` present → update, and the
 * update deliberately does NOT send seats_taken, so a stale form cannot write
 * back a count read minutes ago.
 */
export async function upsertEventSession(input: SessionUpsertInput): Promise<EventSessionRow> {
  const payload = {
    product_id: input.product_id,
    title: input.title,
    location: input.location,
    starts_at: input.starts_at,
    ends_at: input.ends_at && input.ends_at.trim() ? input.ends_at : null,
    capacity: input.capacity,
    status: input.status,
    sort_order: input.sort_order,
  };

  const id = input.id && input.id.trim() ? input.id.trim() : null;
  const query = id
    ? supabaseAdmin().from("event_sessions").update(payload).eq("id", id)
    : supabaseAdmin().from("event_sessions").insert(payload);

  const { data, error } = await query.select(COLUMNS).single();
  if (error) throw new Error(`[repo/event-sessions] upsert 失敗：${error.message}`);
  return data as EventSessionRow;
}

/**
 * Deletes a session.
 *
 * Will fail with a foreign-key violation when anyone has ever booked it —
 * event_registrations.session_id and order_items.session_id are both
 * `on delete restrict` (0020 §1–§3). That is the intended behaviour and the
 * error is passed through rather than translated: "this sitting has people in
 * it" is exactly what the admin needs to hear, and inventing a friendlier
 * sentence here would mean guessing which of the two constraints fired.
 */
export async function removeEventSession(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("event_sessions").delete().eq("id", id);
  if (error) throw new Error(`[repo/event-sessions] remove 失敗：${error.message}`);
}

/**
 * The event/journey products a session can be attached to.
 *
 * Every status, not just `active`: a session usually has to exist before its
 * product is published, and 0020's backfill deliberately creates sessions as
 * `closed` precisely so the back office can fill in the real date first.
 */
export async function listBookableProducts(): Promise<
  { id: string; slug: string; title: Localized; product_type: string; status: string }[]
> {
  const { data, error } = await supabaseAdmin()
    .from("products")
    .select("id, slug, title, product_type, status")
    .in("product_type", ["event", "journey"])
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  if (error) throw new Error(`[repo/event-sessions] listBookableProducts 失敗：${error.message}`);
  return (data ?? []) as {
    id: string;
    slug: string;
    title: Localized;
    product_type: string;
    status: string;
  }[];
}

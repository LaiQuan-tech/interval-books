/**
 * artists server functions — the only way the admin UI is allowed to touch
 * public.artists. Every export chains adminFnMiddleware: that middleware, not
 * the /admin/_shell route guard, is the real authorization boundary (see
 * src/lib/admin/middleware.ts).
 *
 * ⚠️ upsertArtist 的 inputValidator 是 artistSchema，而 artistSchema **沒有**
 *    vendor_id。zod 物件 schema 預設會把沒宣告的 key 剝掉，所以就算有人直接
 *    POST /_serverFn/… 塞一個 vendor_id 進來，它到不了 repo。這一層與
 *    src/server/repos/artists.ts 的 payload 兩道各自獨立，理由見那支檔頭。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { artistSchema } from "@/lib/admin/schemas";

export const listArtists = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listArtists } = await import("@/server/repos/artists");
    return await listArtists();
  });

export const getArtistById = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { getArtistById } = await import("@/server/repos/artists");
    return await getArtistById(data.id);
  });

/** 活動後台「主講人」下拉的選項（只有啟用中的講者，依 sort_order）。 */
export const listArtistOptions = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listArtistOptions } = await import("@/server/repos/artists");
    return await listArtistOptions();
  });

export const upsertArtist = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(artistSchema)
  .handler(async ({ data }) => {
    const { upsertArtist } = await import("@/server/repos/artists");
    return await upsertArtist(data);
  });

export const removeArtist = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { removeArtist } = await import("@/server/repos/artists");
    await removeArtist(data.id);
    return { ok: true };
  });

/**
 * 每位講者掛著幾場活動。講者後台用它在刪除確認框裡說清楚後果：活動不會被刪，
 * 只會變成沒有講者（events.speaker_id 是 on delete set null，見 0025）。
 */
export const countEventsBySpeaker = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { countEventsBySpeaker } = await import("@/server/repos/artists");
    return await countEventsBySpeaker();
  });

/**
 * event_blocks server functions —— 後台唯一碰得到 public.event_blocks 的路。
 *
 * 每一支都掛 adminFnMiddleware：授權的真正邊界是那個 middleware，不是 /admin/_shell
 * 的路由守衛（見 src/lib/admin/middleware.ts）。0027 的 RLS 對 anon／authenticated
 * 是全關的（deny insert/update/delete），寫入只有 service_role 走得通，而 service_role
 * 只在通過這個 middleware 之後才拿得到。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import { eventBlockSchema } from "@/lib/admin/schemas";
import { EVENT_BLOCK_KINDS } from "@/lib/event-blocks";

export const listEventBlocks = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ event_id: z.string().trim().min(1) }))
  .handler(async ({ data }) => {
    const { listEventBlocks } = await import("@/server/repos/event-blocks");
    return await listEventBlocks(data.event_id);
  });

export const upsertEventBlock = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(eventBlockSchema)
  .handler(async ({ data }) => {
    const { upsertEventBlock } = await import("@/server/repos/event-blocks");
    return await upsertEventBlock(data);
  });

/**
 * 刪掉一列，並把同一組剩下的列補成 1…n（不留洞）。補號那一步在 repo 裡走
 * admin_reorder_event_blocks()，不是逐列 UPDATE —— 見 repo 的註解。
 */
export const removeEventBlock = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ id: z.number().int() }))
  .handler(async ({ data }) => {
    const { removeEventBlock } = await import("@/server/repos/event-blocks");
    await removeEventBlock(data.id);
    return { ok: true };
  });

/**
 * 把一組（event_id + kind）重排成 `ids` 的順序。
 *
 * 🔴 `ids` 必須是那一組的**完整**清單，不是被移動的那兩列 —— 見
 *    src/server/repos/event-blocks.ts#reorderEventBlocks。`.min(1)` 擋的是「送一個
 *    空陣列進去」：那在 SQL 那一側是一個安靜的 no-op，畫面上看起來就像排序失效了。
 */
export const reorderEventBlocks = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(
    z.object({
      event_id: z.string().trim().min(1),
      kind: z.enum(EVENT_BLOCK_KINDS),
      ids: z.array(z.number().int()).min(1),
    }),
  )
  .handler(async ({ data }) => {
    const { reorderEventBlocks } = await import("@/server/repos/event-blocks");
    await reorderEventBlocks(data.event_id, data.kind, data.ids);
    return { ok: true };
  });

/**
 * orders server functions —— 後台訂單列表／詳情／標記已收款
 * （src/routes/admin/_shell.orders.tsx）。
 *
 * 🔴 每一支都掛 adminFnMiddleware。這一頁看得到客人的姓名與遮罩後的聯絡方式，而
 * 「標記已收款」是一個會動到錢的動作 —— 與 middleware.ts 檔頭記錄的既有 15 支
 * admin-only 函式同一個立場，只有 role='admin' 能碰，門市人員（staff）不行。
 *
 * 與 event-registrations.ts 那四支（staffFnMiddleware + event.roster.read）刻意
 * 不同：那邊在 0021 §4 已經有一個獨立的細權限可以授權給工讀生，這裡沒有這種需
 * 求 —— 對帳與手動核銷付款不是可以下放給門市人員的工作，「先當作只有 admin 能碰
 * 比較安全」與這個檔案要保護的東西（金額、付款狀態）相稱。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { adminFnMiddleware } from "@/lib/admin/middleware";

export const listAdminOrders = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ scope: z.enum(["transfer_pending", "all"]) }))
  .handler(async ({ data }) => {
    const { listAdminOrders } = await import("@/server/repos/orders-admin");
    return await listAdminOrders(data);
  });

export const getAdminOrderDetail = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .inputValidator(z.object({ orderId: z.string().trim().uuid() }))
  .handler(async ({ data }) => {
    const { getAdminOrderDetail } = await import("@/server/repos/orders-admin");
    return await getAdminOrderDetail(data.orderId);
  });

/**
 * 標記一張訂單已收款（呼叫 0034 §5 的 admin_mark_order_paid()）。
 *
 * p_actor_id 只認 context.admin.userId —— 與 event-registrations.ts 的
 * revealRegistrationContact() 同一個立場：「是誰做的」不能由呼叫端在 data 裡宣稱，
 * 只能從已經驗證過的 session 讀。data 裡因此**沒有** actorId 這個欄位。
 *
 * 只有 reason==='marked' 才代表這一次呼叫真的讓一筆新的付款生效，才順手觸發付款
 * 通知；其餘三種 reason（already_paid／order_not_pending／order_not_found）都代表
 * 沒有新的付款事件發生，通知會是重複或無意義的，不觸發。
 */
export const markOrderPaidAdmin = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(
    z.object({
      orderId: z.string().trim().uuid(),
      note: z.string().trim().max(500).nullable(),
    }),
  )
  .handler(async ({ data, context }) => {
    const { markOrderPaidByAdmin } = await import("@/server/repos/orders-admin");
    const result = await markOrderPaidByAdmin({
      orderId: data.orderId,
      actorId: context.admin.userId,
      note: data.note,
    });

    if (result.reason === "marked") {
      // best-effort、8 秒逾時保護，失敗不影響上面已經成立的標記結果 —— 信本來就
      // 會被 notifyBacklog 的排程補寄，見 src/server/notify.ts 檔頭。
      const { triggerNotifyAfterPayment } = await import("@/server/notify");
      await triggerNotifyAfterPayment(data.orderId);
    }

    return result;
  });

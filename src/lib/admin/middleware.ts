/**
 * Authorization middleware for admin server functions.
 *
 * THIS IS THE SECURITY BOUNDARY. The router context and the /admin route guard
 * only affect what the UI shows; neither stops someone POSTing straight to
 * /_serverFn/…  Every admin server function must chain this middleware, and
 * everything under src/server/repos/** assumes its caller already did.
 */
import { createMiddleware } from "@tanstack/react-start";
import type { StaffPermission } from "@/server/auth";

export const adminFnMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    // Imported inside the handler so the module graph never pulls server-only
    // code toward the client bundle.
    const { requireAdmin } = await import("@/server/auth");
    const admin = await requireAdmin();
    return next({ context: { admin } });
  },
);

/**
 * 門市那一側的授權邊界（POS、銷售紀錄、賣超告警）。
 *
 * 與 adminFnMiddleware 並排而不是取代它：上面那支守著現有 15 支後台函式，
 * 語意是「role 必須是 admin」，一個字都沒有放寬。這支放寬到 staff，所以它
 * **只能**掛在門市那幾支上。掛錯地方就是把 CMS 交給店員。
 *
 *   staffFnMiddleware()                              → staff 或 admin
 *   staffFnMiddleware("approve_stock_adjustments")   → 再查 staff_permissions
 *
 * admin 一律通過細權限檢查（來源 inv.has_permission() 的第一句就是
 * `IF is_admin() THEN RETURN true`）。
 *
 * ⚠️ 側欄把某個模組藏起來**不是授權**。/admin/_shell 的 beforeLoad 與 NAV_GROUPS
 *    只決定畫面；擋住直接 POST /_serverFn/… 的，只有這裡。
 */
export function staffFnMiddleware(permission?: StaffPermission) {
  return createMiddleware({ type: "function" }).server(async ({ next }) => {
    const { requireStaff } = await import("@/server/auth");
    const staff = await requireStaff(permission);
    return next({ context: { staff } });
  });
}

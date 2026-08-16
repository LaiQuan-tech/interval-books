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

export const adminFnMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  // Imported inside the handler so the module graph never pulls server-only
  // code toward the client bundle.
  const { requireAdmin } = await import("@/server/auth");
  const admin = await requireAdmin();
  return next({ context: { admin } });
});

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

/**
 * 廠商自助入口那一側的授權邊界（0019）。
 *
 * 與上面兩支並排而不是取代它們：這是第一次有**非店員**的身分碰到 inv 的資料，
 * 而他要看到的東西差別不在「多與少」，在「是誰的」。
 *
 * context.vendor.vendorId 是**唯一**合法的 vendor_id 來源。
 *
 * ⚠️ 每一支掛這個 middleware 的 server fn，它的 inputValidator **不可以有
 *    vendorId 這個欄位**。要過濾哪一家，從 context 拿；client 送進來的一律不算。
 *    這一條有測試守著（scripts/inventory-vendors-selftest.mjs 會掃 fns 檔）。
 *
 * ⚠️ 資料庫那一側還有第二道門：0019 §7 的每一支函式簽名都沒有 p_vendor_id
 *    參數。就算這一層被寫壞，資料庫仍然只回那個 user 自己那一家的資料。
 */
export function vendorFnMiddleware() {
  return createMiddleware({ type: "function" }).server(async ({ next }) => {
    const { requireVendor } = await import("@/server/vendor-auth");
    const vendor = await requireVendor();
    return next({ context: { vendor } });
  });
}

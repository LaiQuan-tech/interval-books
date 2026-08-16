/**
 * 廠商自助入口的 server functions。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 這個檔案只有一條規矩，而且它比其他所有規矩加起來重要
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **過濾用的 vendor_id 一律來自 session，絕不接受 client 傳來的 id。**
 *
 * 具體長相：
 *
 *   · 下面每一支的 `inputValidator` **都沒有 vendorId 這個欄位**。不是「有但會
 *     檢查」，是根本沒有 —— 送進來的 JSON 裡多一個 vendorId 會被 zod 丟掉，
 *     而且不會有任何一行程式去讀它。
 *   · repo 那一層的簽名也只收 userId（見 repos/inv-vendors.ts §3）。
 *   · 資料庫那一層的函式簽名同樣沒有 p_vendor_id，vendor_id 是函式體內用
 *     p_user_id 查 public.vendor_users 得到的（0019 §7.4）。
 *
 * 三層各自獨立。要偽造成別家廠商，得先偽造 sealed httpOnly cookie 裡的 userId。
 *
 * ⚠️ 如果哪天要加一支新的廠商 server fn：它的 inputValidator 裡出現 vendorId
 *    就是寫錯了。scripts/inventory-vendors-selftest.mjs 會掃這個檔案擋下來。
 *
 * ── 授權 ──────────────────────────────────────────────────────────────────
 * 每一支（除了登入）都掛 vendorFnMiddleware()。那一支會：
 *   1. 讀 `ib_vendor` cookie（與後台的 `ib_admin` 是不同的 cookie）
 *   2. 重讀 profiles.role = 'vendor'
 *   3. 呼叫 public.vendor_my_id()，那裡再檢查 vendor_users.is_active、
 *      vendors.status='active'、approval_status='approved'
 * 三個開關任何一個關掉，下一個請求就被擋。
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { vendorFnMiddleware } from "@/lib/admin/middleware";
import { vendorProductSubmitSchema, vendorSignInSchema } from "@/lib/admin/schemas";

// ---------------------------------------------------------------------------
// 登入／登出
// ---------------------------------------------------------------------------

export const vendorSignIn = createServerFn({ method: "POST" })
  .inputValidator(vendorSignInSchema)
  .handler(async ({ data }) => {
    const { signInVendor } = await import("@/server/vendor-auth");
    return await signInVendor(data.email, data.password);
  });

export const vendorSignOut = createServerFn({ method: "POST" }).handler(async () => {
  const { signOutVendor } = await import("@/server/vendor-auth");
  await signOutVendor();
  return { ok: true };
});

/** 給 /vendor 的 route guard 用。不丟例外，所以它可以決定要導去登入頁還是說明頁。 */
export const getCurrentVendor = createServerFn({ method: "GET" }).handler(async () => {
  const { getVendorOrNull, getVendorSessionOrNull } = await import("@/server/vendor-auth");
  const vendor = await getVendorOrNull();
  if (vendor) return { state: "ok" as const, vendor };

  // 登入了但還沒綁廠商（或被停權）——「你不該在這裡」與「等一下」是兩件事。
  const session = await getVendorSessionOrNull();
  if (session) return { state: "unlinked" as const, email: session.email };
  return { state: "signed_out" as const };
});

// ---------------------------------------------------------------------------
// 讀 —— 每一支的 input 都沒有 vendorId
// ---------------------------------------------------------------------------

export const myVendorProfile = createServerFn({ method: "GET" })
  .middleware([vendorFnMiddleware()])
  .handler(async ({ context }) => {
    const { vendorPortalProfile } = await import("@/server/repos/inv-vendors");
    // ⚠️ 傳下去的是 userId，不是 vendorId。哪一家由資料庫從 vendor_users 推導。
    return await vendorPortalProfile(context.vendor.userId);
  });

export const myProducts = createServerFn({ method: "GET" })
  .middleware([vendorFnMiddleware()])
  .handler(async ({ context }) => {
    const { vendorPortalProducts } = await import("@/server/repos/inv-vendors");
    return await vendorPortalProducts(context.vendor.userId);
  });

/**
 * 廠商看自己的完整匯款帳號。
 *
 * ⚠️ 走的是**和店員一模一樣**的那扇門（0019 §4），所以一樣留下 pii_access_log，
 *    只是 access_kind='self'、reason='self_service'。
 *
 *    「是自己的資料所以不用記」聽起來合理，但入口帳號是店家配發的，而配發之後是
 *    誰在用是另一件事 —— 帳號被冒用時，那批 self 紀錄是唯一查得出「什麼時候開始
 *    不對勁」的東西。
 *
 * ⚠️ vendorId 從 context 拿。這是這一支唯一會出現 vendorId 的地方，而它來自
 *    requireVendor() 的回傳值，不是 request body。
 */
export const myBankAccountDetails = createServerFn({ method: "POST" })
  .middleware([vendorFnMiddleware()])
  .handler(async ({ context }) => {
    const { readVendorSensitive } = await import("@/server/repos/inv-vendors");
    return await readVendorSensitive({
      actorUserId: context.vendor.userId,
      actorEmail: context.vendor.email,
      vendorId: context.vendor.vendorId, // ← session，不是 client
      fields: ["bank_accounts"],
      reason: "self_service",
      accessKind: "self",
    });
  });

// ---------------------------------------------------------------------------
// 寫
// ---------------------------------------------------------------------------

/**
 * 送審一件商品（或修改自己還在待審核的那一件）。
 *
 * ⚠️ payload 裡沒有 approval_status、vendor_id、stock_quantity、cost_price、
 *    product_type —— 五個全部由資料庫決定（0019 §7.7）：
 *      · approval_status 寫死 'pending'，**不看 approval_settings**（§0.2）
 *      · vendor_id 由 vendor_my_id() 推導
 *      · 庫存一律 0（廠商說自己有幾本不算數，庫存只能由進貨／盤點改）
 *      · 成本是店家的資訊，不是廠商送出來的欄位
 *      · product_type 一律 consignment
 */
export const submitProduct = createServerFn({ method: "POST" })
  .middleware([vendorFnMiddleware()])
  .inputValidator(vendorProductSubmitSchema)
  .handler(async ({ data, context }) => {
    const { vendorPortalSubmitProduct } = await import("@/server/repos/inv-vendors");
    const { id, ...payload } = data;
    return await vendorPortalSubmitProduct({ userId: context.vendor.userId, id, payload });
  });

export const withdrawProduct = createServerFn({ method: "POST" })
  .middleware([vendorFnMiddleware()])
  .inputValidator(z.object({ id: z.string().trim().uuid() }))
  .handler(async ({ data, context }) => {
    const { vendorPortalWithdrawProduct } = await import("@/server/repos/inv-vendors");
    // ⚠️ 只有 id，沒有 vendorId。資料庫那一支的 WHERE 會自己加上
    //    `vendor_id = vendor_my_id(p_user_id)` —— 拿別家的 id 進來會打不中任何列，
    //    而且回的是「找不到」而不是「無權限」（後者可以拿來確認那個 id 存在）。
    return await vendorPortalWithdrawProduct({ userId: context.vendor.userId, id: data.id });
  });

/** 商品照片。走既有的 site-images（那是公開圖，商品封面本來就要給客人看）。 */
export const uploadProductImage = createServerFn({ method: "POST" })
  .middleware([vendorFnMiddleware()])
  .inputValidator((data: unknown) => {
    if (!(data instanceof FormData)) throw new Error("請選擇圖片");
    const file = data.get("file");
    if (!(file instanceof File)) throw new Error("請選擇圖片");
    return { file };
  })
  .handler(async ({ data }) => {
    const { uploadSiteImage } = await import("@/server/storage");
    return await uploadSiteImage(data.file);
  });

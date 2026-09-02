/**
 * staff-accounts server functions — the only way the admin UI is allowed to
 * touch back-office identity (public.profiles' role for admin/staff/pending,
 * and public.staff_permissions). Every export chains adminFnMiddleware, and
 * — unlike every other fns/*.ts file in this app — that is not decoration
 * here: this is the ONE page that must reject `staff`, not just `pending`.
 * adminFnMiddleware already does that (it calls requireAdmin(), which only
 * ever accepts role === 'admin' — see src/server/auth.ts), so chaining it is
 * sufficient; nothing below re-derives that check.
 *
 * context.admin.userId (set by adminFnMiddleware from the signed-in admin's
 * session — see src/lib/admin/middleware.ts) is the ONLY source of "who is
 * doing this". No input schema below has an actorUserId/userId-of-the-caller
 * field for the browser to fill in — see src/lib/admin/fns/vendor-portal.ts's
 * vendorId convention for the same reasoning applied to a different identity
 * boundary, and supabase/migrations/0033_admin_staff_management.sql's header
 * for why the database side of this can't just read auth.uid() instead.
 */
import { createServerFn } from "@tanstack/react-start";
import { adminFnMiddleware } from "@/lib/admin/middleware";
import {
  createStaffAccountSchema,
  removeStaffAccessSchema,
  staffPermissionsSchema,
  updateStaffRoleSchema,
} from "@/lib/admin/schemas";

export const listStaffAccounts = createServerFn({ method: "GET" })
  .middleware([adminFnMiddleware])
  .handler(async () => {
    const { listStaffAccounts } = await import("@/server/repos/staff-accounts");
    return await listStaffAccounts();
  });

export const createStaffAccount = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(createStaffAccountSchema)
  .handler(async ({ data, context }) => {
    const { createStaffAccount } = await import("@/server/repos/staff-accounts");
    return await createStaffAccount({
      email: data.email,
      password: data.password,
      role: data.role,
      actorUserId: context.admin.userId,
    });
  });

/** pending → staff/admin、升降級，都經這一支。不能是 vendor 或 customer —
 * updateStaffRoleSchema 的 role 欄位就只有三個合法值，協定層面擋掉其餘。 */
export const updateStaffRole = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(updateStaffRoleSchema)
  .handler(async ({ data, context }) => {
    const { updateStaffRole } = await import("@/server/repos/staff-accounts");
    return await updateStaffRole({
      actorUserId: context.admin.userId,
      targetUserId: data.userId,
      role: data.role,
    });
  });

/** 移除後台身分（角色設回 customer）。刻意是獨立的一支 server fn 而不是
 * updateStaffRole 的一個 role 選項——見 removeStaffAccessSchema 的說明。 */
export const removeStaffAccess = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(removeStaffAccessSchema)
  .handler(async ({ data, context }) => {
    const { removeStaffAccess } = await import("@/server/repos/staff-accounts");
    return await removeStaffAccess({
      actorUserId: context.admin.userId,
      targetUserId: data.userId,
    });
  });

export const setStaffPermissions = createServerFn({ method: "POST" })
  .middleware([adminFnMiddleware])
  .inputValidator(staffPermissionsSchema)
  .handler(async ({ data, context }) => {
    const { setStaffPermissions } = await import("@/server/repos/staff-accounts");
    return await setStaffPermissions({
      actorUserId: context.admin.userId,
      targetUserId: data.userId,
      permissions: data.permissions,
    });
  });

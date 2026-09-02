/**
 * Data layer for the back-office people-management page (/admin/staff) —
 * used exclusively by admin server functions (src/lib/admin/fns/staff-accounts.ts).
 * See src/server/repos/news.ts for the throw-never-swallow rationale; the
 * same applies here.
 *
 * Answers the question that had no UI before this file: "哪邊可以設定管理員
 * 與操作人員" (see src/routes/admin/pending.tsx — the account sat at role =
 * 'pending' with a paragraph telling them to find an admin, and no button
 * anywhere did that). Modeled on agec-web's app/(admin)/admin/users
 * (~/.gemini/File/NTU/agec-web) — same two-step "create account then set
 * role, roll back on failure" shape and the same "AFTER STATEMENT trigger
 * guarding the last admin" idea — but the actual writes here go through
 * supabase/migrations/0033_admin_staff_management.sql's two RPCs, not a
 * plain `.update()`, because this app has no `auth.uid()` to lean on (see
 * that migration's header for why) and the RPCs are where "can't change your
 * own role" and "role can never be 'vendor' from this page" are enforced a
 * second time, in the database, not just here.
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";
import { STAFF_PERMISSIONS, type BackOfficeRole, type StaffPermission } from "@/server/auth";

/** The three roles this page manages. Deliberately narrower than
 * BackOfficeRole would suggest — see CreatableRole below. */
export type StaffAccountRow = {
  id: string;
  email: string | null;
  role: BackOfficeRole;
  created_at: string;
  permissions: StaffPermission[];
};

/**
 * Roles this page is allowed to hand a *new* account. Intentionally not the
 * same union as the role a person can be moved to afterwards (which also
 * includes 'customer' — see removeStaffAccess below): creating an account
 * with role='customer' via a *staff management* tool would be pointless
 * (nobody opens this page to make a plain shopper), and 'vendor' is a
 * different subsystem's identity entirely (0019's supplier self-service
 * portal) — mixing it in here is exactly the failure mode the task asked to
 * avoid. This type is also mirrored by createStaffAccountSchema in
 * src/lib/admin/schemas.ts; scripts/staff-accounts-selftest.mjs pins both to
 * the literal three-value list.
 */
export type CreatableRole = Extract<BackOfficeRole, "pending" | "staff" | "admin">;

const PROFILE_COLUMNS = "id, email, role, created_at";

type ProfileRow = { id: string; email: string | null; role: string; created_at: string };

/** Postgres error shape from supabase-js — both .rpc() and .from() return this. */
type PgError = { message: string; code?: string };

/** GoTrue's errors are English prose; translate the common ones for the UI. */
function describeGoTrueError(error: { message?: string; status?: number }): string {
  const message = error.message ?? "";
  if (/already been registered|already exists|duplicate/i.test(message)) {
    return "這個電子郵件已經有帳號了。";
  }
  if (/password/i.test(message)) {
    return `密碼不符合規則：${message}`;
  }
  if (/email/i.test(message)) {
    return `電子郵件格式有誤：${message}`;
  }
  return `帳號操作失敗（${error.status ?? "unknown"}）：${message}`;
}

/**
 * Translates the RAISE EXCEPTION codes from admin_update_profile_role()
 * (supabase/migrations/0033_admin_staff_management.sql §2) into Chinese.
 * Matched by substring, not exact equality — Postgres/PostgREST sometimes
 * wraps the raised message with additional context.
 */
function describeRoleError(error: PgError): string {
  const message = error.message ?? "";
  if (/LAST_ADMIN/.test(message)) {
    return "無法完成：這是系統目前最後一位管理員，至少要保留一位管理員才能繼續，請先指定另一位管理員。";
  }
  if (/CANNOT_CHANGE_OWN_ROLE/.test(message)) {
    return "不能修改自己的角色，請改由另一位管理員協助操作。";
  }
  if (/INVALID_ROLE/.test(message)) {
    return "不支援的角色。";
  }
  if (/PROFILE_NOT_FOUND/.test(message)) {
    return "找不到這個帳號，可能已被刪除，請重新整理頁面。";
  }
  return `更新角色失敗：${message}`;
}

function toRow(profile: ProfileRow, permissions: StaffPermission[]): StaffAccountRow {
  return {
    id: profile.id,
    email: profile.email,
    role: profile.role as BackOfficeRole,
    created_at: profile.created_at,
    permissions,
  };
}

/**
 * Everyone with a back-office identity: admin / staff / pending. Deliberately
 * excludes customer and vendor — this page has no business showing (or
 * being able to accidentally act on) either of those, see CreatableRole above
 * and the task's explicit "不可以讓這個介面設出 vendor 或 customer" for why
 * vendor especially must never surface here.
 *
 * staff_permissions has no FK to profiles (both reference auth.users
 * independently — see 0002 §1 and 0010 §2), so PostgREST can't embed one
 * query inside the other; two queries, merged here, is the same shape the
 * categories page already uses for its per-row counts
 * (src/routes/admin/_shell.categories.tsx's loader).
 */
export async function listStaffAccounts(): Promise<StaffAccountRow[]> {
  const [profilesResult, permissionsResult] = await Promise.all([
    supabaseAdmin()
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .in("role", ["admin", "staff", "pending"])
      .order("role", { ascending: true })
      .order("created_at", { ascending: true }),
    supabaseAdmin().from("staff_permissions").select("user_id, permission"),
  ]);

  if (profilesResult.error) {
    throw new Error(`[repo/staff-accounts] list 失敗：${profilesResult.error.message}`);
  }
  if (permissionsResult.error) {
    throw new Error(`[repo/staff-accounts] list 權限失敗：${permissionsResult.error.message}`);
  }

  const permissionsByUser = new Map<string, StaffPermission[]>();
  for (const row of permissionsResult.data ?? []) {
    const list = permissionsByUser.get(row.user_id) ?? [];
    list.push(row.permission as StaffPermission);
    permissionsByUser.set(row.user_id, list);
  }

  return ((profilesResult.data ?? []) as ProfileRow[]).map((profile) =>
    toRow(profile, permissionsByUser.get(profile.id) ?? []),
  );
}

/**
 * Creates a brand-new back-office account: GoTrue Admin API first, then set
 * the role via admin_update_profile_role(). If the second step fails, the
 * just-created auth account is deleted — otherwise it would be an orphan
 * that can authenticate (the password is real) but can never reach the back
 * office (loadBackOfficeProfile() in src/server/auth.ts only recognises
 * role admin/staff/pending; handle_new_user()'s default is 'customer').
 * Same two-step-with-rollback shape as agec-web's createUser()
 * (~/.gemini/File/NTU/agec-web/app/(admin)/admin/users/actions.ts:63-112).
 *
 * email_confirm: true — this project isn't wiring up an invite email this
 * round (task says so explicitly); the password is handed over in person or
 * by phone, same as agec-web. Without email_confirm the account would exist
 * but never be able to sign in.
 */
export async function createStaffAccount(input: {
  email: string;
  password: string;
  role: CreatableRole;
  actorUserId: string;
}): Promise<StaffAccountRow> {
  const { data: created, error: createError } = await supabaseAdmin().auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
  });

  if (createError || !created.user?.id) {
    throw new Error(
      createError
        ? `[repo/staff-accounts] 建立帳號失敗：${describeGoTrueError(createError)}`
        : "[repo/staff-accounts] 建立帳號失敗：沒有拿到新帳號的編號",
    );
  }

  const newUserId = created.user.id;

  const { data: profile, error: roleError } = await supabaseAdmin().rpc(
    "admin_update_profile_role",
    { p_actor_id: input.actorUserId, p_target_id: newUserId, p_new_role: input.role },
  );

  if (roleError || !profile) {
    // 補償：把剛建立的 auth 帳號收回去，不要留下孤兒帳號。
    const { error: rollbackError } = await supabaseAdmin().auth.admin.deleteUser(newUserId);
    const suffix = rollbackError
      ? `（⚠️ 而且剛建立的帳號沒有清乾淨，請聯絡開發者處理帳號 ${newUserId}）`
      : "";
    throw new Error(
      `[repo/staff-accounts] 設定角色失敗：${roleError ? describeRoleError(roleError) : "未知錯誤"}${suffix}`,
    );
  }

  return toRow(profile as ProfileRow, []);
}

/**
 * Promotes/demotes an existing back-office identity among pending / staff /
 * admin. "不能改自己" and "不能移除最後一位 admin" are both re-checked here
 * even though admin_update_profile_role() already enforces them — this repo
 * function fails fast on the self-check with zero network calls (no need to
 * round-trip to Postgres to learn you can't change your own role), while the
 * RPC (and, under it, the profiles_keep_last_admin trigger) is the layer
 * that actually can't be bypassed, since it runs inside the same statement
 * regardless of what this function does or doesn't check first.
 */
export async function updateStaffRole(input: {
  actorUserId: string;
  targetUserId: string;
  role: CreatableRole;
}): Promise<StaffAccountRow> {
  if (input.actorUserId === input.targetUserId) {
    throw new Error("[repo/staff-accounts] 不能修改自己的角色，請改由另一位管理員協助操作。");
  }

  const { data, error } = await supabaseAdmin().rpc("admin_update_profile_role", {
    p_actor_id: input.actorUserId,
    p_target_id: input.targetUserId,
    p_new_role: input.role,
  });

  if (error || !data) {
    throw new Error(`[repo/staff-accounts] ${describeRoleError(error ?? { message: "" })}`);
  }

  const permissions = await getPermissionsForUser(input.targetUserId);
  return toRow(data as ProfileRow, permissions);
}

/**
 * 移除後台身分：角色設回 'customer'，帳號本身不刪除、staff_permissions 也不清空
 * （見檔案開頭 setStaffPermissions 的說明——留著是刻意的，之後若重新指派為 staff，
 * 舊的細權限清單還在，管理員在同一個編輯對話框裡看得到、也能自己勾掉）。
 *
 * 與 updateStaffRole 分開成獨立函式（而不是讓呼叫端自己傳 role: 'customer'）
 * 是刻意的：src/lib/admin/fns/staff-accounts.ts 的 removeStaffAccess 因此可以
 * 有一個完全不含 role 欄位的 zod schema —— 客戶端從協定層面就沒有辦法對「移除」
 * 這個動作夾帶任何角色值，不必依賴實作記得檢查。
 */
export async function removeStaffAccess(input: {
  actorUserId: string;
  targetUserId: string;
}): Promise<StaffAccountRow> {
  return updateStaffRole({ ...input, role: "customer" as unknown as CreatableRole });
}

async function getPermissionsForUser(userId: string): Promise<StaffPermission[]> {
  const { data, error } = await supabaseAdmin()
    .from("staff_permissions")
    .select("permission")
    .eq("user_id", userId);
  if (error) throw new Error(`[repo/staff-accounts] 讀取權限失敗：${error.message}`);
  return (data ?? []).map((row) => row.permission as StaffPermission);
}

/**
 * 整批覆蓋一個人的細權限。呼叫 admin_replace_staff_permissions()（0033 §3）
 * 而不是自己先 delete 再 insert 兩次呼叫——見那支 RPC 的註解：兩次呼叫之間
 * 網路失敗會讓權限「靜默變空」，不是回到修改前的樣子。
 *
 * 不在這裡重新檢查 permissions 是不是 STAFF_PERMISSIONS 的子集：
 * staff_permissions.permission 的 CHECK（0021 §4）本身會擋非法值，
 * src/lib/admin/schemas.ts 的 zod schema 是給使用者的友善錯誤那一層。
 */
export async function setStaffPermissions(input: {
  actorUserId: string;
  targetUserId: string;
  permissions: StaffPermission[];
}): Promise<StaffPermission[]> {
  const { error } = await supabaseAdmin().rpc("admin_replace_staff_permissions", {
    p_user_id: input.targetUserId,
    p_permissions: input.permissions,
    p_granted_by: input.actorUserId,
  });
  if (error) throw new Error(`[repo/staff-accounts] 更新權限失敗：${error.message}`);
  return input.permissions;
}

/** Re-exported so the fns layer's zod schema and this repo agree on the same list. */
export { STAFF_PERMISSIONS };

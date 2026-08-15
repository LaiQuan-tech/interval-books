-- 0010_inventory_identity.sql —— 進銷存的三層權限，接到 public.profiles
--
-- 0009 把進銷存的 21 張表原封搬進 inv，其中包含 inv.profiles（6 筆）與
-- inv.user_permissions（10 筆）—— 它們是**來源系統的歷史資料**，原樣保留。
-- 但真正決定「誰能登入這個網站的哪一塊」的，從今天起只有 public.profiles 一張表。
-- 這個檔案負責把來源那套三層權限翻譯過來。
--
-- ── 來源的權限模型 ───────────────────────────────────────────────────────
-- 來源用兩個 boolean 疊成三層：
--   is_approved = false            → 註冊了但還沒被放行，什麼都不能做
--   is_approved = true, is_admin=f → 一般員工，能做事，但敏感操作要簽核
--   is_admin    = true             → 管理員
-- 另外 user_permissions 掛 7 種 approve_* 細權限，決定這個員工「能簽核什麼」。
--
-- ── 對應到新模型 ─────────────────────────────────────────────────────────
--   profiles.is_approved = false   → profiles.role = 'pending'
--   profiles.is_admin    = true    → profiles.role = 'admin'（0002 既有值）
--   已核准非 admin                 → profiles.role = 'staff'
--   user_permissions               → public.staff_permissions
--   approval_settings              → 原樣留在 inv.approval_settings（0009 已含）
--
-- 資料本身在 scripts/ 的匯入步驟寫進去，這個檔案只負責**結構**。
--
-- 前一個 migration：0009_inventory_schema.sql。既有 0001–0008 一律不動。

begin;

-- ---------------------------------------------------------------------------
-- 1. 放寬 profiles.role 的 CHECK
-- ---------------------------------------------------------------------------
-- 0002_admin.sql:33 把 role 限制在 ('customer','admin')。那時候這個站只有
-- 「逛的人」與「管後台的人」兩種身分；進銷存搬進來之後多了三種：
--
--   pending —— 註冊了但沒被放行。**不是** customer：customer 是正常的購物客人，
--              pending 是「等著被放行的內部人」。混在一起，日後想查「還有誰在等
--              審核」就得多一張表才答得出來。
--   staff   —— 內部員工。能進進銷存，不能進電商後台（授權判斷仍在 server function
--              的 requireAdmin()，這裡只是把身分記下來）。
--   vendor  —— 廠商。這一期沒有任何一筆資料會是 vendor，先開好值是因為
--              inv.vendors 已經在庫裡，Phase 2 談寄賣對帳時一定會用到，
--              到時候再 drop/add 一次 constraint 是沒必要的風險。
--
-- ⚠️ 0002_admin.sql 已經套用過，所以**不改它** —— 在這裡 drop 再 add。
alter table public.profiles drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('customer', 'pending', 'staff', 'vendor', 'admin'));

comment on column public.profiles.role is
  'customer=購物客人（預設）｜pending=內部人員待放行｜staff=進銷存員工｜vendor=廠商（Phase 2 保留）｜admin=後台管理員。requireAdmin() 每次呼叫都重讀這一欄。';

-- ---------------------------------------------------------------------------
-- 2. staff_permissions —— 細權限
-- ---------------------------------------------------------------------------
-- 來源的 user_permissions 掛在 auth.users 上，每一列是一句「這個人可以簽核 X」。
-- 沒有列 = 沒有那個權限；admin 則跳過整張表（來源 has_permission() 是
-- `is_admin() OR EXISTS(...)`）。這裡照抄那個語意，只是搬到 public 並收緊權限。
--
-- 為什麼放 public 而不是 inv：這是**授權資料**，跟 profiles 是同一類東西，
-- 未來電商後台若要細分權限也會用它。inv 是「搬進來的舊系統」，不該長新東西。
-- 它一樣不對瀏覽器開放 —— RLS 開著、零 policy、只有 service_role 讀得到，
-- 跟 0002_admin.sql:56 對 profiles 的做法一致。
create table if not exists public.staff_permissions (
  user_id    uuid not null references auth.users (id) on delete cascade,
  permission text not null
             check (permission in (
               'approve_products',
               'approve_purchases',
               'approve_price_changes',
               'approve_vendors',
               'approve_combo_sets',
               'approve_stock_adjustments',
               'approve_inventory_adjustments'
             )),
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, permission)
);

comment on table public.staff_permissions is
  '進銷存細權限（來源 public.user_permissions 平移）。有列=有權限；admin 不需要列，一律視為全有。只有 service_role 讀得到。';
comment on column public.staff_permissions.permission is
  '七種 approve_* 之一。CHECK 是刻意的：來源那張表沒有約束，打錯字會變成一個永遠不成立的權限，而且不會有人發現。';
comment on column public.staff_permissions.granted_by is
  '誰授的。來源是 NOT NULL，這裡放寬成可為 NULL 並 on delete set null —— 授權者離職刪帳號時，不該連帶把別人的權限一起刪掉。';

create index if not exists staff_permissions_user_idx
  on public.staff_permissions (user_id);

alter table public.staff_permissions enable row level security;
revoke all on table public.staff_permissions from anon, authenticated;
grant all on table public.staff_permissions to service_role;

commit;

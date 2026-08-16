-- 0016_inventory_products_admin.sql —— 商品主檔的 CRUD 與審核，搬進後台
--
-- 0014 讓店員在櫃檯**賣**進銷存的商品；這一份讓店員**維護**那些商品：新增、
-- 編輯、停用、審核、調價、Excel 匯入。
--
-- ── 這個檔案做五件事 ──────────────────────────────────────────────────────
--   1. inv.products 補一個 image_key（型錄有封面，庫存主檔一直沒有）
--   2. inv.initial_approval_status() —— fail-closed 的「這個模組要不要審核」
--   3. public.inv_approve_record() —— 審核的唯一入口，**模組白名單寫死在裡面**
--   4. 商品的六支寫入函式（存檔／停用／刪除／調價／匯入／批次改）
--   5. 四個唯讀 view，讓後台讀得到 inv.*（理由同 0012／0014：inv 不在 PostgREST）
--
-- 前一個 migration：0015_publications.sql。既有 0001–0015 一律不動。
--
-- ── 為什麼審核不能讓 client 指定表名 ──────────────────────────────────────
-- 來源進銷存的 useApprovalMutation({ table, queryKey, statusField }) 是讓呼叫端
-- 自己傳「要更新哪張表」。在來源那個架構下它只是難維護；搬過來之後 client 與
-- server 之間隔著 HTTP，那個 table 參數就會**從瀏覽器送進來** —— 等於把
-- `update <任意表> set <任意欄位>` 開給任何一個拿得到 session cookie 的人。
--
-- 所以這裡的 inv_approve_record() 收的是 module（一個字串代號），表名與狀態欄位
-- 全部寫死在下面那個 CASE 裡。**整支函式沒有一行動態 SQL** —— 表名是 PL/pgSQL
-- 的字面識別字，不是字串。下一個人就算想拼字串也沒有地方可以拼。
--
-- module 不在白名單 → RAISE EXCEPTION，不是靜默 no-op。靜默的話呼叫端會以為
-- 審核成功了。

begin;

-- ---------------------------------------------------------------------------
-- 1. inv.products.image_key —— 商品照片
-- ---------------------------------------------------------------------------
-- 來源系統的商品沒有照片欄位（唯一碰到相機的是 AI 拍照辨識，而那支打的是
-- Lovable AI Gateway，離開那個平台就失效，所以這一期沒有搬）。
--
-- 但後台已經有一個做好的 ImageField：壓縮、去 EXIF、上傳、回一個 image_key，
-- 型錄與地方刊物都在用。庫存主檔多這一欄，店員在盤點時就看得出「哪一本是這本」。
-- 與 public.products.image_key 同一種值（bundled key 或 storage:…）。
alter table inv.products
  add column if not exists image_key text;

comment on column inv.products.image_key is
  '商品照片。與 public.products.image_key 同一種值（bundled key 或 storage:…），由 ImageField 產生。來源進銷存沒有這一欄。';

-- ---------------------------------------------------------------------------
-- 2. initial_approval_status —— fail-closed，而且搬進資料庫
-- ---------------------------------------------------------------------------
-- 來源的 getInitialApprovalStatus() 在 **client** 上算：讀 approval_settings，
-- 查不到就回 'pending'（`setting?.is_enabled ?? true`）。那個 fail-closed 的語意
-- 是對的，位置是錯的 —— 在瀏覽器上算出來的 approval_status 會跟著 insert 一起
-- 送出去，改一個 request body 就能讓新商品直接是 approved。
--
-- 所以這一版：語意照抄，位置搬到資料庫。下面每一支寫入函式都呼叫它，**呼叫端
-- 完全沒有辦法指定 approval_status**（那個 key 就算出現在 payload 裡也會被忽略）。
create or replace function inv.initial_approval_status(p_module text)
returns text
language sql
stable
security definer
set search_path to 'inv', 'public'
as $$
  -- coalesce(..., true) 就是 fail-closed：查不到設定 = 要審核。
  -- 「這個模組沒有設定」與「這個模組不用審核」是兩件事，前者不能被讀成後者。
  select case
           when coalesce((select s.is_enabled from inv.approval_settings s where s.module = p_module), true)
           then 'pending'
           else 'approved'
         end;
$$;

comment on function inv.initial_approval_status(text) is
  '新建一筆記錄時該用的 approval_status。查不到設定一律回 pending（fail-closed，語意來自來源的 getInitialApprovalStatus）。';

revoke execute on function inv.initial_approval_status(text) from public;
revoke execute on function inv.initial_approval_status(text) from anon, authenticated;
grant  execute on function inv.initial_approval_status(text) to service_role;

-- ---------------------------------------------------------------------------
-- 3. inv_approve_record —— 審核的唯一入口
-- ---------------------------------------------------------------------------
-- 七個 module，對應七組（表, 狀態欄位, 通過時要寫的值）：
--
--   products              → inv.products.approval_status               'approved'
--   purchases             → inv.purchases.approval_status              'approved'
--   stock_adjustments     → inv.stock_adjustments.status               'confirmed'  ←
--   inventory_adjustments → inv.inventory_adjustments.approval_status  'approved'
--   combo_sets            → inv.combo_sets.approval_status             'approved'
--   vendors               → inv.vendors.approval_status                'approved'
--   price_changes         → inv.products.price_change_status           （另外把 pending_* 生效）
--
-- 兩個 module 特別容易被寫錯，所以特別講：
--   · stock_adjustments 的欄位叫 status 不是 approval_status，而且通過的值是
--     'confirmed' 不是 'approved'。來源的 useApprovalMutation 用一個 if 特判它 ——
--     那個特判正是「這張對照表本來就該在 server 端」的證據。
--   · price_changes **不是一張表**。它是 inv.products 上的另一組欄位。所以任何
--     「module 就是表名」的設計從一開始就對不起來。
--
-- ── 只允許 pending → approved/rejected ────────────────────────────────────
-- 來源沒有這個限制，可以把一筆已核准的進貨改回 rejected。但 inv.purchases 與
-- inv.inventory_adjustments 的 trigger 是 `OLD <> 'approved' AND NEW = 'approved'
-- THEN 加庫存` —— 庫存加過就加過了，狀態改回 rejected 不會把它收回去，只會留下
-- 一筆「被退回但貨已入庫」的紀錄，而且沒有任何地方會報錯。
--
-- 所以這裡守住起點：不是 pending 就不動，回 changed=false 讓 UI 說「已經有人
-- 處理過了」。這與 0014 的 resolveStockAlert 用 `.is("resolved_at", null)` 擋
-- 兩個店員同時按下去是同一條規矩。
create or replace function public.inv_approve_record(
  p_user_id  uuid,
  p_module   text,
  p_id       uuid,
  p_approved boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_before text;
  v_count  integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'APPROVAL_NO_OPERATOR: 審核必須記錄操作人員';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'APPROVAL_NO_TARGET: 沒有指定要審核哪一筆';
  END IF;

  -- ⚠️ 下面每一個分支的表名都是**字面識別字**。沒有 EXECUTE、沒有 format()、
  --    沒有 quote_ident() —— 因為根本沒有需要被拼進去的字串。
  CASE p_module

    WHEN 'products' THEN
      SELECT approval_status INTO v_before FROM inv.products WHERE id = p_id;
      UPDATE inv.products
         SET approval_status = CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
             approved_by     = p_user_id,
             approved_at     = now()
       WHERE id = p_id AND approval_status = 'pending';
      GET DIAGNOSTICS v_count = ROW_COUNT;

    WHEN 'purchases' THEN
      SELECT approval_status INTO v_before FROM inv.purchases WHERE id = p_id;
      UPDATE inv.purchases
         SET approval_status = CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
             approved_by     = p_user_id,
             approved_at     = now()
       WHERE id = p_id AND approval_status = 'pending';
      GET DIAGNOSTICS v_count = ROW_COUNT;

    WHEN 'stock_adjustments' THEN
      -- 欄位是 status，通過的值是 'confirmed'。見上面。
      SELECT status INTO v_before FROM inv.stock_adjustments WHERE id = p_id;
      UPDATE inv.stock_adjustments
         SET status      = CASE WHEN p_approved THEN 'confirmed' ELSE 'rejected' END,
             approved_by = p_user_id,
             approved_at = now()
       WHERE id = p_id AND status IN ('draft', 'pending');
      GET DIAGNOSTICS v_count = ROW_COUNT;

    WHEN 'inventory_adjustments' THEN
      SELECT approval_status INTO v_before FROM inv.inventory_adjustments WHERE id = p_id;
      UPDATE inv.inventory_adjustments
         SET approval_status = CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
             approved_by     = p_user_id,
             approved_at     = now()
       WHERE id = p_id AND approval_status = 'pending';
      GET DIAGNOSTICS v_count = ROW_COUNT;

    WHEN 'combo_sets' THEN
      SELECT approval_status INTO v_before FROM inv.combo_sets WHERE id = p_id;
      UPDATE inv.combo_sets
         SET approval_status = CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
             approved_by     = p_user_id,
             approved_at     = now()
       WHERE id = p_id AND approval_status = 'pending';
      GET DIAGNOSTICS v_count = ROW_COUNT;

    WHEN 'vendors' THEN
      -- inv.vendors 同時有 status 與 approval_status 兩欄。審核走 approval_status；
      -- status 是「這家供應商還有沒有在往來」，是另一件事。
      SELECT approval_status INTO v_before FROM inv.vendors WHERE id = p_id;
      UPDATE inv.vendors
         SET approval_status = CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
             approved_by     = p_user_id,
             approved_at     = now()
       WHERE id = p_id AND approval_status = 'pending';
      GET DIAGNOSTICS v_count = ROW_COUNT;

    WHEN 'price_changes' THEN
      -- 核准 = 把 pending_* 搬進正式欄位，然後把 pending_* 清掉。
      -- 退回 = 只改狀態，pending_* 留著（店員要看得到自己送了什麼被退回）。
      SELECT price_change_status INTO v_before FROM inv.products WHERE id = p_id;
      UPDATE inv.products
         SET cost_price            = CASE WHEN p_approved
                                          THEN coalesce(pending_cost_price, cost_price)
                                          ELSE cost_price END,
             selling_price         = CASE WHEN p_approved
                                          THEN coalesce(pending_selling_price, selling_price)
                                          ELSE selling_price END,
             pending_cost_price    = CASE WHEN p_approved THEN NULL ELSE pending_cost_price END,
             pending_selling_price = CASE WHEN p_approved THEN NULL ELSE pending_selling_price END,
             price_change_status   = CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END
       WHERE id = p_id AND price_change_status = 'pending';
      GET DIAGNOSTICS v_count = ROW_COUNT;

    ELSE
      -- 白名單以外一律炸掉。靜默 no-op 會讓呼叫端以為審核成功了。
      RAISE EXCEPTION 'APPROVAL_UNKNOWN_MODULE: 不認得的審核模組「%」', p_module
        USING ERRCODE = 'check_violation';
  END CASE;

  IF v_before IS NULL AND v_count = 0 THEN
    RAISE EXCEPTION 'APPROVAL_NOT_FOUND: 找不到要審核的資料'
      USING ERRCODE = 'no_data_found';
  END IF;

  RETURN jsonb_build_object(
    'changed',        v_count > 0,
    'module',         p_module,
    'previous_status', v_before
  );
END;
$$;

comment on function public.inv_approve_record(uuid, text, uuid, boolean) is
  '審核／退回一筆記錄。module 是白名單代號，表名與狀態欄位寫死在 CASE 裡（沒有動態 SQL）。只受理 pending → approved/rejected，避免把已入庫的進貨改回退回。';

revoke execute on function public.inv_approve_record(uuid, text, uuid, boolean) from public;
revoke execute on function public.inv_approve_record(uuid, text, uuid, boolean) from anon, authenticated;
grant  execute on function public.inv_approve_record(uuid, text, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 4a. inv_save_product —— 新增／編輯一件商品
-- ---------------------------------------------------------------------------
-- p_id 為 NULL = 新增，否則 = 更新。
--
-- p_payload 的每一個欄位都在下面被**逐一具名取出**。這不只是寫法問題：payload
-- 裡多送 approval_status、stock_quantity、user_id 這些 key 一律被忽略，因為根本
-- 沒有一行程式去讀它們。庫存只能由進貨／盤點改，審核狀態只能由 inv_approve_record
-- 改 —— 這兩件事在這裡是結構上做不到，不是靠記得不要做。
--
-- p_purchase（選填，只在新增時看）：{"quantity": n, "cost_price": n, "vendor": "…",
-- "purchase_date": "YYYY-MM-DD"}。來源新增商品時預設會一起建一筆進貨，庫存靠
-- inv.purchases 的 trigger 加上去。差別是來源那是兩次獨立的 HTTP 請求（商品建好、
-- 進貨失敗 → 一件永遠沒有貨的商品），這裡是同一個交易。
--
-- ── 售價／成本走調價流程 ──────────────────────────────────────────────────
-- approval_settings.price_changes 開著的時候，**編輯**既有商品的價格不會直接生效，
-- 而是寫進 pending_* 並把 price_change_status 設成 pending。新增不受影響 ——
-- 一件新商品的第一個價格不是「變更」。
create or replace function public.inv_save_product(
  p_user_id  uuid,
  p_id       uuid,
  p_payload  jsonb,
  p_purchase jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_id                  uuid;
  v_name                text;
  v_selling             numeric;
  v_cost                numeric;
  v_price_pending       boolean := false;
  v_purchase_created    boolean := false;
  v_old                 record;
  v_price_needs_approval boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_NO_OPERATOR: 必須記錄操作人員';
  END IF;

  v_name := nullif(btrim(coalesce(p_payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_NO_NAME: 請輸入商品名稱';
  END IF;

  -- 來源前端 parseFloat('')→NaN 直接寫進 DB 的老問題。這裡把空字串當成「沒填」。
  v_selling := coalesce((p_payload->>'selling_price')::numeric, 0);
  v_cost    := (p_payload->>'cost_price')::numeric;

  IF v_selling < 0 THEN
    RAISE EXCEPTION 'PRODUCT_BAD_PRICE: 售價不可為負數';
  END IF;
  IF v_cost IS NOT NULL AND v_cost < 0 THEN
    RAISE EXCEPTION 'PRODUCT_BAD_COST: 成本不可為負數';
  END IF;

  -- 母品項不能指到自己（自我參照會讓 resolve_stock_target 無限遞迴）。
  IF p_id IS NOT NULL AND (p_payload->>'base_product_id')::uuid = p_id THEN
    RAISE EXCEPTION 'PRODUCT_SELF_BASE: 母品項不能是自己';
  END IF;

  IF p_id IS NULL THEN
    -- ── 新增 ───────────────────────────────────────────────────────────────
    INSERT INTO inv.products (
      user_id, name, issue_number, barcode, category_id, product_type,
      series, publisher, selling_price, cost_price, stock_quantity,
      low_stock_alert, notes, vendor_id, pack_size, base_product_id,
      image_key, is_active, approval_status
    ) VALUES (
      p_user_id,
      v_name,
      nullif(btrim(coalesce(p_payload->>'issue_number', '')), ''),
      nullif(btrim(coalesce(p_payload->>'barcode', '')), ''),
      (p_payload->>'category_id')::uuid,
      coalesce(p_payload->>'product_type', 'outright'),
      nullif(btrim(coalesce(p_payload->>'series', '')), ''),
      nullif(btrim(coalesce(p_payload->>'publisher', '')), ''),
      v_selling,
      -- 沒有明講成本就用一起建的那筆進貨的單價。來源就是這樣做的（新增表單上
      -- 沒有成本欄位，成本是從「同時建立進貨記錄」那一區帶過來的）。
      coalesce(v_cost, nullif(p_purchase->>'cost_price', '')::numeric, 0),
      0,                                   -- ← 庫存一律從 0 開始，靠進貨加上去
      coalesce((p_payload->>'low_stock_alert')::integer, 5),
      nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
      (p_payload->>'vendor_id')::uuid,
      greatest(coalesce((p_payload->>'pack_size')::integer, 1), 1),
      (p_payload->>'base_product_id')::uuid,
      nullif(btrim(coalesce(p_payload->>'image_key', '')), ''),
      coalesce((p_payload->>'is_active')::boolean, true),
      inv.initial_approval_status('products')   -- ← 不是從 payload 拿
    )
    RETURNING id INTO v_id;

    -- 一起建進貨（庫存由 inv.purchases 的 trigger 加上去，這裡不自己動 stock）
    IF p_purchase IS NOT NULL AND coalesce((p_purchase->>'quantity')::integer, 0) > 0 THEN
      INSERT INTO inv.purchases (
        user_id, product_id, quantity, unit_cost, vendor, purchase_date,
        notes, approval_status
      ) VALUES (
        p_user_id,
        v_id,
        (p_purchase->>'quantity')::integer,
        nullif(p_purchase->>'cost_price', '')::numeric,
        nullif(btrim(coalesce(p_purchase->>'vendor', '')), ''),
        coalesce((p_purchase->>'purchase_date')::date, current_date),
        '新增商品時建立',
        inv.initial_approval_status('purchases')
      );
      v_purchase_created := true;
    END IF;

  ELSE
    -- ── 更新 ───────────────────────────────────────────────────────────────
    SELECT id, cost_price, selling_price, approval_status
      INTO v_old
      FROM inv.products
     WHERE id = p_id
       FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PRODUCT_NOT_FOUND: 找不到這件商品' USING ERRCODE = 'no_data_found';
    END IF;

    v_id := p_id;
    v_price_needs_approval :=
      (inv.initial_approval_status('price_changes') = 'pending')
      AND (v_selling IS DISTINCT FROM v_old.selling_price
           OR (v_cost IS NOT NULL AND v_cost IS DISTINCT FROM v_old.cost_price));

    UPDATE inv.products
       SET name            = v_name,
           issue_number    = nullif(btrim(coalesce(p_payload->>'issue_number', '')), ''),
           barcode         = nullif(btrim(coalesce(p_payload->>'barcode', '')), ''),
           category_id     = (p_payload->>'category_id')::uuid,
           product_type    = coalesce(p_payload->>'product_type', product_type),
           series          = nullif(btrim(coalesce(p_payload->>'series', '')), ''),
           publisher       = nullif(btrim(coalesce(p_payload->>'publisher', '')), ''),
           low_stock_alert = coalesce((p_payload->>'low_stock_alert')::integer, 5),
           notes           = nullif(btrim(coalesce(p_payload->>'notes', '')), ''),
           vendor_id       = (p_payload->>'vendor_id')::uuid,
           pack_size       = greatest(coalesce((p_payload->>'pack_size')::integer, 1), 1),
           base_product_id = (p_payload->>'base_product_id')::uuid,
           image_key       = nullif(btrim(coalesce(p_payload->>'image_key', '')), ''),
           -- 價格：要審核就進待審欄位，不要審核就直接生效
           selling_price   = CASE WHEN v_price_needs_approval THEN selling_price ELSE v_selling END,
           cost_price      = CASE WHEN v_price_needs_approval THEN cost_price
                                  ELSE coalesce(v_cost, cost_price) END,
           pending_selling_price = CASE WHEN v_price_needs_approval THEN v_selling ELSE pending_selling_price END,
           pending_cost_price    = CASE WHEN v_price_needs_approval THEN coalesce(v_cost, cost_price) ELSE pending_cost_price END,
           price_change_status        = CASE WHEN v_price_needs_approval THEN 'pending' ELSE price_change_status END,
           price_change_requested_by  = CASE WHEN v_price_needs_approval THEN p_user_id ELSE price_change_requested_by END,
           price_change_requested_at  = CASE WHEN v_price_needs_approval THEN now() ELSE price_change_requested_at END
     WHERE id = p_id;

    v_price_pending := coalesce(v_price_needs_approval, false);
  END IF;

  RETURN jsonb_build_object(
    'id',                v_id,
    'created',           p_id IS NULL,
    'purchase_created',  v_purchase_created,
    'price_change_pending', v_price_pending
  );
END;
$$;

comment on function public.inv_save_product(uuid, uuid, jsonb, jsonb) is
  '新增／編輯商品。payload 逐欄具名取出，所以 approval_status／stock_quantity／user_id 就算送進來也會被忽略。價格變更在 approval_settings.price_changes 開啟時走待審。';

revoke execute on function public.inv_save_product(uuid, uuid, jsonb, jsonb) from public;
revoke execute on function public.inv_save_product(uuid, uuid, jsonb, jsonb) from anon, authenticated;
grant  execute on function public.inv_save_product(uuid, uuid, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 4b. inv_set_product_active —— 停用／恢復
-- ---------------------------------------------------------------------------
-- 停用不是刪除：庫存、進貨、銷售紀錄、成本全部留著，只是不能再賣（0014 的
-- inv_pos_products view 有 `where p.is_active`，pos_checkout() 也會再擋一次）。
--
-- 回傳有沒有連著型錄商品 —— 停用一件還掛在網站上的商品，網站那一頁會變成
-- 「買得下去但櫃檯賣不出來」，UI 要能當場講這句話。
create or replace function public.inv_set_product_active(
  p_user_id   uuid,
  p_id        uuid,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_name   text;
  v_listed integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_NO_OPERATOR: 必須記錄操作人員';
  END IF;

  UPDATE inv.products SET is_active = p_is_active WHERE id = p_id
  RETURNING name INTO v_name;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND: 找不到這件商品' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT count(*) INTO v_listed
    FROM public.product_inventory_links l
    JOIN public.products p ON p.id = l.product_id AND p.status = 'active'
   WHERE l.inv_product_id = p_id;

  RETURN jsonb_build_object('id', p_id, 'name', v_name, 'is_active', p_is_active, 'listed_count', v_listed);
END;
$$;

comment on function public.inv_set_product_active(uuid, uuid, boolean) is
  '停用／恢復一件商品。回傳它目前還掛在幾個上架中的型錄商品上，讓 UI 當場提醒。';

revoke execute on function public.inv_set_product_active(uuid, uuid, boolean) from public;
revoke execute on function public.inv_set_product_active(uuid, uuid, boolean) from anon, authenticated;
grant  execute on function public.inv_set_product_active(uuid, uuid, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 4b-2. inv_resubmit_product —— 被退回之後改完再送一次
-- ---------------------------------------------------------------------------
-- 只認 rejected → pending 這一個方向。approved 的不能自己打回 pending（那等於
-- 任何人都可以把一件已經上架在賣的商品變成待審），pending 的重送是 no-op。
--
-- approved_by / approved_at 一起清掉：留著的話畫面上會出現「待審核，審核人：某某」，
-- 那是上一輪的資料，看的人會以為已經有人看過了。
create or replace function public.inv_resubmit_product(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_name  text;
  v_count integer;
BEGIN
  SELECT name INTO v_name FROM inv.products WHERE id = p_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND: 找不到這件商品' USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE inv.products
     SET approval_status = 'pending',
         approved_by     = NULL,
         approved_at     = NULL
   WHERE id = p_id AND approval_status = 'rejected';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'PRODUCT_NOT_REJECTED: 只有被退回的商品可以重新送審'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN jsonb_build_object('id', p_id, 'name', v_name, 'resubmitted', true);
END;
$$;

comment on function public.inv_resubmit_product(uuid) is
  '把一件被退回的商品打回 pending。只認 rejected → pending，並清掉上一輪的 approved_by/at。';

revoke execute on function public.inv_resubmit_product(uuid) from public;
revoke execute on function public.inv_resubmit_product(uuid) from anon, authenticated;
grant  execute on function public.inv_resubmit_product(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4c. inv_delete_product —— 真的刪掉
-- ---------------------------------------------------------------------------
-- 來源有這個動作，所以搬過來，但先擋兩件事：賣過的、還掛在型錄上的，一律不准刪。
--
-- 理由是外鍵不會替你擋。inv.sales.product_id 是 ON DELETE SET NULL —— 刪掉商品
-- 之後那些銷售紀錄不會消失，只會變成「不知道賣的是什麼」的孤兒列，毛利報表跟著
-- 少一塊，而且沒有任何地方會報錯。停用才是這種情況的正確動作。
create or replace function public.inv_delete_product(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_name  text;
  v_sales integer;
  v_links integer;
BEGIN
  SELECT name INTO v_name FROM inv.products WHERE id = p_id;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND: 找不到這件商品' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT count(*) INTO v_sales FROM inv.sales  WHERE product_id = p_id;
  SELECT count(*) INTO v_links FROM public.product_inventory_links WHERE inv_product_id = p_id;

  IF v_sales > 0 THEN
    RAISE EXCEPTION 'PRODUCT_HAS_SALES: 「%」已經有 % 筆銷售紀錄，不能刪除。請改用「停用」。', v_name, v_sales
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_links > 0 THEN
    RAISE EXCEPTION 'PRODUCT_IS_LISTED: 「%」還連著店面型錄商品，請先在「上架」頁下架。', v_name
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM inv.products WHERE id = p_id;
  RETURN jsonb_build_object('id', p_id, 'name', v_name, 'deleted', true);
END;
$$;

comment on function public.inv_delete_product(uuid) is
  '刪除商品。賣過的、還掛在型錄上的一律擋下（外鍵是 SET NULL，不會替你擋，只會留下孤兒銷售列）。';

revoke execute on function public.inv_delete_product(uuid) from public;
revoke execute on function public.inv_delete_product(uuid) from anon, authenticated;
grant  execute on function public.inv_delete_product(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4d. inv_request_price_change —— 送出調價
-- ---------------------------------------------------------------------------
-- pending_cost_price / pending_selling_price / price_change_status 這組欄位在來源
-- 系統是**死欄位**：migration 建了它們、approval_settings 也放了 price_changes、
-- useUserPermissions 也定義了 approve_price_changes，但整個 src/ 沒有任何一行寫過
-- 它們（993 筆商品的 price_change_status 全部是 NULL）。
--
-- 所以這一支不是「搬過來」，是把那組欄位、那個開關、那個權限第一次接起來，語意
-- 照它們的名字：送出 → pending → 核准後才生效。
--
-- approval_settings.price_changes 關掉的時候直接生效（與 initial_approval_status
-- 同一條規矩，而且一樣 fail-closed：查不到設定就是要審核）。
create or replace function public.inv_request_price_change(
  p_user_id       uuid,
  p_id            uuid,
  p_cost_price    numeric,
  p_selling_price numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_name     text;
  v_needs    boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'PRICE_NO_OPERATOR: 必須記錄操作人員';
  END IF;
  IF p_selling_price IS NULL OR p_selling_price < 0 THEN
    RAISE EXCEPTION 'PRICE_BAD_SELLING: 售價不可為空或負數';
  END IF;
  IF p_cost_price IS NOT NULL AND p_cost_price < 0 THEN
    RAISE EXCEPTION 'PRICE_BAD_COST: 成本不可為負數';
  END IF;

  SELECT name INTO v_name FROM inv.products WHERE id = p_id FOR UPDATE;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND: 找不到這件商品' USING ERRCODE = 'no_data_found';
  END IF;

  v_needs := inv.initial_approval_status('price_changes') = 'pending';

  IF v_needs THEN
    UPDATE inv.products
       SET pending_cost_price        = coalesce(p_cost_price, cost_price),
           pending_selling_price     = p_selling_price,
           price_change_status       = 'pending',
           price_change_requested_by = p_user_id,
           price_change_requested_at = now()
     WHERE id = p_id;
  ELSE
    UPDATE inv.products
       SET cost_price                = coalesce(p_cost_price, cost_price),
           selling_price             = p_selling_price,
           pending_cost_price        = NULL,
           pending_selling_price     = NULL,
           price_change_status       = 'approved',
           price_change_requested_by = p_user_id,
           price_change_requested_at = now()
     WHERE id = p_id;
  END IF;

  RETURN jsonb_build_object('id', p_id, 'name', v_name, 'pending', v_needs);
END;
$$;

comment on function public.inv_request_price_change(uuid, uuid, numeric, numeric) is
  '送出調價。approval_settings.price_changes 開著就進 pending_*（核准後才生效），關著就直接改。來源系統從來沒有寫過這組欄位。';

revoke execute on function public.inv_request_price_change(uuid, uuid, numeric, numeric) from public;
revoke execute on function public.inv_request_price_change(uuid, uuid, numeric, numeric) from anon, authenticated;
grant  execute on function public.inv_request_price_change(uuid, uuid, numeric, numeric) to service_role;

-- ---------------------------------------------------------------------------
-- 4e. inv_import_products —— Excel 匯入
-- ---------------------------------------------------------------------------
-- 來源是「前端 for 迴圈，每一列各兩三次 HTTP」：1,000 列就是 2,000 次請求，中途
-- 網路斷掉就留下一半的資料，而且失敗的那幾列只有一個 toast 說「N 筆失敗」。
--
-- 這裡整批進來一次，一個交易：要嘛整批成立，要嘛什麼都沒發生。
--
-- p_rows: [{"name": "…", "issue_number": "…", "barcode": "…", "selling_price": n,
--           "cost_price": n, "quantity": n, "series": "…", "publisher": "…",
--           "notes": "…", "existing_product_id": "<uuid|null>"}, …]
--
-- existing_product_id 由前端的比對決定（條碼 / 名稱+期數+系列 / 名稱），因為那份
-- 比對規則本來就要在預覽畫面上讓人逐列確認。但**它只是一個 id** —— 這裡會再查
-- 一次它存不存在，不存在就當成新增，不會憑空更新一列。
create or replace function public.inv_import_products(
  p_user_id uuid,
  p_rows    jsonb,
  p_options jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_row          jsonb;
  v_name         text;
  v_existing     uuid;
  v_product_id   uuid;
  v_created      integer := 0;
  v_updated      integer := 0;
  v_purchases    integer := 0;
  v_qty          integer;
  v_cost         numeric;
  v_selling      numeric;
  v_status       text;
  v_pstatus      text;
  v_make_purchase boolean;
  v_category     uuid;
  v_ptype        text;
  v_vendor       text;
  v_pdate        date;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'IMPORT_NO_OPERATOR: 必須記錄操作人員';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'IMPORT_EMPTY: 沒有要匯入的資料';
  END IF;
  IF jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'IMPORT_TOO_MANY: 一次最多匯入 2000 列，請分批';
  END IF;

  -- 每一批只算一次，不要在迴圈裡查 2000 次 approval_settings。
  v_status  := inv.initial_approval_status('products');
  v_pstatus := inv.initial_approval_status('purchases');

  v_make_purchase := coalesce((p_options->>'create_purchase_record')::boolean, false);
  v_category      := (p_options->>'category_id')::uuid;
  v_ptype         := coalesce(p_options->>'product_type', 'outright');
  v_vendor        := nullif(btrim(coalesce(p_options->>'vendor', '')), '');
  v_pdate         := coalesce((p_options->>'purchase_date')::date, current_date);

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_name := nullif(btrim(coalesce(v_row->>'name', '')), '');
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'IMPORT_NO_NAME: 有一列沒有商品名稱';
    END IF;

    v_qty     := greatest(coalesce((v_row->>'quantity')::integer, 0), 0);
    v_cost    := nullif(v_row->>'cost_price', '')::numeric;
    v_selling := coalesce(nullif(v_row->>'selling_price', '')::numeric, 0);

    IF v_selling < 0 OR coalesce(v_cost, 0) < 0 THEN
      RAISE EXCEPTION 'IMPORT_BAD_PRICE: 「%」的價格是負數', v_name;
    END IF;

    -- 前端說這一列對到既有商品 —— 這裡再確認一次它真的存在。
    v_existing := NULL;
    IF nullif(v_row->>'existing_product_id', '') IS NOT NULL THEN
      SELECT id INTO v_existing FROM inv.products
       WHERE id = (v_row->>'existing_product_id')::uuid;
    END IF;

    IF v_existing IS NOT NULL THEN
      -- 既有商品只動價格，而且只在有填的時候動。**不碰 stock_quantity**：
      -- 庫存要靠下面那筆進貨加上去，直接改會讓 FIFO 的 remaining_quantity 對不起來。
      UPDATE inv.products
         SET selling_price = CASE WHEN v_selling > 0 THEN v_selling ELSE selling_price END,
             cost_price    = CASE WHEN coalesce(v_cost, 0) > 0 THEN v_cost ELSE cost_price END
       WHERE id = v_existing;
      v_product_id := v_existing;
      v_updated := v_updated + 1;
    ELSE
      INSERT INTO inv.products (
        user_id, name, issue_number, barcode, category_id, product_type,
        series, publisher, selling_price, cost_price, stock_quantity,
        low_stock_alert, notes, approval_status
      ) VALUES (
        p_user_id,
        v_name,
        nullif(btrim(coalesce(v_row->>'issue_number', '')), ''),
        -- 來源把條碼塞進 notes 而沒有寫進 barcode 欄位，於是下一次匯入的條碼比對
        -- 永遠對不到自己上次匯進來的東西。這裡寫進正確的欄位。
        nullif(btrim(coalesce(v_row->>'barcode', '')), ''),
        v_category,
        v_ptype,
        nullif(btrim(coalesce(v_row->>'series', '')), ''),
        nullif(btrim(coalesce(v_row->>'publisher', '')), ''),
        v_selling,
        coalesce(v_cost, 0),
        -- 有要建進貨就從 0 開始（trigger 會加上去），否則直接寫進來的數量。
        CASE WHEN v_make_purchase THEN 0 ELSE v_qty END,
        5,
        nullif(btrim(coalesce(v_row->>'notes', '')), ''),
        v_status
      )
      RETURNING id INTO v_product_id;
      v_created := v_created + 1;
    END IF;

    IF v_make_purchase AND v_qty > 0 THEN
      INSERT INTO inv.purchases (
        user_id, product_id, quantity, unit_cost, vendor, purchase_date, notes, approval_status
      ) VALUES (
        p_user_id, v_product_id, v_qty, v_cost, v_vendor, v_pdate,
        'Excel 匯入' || coalesce(' - 供應商: ' || v_vendor, ''), v_pstatus
      );
      v_purchases := v_purchases + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'created',   v_created,
    'updated',   v_updated,
    'purchases', v_purchases,
    'approval_status', v_status
  );
END;
$$;

comment on function public.inv_import_products(uuid, jsonb, jsonb) is
  'Excel 匯入。整批一個交易（來源是前端 for 迴圈，每列各兩三次 HTTP，中途斷線就留下一半）。條碼寫進 barcode 欄位而不是塞進 notes。';

revoke execute on function public.inv_import_products(uuid, jsonb, jsonb) from public;
revoke execute on function public.inv_import_products(uuid, jsonb, jsonb) from anon, authenticated;
grant  execute on function public.inv_import_products(uuid, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 4f. inv_batch_update_products —— 批次改分類／類型／供應商／價格
-- ---------------------------------------------------------------------------
-- p_patch 只認得五個 key，其他一律忽略：
--   category_id / product_type / vendor_id  → 直接指定（'none' 代表清成 NULL）
--   selling_price / cost_price              → {"mode":"set|percent|amount","value":n}
--
-- 價格一樣走調價規則：要審核就進 pending_*。批次調價是最容易出事的操作
-- （一次改 200 件），所以它更該有審核，不是更不該。
create or replace function public.inv_batch_update_products(
  p_user_id uuid,
  p_ids     uuid[],
  p_patch   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_count   integer := 0;
  v_needs   boolean;
  v_has_price boolean;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'BATCH_NO_OPERATOR: 必須記錄操作人員';
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'BATCH_EMPTY: 沒有選取任何商品';
  END IF;
  IF array_length(p_ids, 1) > 500 THEN
    RAISE EXCEPTION 'BATCH_TOO_MANY: 一次最多 500 件';
  END IF;

  v_has_price := (p_patch ? 'selling_price') OR (p_patch ? 'cost_price');
  v_needs := v_has_price AND inv.initial_approval_status('price_changes') = 'pending';

  UPDATE inv.products p
     SET category_id  = CASE WHEN p_patch ? 'category_id'
                             THEN nullif(p_patch->>'category_id', 'none')::uuid
                             ELSE p.category_id END,
         product_type = CASE WHEN p_patch ? 'product_type'
                             THEN p_patch->>'product_type'
                             ELSE p.product_type END,
         vendor_id    = CASE WHEN p_patch ? 'vendor_id'
                             THEN nullif(p_patch->>'vendor_id', 'none')::uuid
                             ELSE p.vendor_id END,

         selling_price = CASE
           WHEN NOT (p_patch ? 'selling_price') OR v_needs THEN p.selling_price
           ELSE greatest(inv.apply_price_op(p.selling_price, p_patch->'selling_price'), 0) END,
         cost_price = CASE
           WHEN NOT (p_patch ? 'cost_price') OR v_needs THEN p.cost_price
           ELSE greatest(inv.apply_price_op(p.cost_price, p_patch->'cost_price'), 0) END,

         pending_selling_price = CASE
           WHEN v_needs AND (p_patch ? 'selling_price')
           THEN greatest(inv.apply_price_op(p.selling_price, p_patch->'selling_price'), 0)
           ELSE p.pending_selling_price END,
         pending_cost_price = CASE
           WHEN v_needs AND (p_patch ? 'cost_price')
           THEN greatest(inv.apply_price_op(p.cost_price, p_patch->'cost_price'), 0)
           ELSE p.pending_cost_price END,
         price_change_status       = CASE WHEN v_needs THEN 'pending' ELSE p.price_change_status END,
         price_change_requested_by = CASE WHEN v_needs THEN p_user_id ELSE p.price_change_requested_by END,
         price_change_requested_at = CASE WHEN v_needs THEN now() ELSE p.price_change_requested_at END
   WHERE p.id = ANY (p_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_count, 'price_change_pending', v_needs);
END;
$$;

-- 批次調價的三種算法。抽出來是因為上面那個 UPDATE 要用它四次。
create or replace function inv.apply_price_op(p_current numeric, p_op jsonb)
returns numeric
language sql
immutable
as $$
  select case coalesce(p_op->>'mode', 'set')
           when 'percent' then round(coalesce(p_current, 0) * (1 + coalesce((p_op->>'value')::numeric, 0) / 100), 2)
           when 'amount'  then coalesce(p_current, 0) + coalesce((p_op->>'value')::numeric, 0)
           else coalesce((p_op->>'value')::numeric, 0)
         end;
$$;

comment on function inv.apply_price_op(numeric, jsonb) is
  '批次調價的算法：set=直接指定、percent=加減百分比、amount=加減金額。';
comment on function public.inv_batch_update_products(uuid, uuid[], jsonb) is
  '批次改分類／類型／供應商／價格。patch 只認得五個 key，其他忽略。價格一樣走調價審核 —— 一次改 200 件更該有審核，不是更不該。';

revoke execute on function inv.apply_price_op(numeric, jsonb) from public;
revoke execute on function inv.apply_price_op(numeric, jsonb) from anon, authenticated;
grant  execute on function inv.apply_price_op(numeric, jsonb) to service_role;
revoke execute on function public.inv_batch_update_products(uuid, uuid[], jsonb) from public;
revoke execute on function public.inv_batch_update_products(uuid, uuid[], jsonb) from anon, authenticated;
grant  execute on function public.inv_batch_update_products(uuid, uuid[], jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 5. 四個唯讀 view
-- ---------------------------------------------------------------------------
-- 理由與 0012／0014 完全相同：inv 不在 PostgREST 的 db_schema 裡，service_role 的
-- supabase-js client 打不到 inv.*。
--
-- ⚠️ 全部 security_invoker = false，所以 grant 給誰就是全部的防線。

-- 5a. inv_admin_products —— 商品主檔清單
--
-- 與 0014 的 inv_pos_products 不同：那一支只給**賣得動的**（is_active + approved +
-- 非租借），這一支要給全部 —— 待審的、停用的、租借的都要看得到，那正是這一頁的工作。
create or replace view public.inv_admin_products
with (security_invoker = false) as
select
  p.id                        as inv_product_id,
  p.name                      as name,
  p.issue_number              as issue_number,
  p.barcode                   as barcode,
  p.series                    as series,
  p.publisher                 as publisher,
  p.notes                     as notes,
  p.image_key                 as image_key,
  p.product_type              as product_type,
  p.selling_price             as selling_price,
  p.cost_price                as cost_price,
  p.stock_quantity            as stock_quantity,
  p.low_stock_alert           as low_stock_alert,
  p.pack_size                 as pack_size,
  p.is_active                 as is_active,
  p.category_id               as category_id,
  c.name                      as category_name,
  c.icon                      as category_icon,
  p.vendor_id                 as vendor_id,
  v.name                      as vendor_name,
  v.short_name                as vendor_short_name,
  p.base_product_id           as base_product_id,
  bp.name                     as base_product_name,
  p.approval_status           as approval_status,
  p.approved_at               as approved_at,
  approver.name               as approved_by_name,
  p.pending_cost_price        as pending_cost_price,
  p.pending_selling_price     as pending_selling_price,
  p.price_change_status       as price_change_status,
  p.price_change_requested_at as price_change_requested_at,
  requester.name              as price_change_requested_by_name,
  p.user_id                   as user_id,
  creator.name                as creator_name,
  p.created_at                as created_at,
  p.updated_at                as updated_at,
  -- 網站保留中的數量。母品項的保留也算在母品項上（保留 ledger 記的就是目標列）。
  coalesce(res.qty, 0)        as reserved,
  greatest(0, p.stock_quantity - coalesce(res.qty, 0)) as available,
  -- 有沒有掛在店面型錄上。停用／刪除前要看得到這件事。
  link.product_id             as listed_product_id,
  listed.slug                 as listed_slug,
  listed.status               as listed_status
from inv.products p
left join inv.categories c        on c.id  = p.category_id
left join inv.vendors    v        on v.id  = p.vendor_id
left join inv.products   bp       on bp.id = p.base_product_id
left join inv.profiles   creator  on creator.user_id  = p.user_id
left join inv.profiles   approver on approver.user_id = p.approved_by
left join inv.profiles   requester on requester.user_id = p.price_change_requested_by
left join lateral (
  select sum(s.quantity)::integer as qty
    from public.stock_reservations s
   where s.inv_product_id = p.id
) res on true
left join public.product_inventory_links link on link.inv_product_id = p.id
left join public.products listed              on listed.id = link.product_id;

comment on view public.inv_admin_products is
  '商品主檔（全部，含待審／停用／租借）。與 inv_pos_products 的差別是那一支只給賣得動的。只給 service_role。';

-- 5b. inv_admin_categories
create or replace view public.inv_admin_categories
with (security_invoker = false) as
select c.id as category_id, c.name as name, c.icon as icon, c.display_order as display_order
from inv.categories c;

comment on view public.inv_admin_categories is
  '商品分類下拉選單用。只給 service_role。';

-- 5c. inv_admin_vendors
--
-- ⚠️ 這個 view 的欄位清單是**安全邊界**，不是方便性選擇。inv.vendors 有 48 欄，
--    其中 id_number（身分證字號）、tax_id、foreign_id、residence_permit_number、
--    銀行帳戶（另一張表）就是 0009 §0 決定不把 inv 掛上 PostgREST 的原因。
--    商品頁需要的只有「這家叫什麼」，所以這裡只開六欄。
--    要加欄位之前先問：這一欄出現在瀏覽器裡會怎樣。
create or replace view public.inv_admin_vendors
with (security_invoker = false) as
select
  v.id              as vendor_id,
  v.name            as name,
  v.short_name      as short_name,
  v.is_consignment  as is_consignment,
  v.status          as status,
  v.approval_status as approval_status
from inv.vendors v;

comment on view public.inv_admin_vendors is
  '供應商下拉選單用。只開六欄 —— inv.vendors 另外 42 欄含身分證字號與稅籍，那正是 inv 沒有掛上 PostgREST 的原因。只給 service_role。';

-- 5d. inv_admin_approval_settings
create or replace view public.inv_admin_approval_settings
with (security_invoker = false) as
select s.module as module, s.is_enabled as is_enabled, s.updated_at as updated_at
from inv.approval_settings s;

comment on view public.inv_admin_approval_settings is
  '每個模組要不要審核。查不到某個 module 時前端一律當成「要審核」（與 inv.initial_approval_status 同一條 fail-closed 規矩）。只給 service_role。';

-- ---------------------------------------------------------------------------
-- 6. 權限
-- ---------------------------------------------------------------------------
-- ⚠️ revoke 才是真正生效的那一半。Supabase 對 public schema 有 ALTER DEFAULT
--    PRIVILEGES，新建的 view 一出生就對 anon/authenticated 是 ALL —— 只下
--    `grant select to service_role` 會留下那個 ALL。0013 就是在修這個坑。
revoke all on public.inv_admin_products          from anon, authenticated;
revoke all on public.inv_admin_categories        from anon, authenticated;
revoke all on public.inv_admin_vendors           from anon, authenticated;
revoke all on public.inv_admin_approval_settings from anon, authenticated;

grant select on public.inv_admin_products          to service_role;
grant select on public.inv_admin_categories        to service_role;
grant select on public.inv_admin_vendors           to service_role;
grant select on public.inv_admin_approval_settings to service_role;

commit;

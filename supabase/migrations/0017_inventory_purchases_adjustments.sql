-- 0017_inventory_purchases_adjustments.sql —— 進貨、庫存盤點、在庫異動，搬進後台
--
-- 0016 讓店員維護商品主檔；這一份讓他們**讓庫存動起來**：進貨入庫、盤點校正、
-- 六類在庫異動（報廢／公關／樣品／內部／盤點／組合）。
--
-- 前一個 migration：0016_inventory_products_admin.sql。既有 0001–0016 一律不動。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 這個檔案要解掉三個資料模型問題，不是三個搬運問題
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── 問題一：inventory_adjustments 與 stock_adjustments 哪張是真相 ──────────
--
-- 兩張表都有「盤點」的語意，來源前端也兩張都碰。查完資料與程式碼，答案是
-- **inv.stock_adjustments**，理由四條：
--
--   1. 資料自己講話。inv.inventory_adjustments 最後一筆寫入是 2026-03-02（30 筆，
--      全部 approved）；inv.stock_adjustments 一路寫到 2026-08-15（50 筆）。
--      前者停了五個月，後者還在跑。
--   2. 來源前端**沒有任何一處寫 inventory_adjustments**（只剩 4 處讀）。那兩支
--      盤點對話框（InventoryAdjustmentDialog / BatchInventoryAdjustmentDialog）
--      寫的是 stock_adjustments，`category` 固定 'ADJ'。來源自己的 changelog 寫著
--      「盤點調整不再寫入舊的 inventory_adjustments 表，統一使用 stock_adjustments」。
--   3. 能力差一截。stock_adjustments 有單號、有 draft/pending_approval/confirmed/
--      rejected 的狀態機、有 reversal_of 沖銷、有六類；inventory_adjustments 只有
--      shrinkage/surplus 兩個值，沒單號沒狀態機，連 stock_before 都是全 NULL。
--   4. 這個專案自己已經選過一次了。2026-08 搬遷時要把一個負庫存歸零，補的是
--      stock_adjustments 的 ADJ-20260815-057，不是 inventory_adjustments。
--
-- 所以：**新的寫入一律進 inv.stock_adjustments，一筆都不寫 inventory_adjustments**
-- （兩張都寫 = 同一次盤點扣兩次庫存，那正是要避免的事）。
--
-- 那 30 筆舊資料呢？不刪、不搬、不改，就地凍結成歷史。商品詳細頁改讀
-- public.inv_admin_product_movements —— 一個把兩張表 union 起來的唯讀 view。
-- 於是「剛做完的盤點在商品詳細頁看不到」被修好，而 1–3 月那 30 筆也還在。
--
-- ── 問題二：來源的盤點對話框繞過審核 ──────────────────────────────────────
--
-- 那兩支盤點對話框都 import 了 getInitialApprovalStatus 卻沒有用，status 硬寫
-- 'confirmed'。也就是不管 approval_settings.stock_adjustments 開不開，盤點永遠
-- 直接生效。而同一張表的「新增異動」卻會進 pending_approval —— 同一張表兩條路。
--
-- 這裡的修法與 0016 對 products 的修法逐字相同：初始狀態**在資料庫算**。
-- inv.stock_adjustment_initial_status() 讀 inv.initial_approval_status（0016 建的
-- 那支 fail-closed 函式），把它的 'pending'/'approved' 轉成這張表的
-- 'pending_approval'/'confirmed'。下面每一支寫入函式都呼叫它，**呼叫端沒有辦法
-- 指定 status**，payload 裡就算送了 status 這個 key 也沒有一行程式去讀它。
--
-- ── 問題三：進貨與 FIFO 對不起來 ──────────────────────────────────────────
--
-- inv.purchases.remaining_quantity 是 FIFO 的消耗欄位（allocate_fifo_cost 從最舊的
-- 批次往下扣）。0009 的 update_stock_on_purchase() 只在「INSERT」與「核准那一刻」
-- 設定它，之後就再也不管了。實測（本機 PG 18 跑 0001–0016）：
--
--     進貨 10 → stock=10, remaining=10
--     賣掉 4  → stock=6,  remaining=6      ← FIFO 吃掉 4
--     UPDATE quantity 10→20 → stock=6, remaining=6   ← 兩個都沒動
--        此時 quantity=20 但 remaining=6，等於宣稱「這批 20 件已經消耗了 14 件」，
--        實際只賣了 4 件。後面的 FIFO 分攤會少算 10 件的成本。
--     DELETE 這筆進貨 → stock=6                       ← 貨的來源沒了，庫存還在
--
-- 修法不是重寫 FIFO（FIFO 本身是對的），是把缺掉的兩條路徑補進 trigger：
--   · update_stock_on_purchase() 加一段「數量改了」的分支：算出已消耗量，
--     remaining_quantity 重新對齊，庫存補差額；新數量小於已消耗量就 RAISE。
--   · 新增 BEFORE DELETE 的 rollback_stock_on_purchase_delete()：已經被賣掉的
--     批次不准刪（RAISE），沒被賣過的刪掉時把庫存收回去。
--
-- 放在 trigger 而不是 RPC 裡，是因為 0016 已經立了規矩「庫存由 trigger 加減，
-- RPC 不要自己動 stock_quantity」，而且 trigger 連手打 SQL 都繞不過去。
--
-- ── 順手修掉的一個 0016 缺口 ──────────────────────────────────────────────
--
-- 0016 的 inv_approve_record() 在 stock_adjustments 分支寫的是
-- `WHERE id = p_id AND status IN ('draft', 'pending')`，但這張表的待審狀態叫
-- **'pending_approval'**（50 筆裡有 8 筆是這個值）。'pending' 這個值在這張表
-- 從來不存在，所以核准一筆待審的異動單會靜默回 changed=false，庫存不動。
-- 本機實測回傳：{"module": "stock_adjustments", "changed": false,
--                "previous_status": "pending_approval"}
-- 0016 不能改，所以這裡 create or replace 換掉那支函式（只動這一個分支的字串，
-- 外加下面講的 FIFO 那一段）。
--
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- ---------------------------------------------------------------------------
-- 1. inv.stock_adjustments 補兩欄
-- ---------------------------------------------------------------------------
-- reason：來源把「遺失／損壞／盤點誤差／退貨入庫／樣品取用／其他」六個原因
--   **串成中文字串塞進 notes**（`盤點調整（盤點誤差）：…`）。字串沒辦法篩選也
--   沒辦法統計，而 inv.inventory_adjustments 本來就有一個 reason 欄位 —— 補上
--   之後兩張表才對得起來，下面的 union view 也才有共同欄位。
-- stock_before：盤點當下的帳面數量。走審核的盤點單從送審到核准之間庫存可能被
--   別的單動過，沒有這一欄事後就查不出「當時帳面是多少」。inventory_adjustments
--   有這一欄（雖然 30 筆全是 NULL），這裡把它做成真的有值。
alter table inv.stock_adjustments
  add column if not exists reason       text,
  add column if not exists stock_before integer;

comment on column inv.stock_adjustments.reason is
  '調整原因代碼（loss/damage/count_error/return/sample/other）。來源把它串進 notes 字串裡，那樣沒辦法篩選。';
comment on column inv.stock_adjustments.stock_before is
  '這一筆異動建立當下 inv.products.stock_quantity 的值。走審核的單子事後要查得出當時帳面是多少。';

-- reason 的白名單。與來源 ADJUSTMENT_REASONS 的六個 value 逐字對齊。
-- NULL 允許：50 筆舊資料沒有這一欄，而且非盤點類的異動（報廢／公關…）本來就
-- 用 category 表達原因，不需要再填一次。
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'inv.stock_adjustments'::regclass
       and conname  = 'stock_adjustments_reason_check'
  ) then
    alter table inv.stock_adjustments
      add constraint stock_adjustments_reason_check
      check (reason is null or reason = any (array[
        'loss', 'damage', 'count_error', 'return', 'sample', 'other'
      ]));
  end if;
end $$;

-- category 與 status 的白名單。0009 搬進來的時候這兩欄**沒有 CHECK** —— 也就是
-- 現在寫得進 category='DROP TABLE' 或 status='approved'（後者更危險：狀態機的
-- 每一個 trigger 都在比對字串，寫進一個沒人認得的值就等於這筆單永遠卡住）。
-- 既有 50 筆的值域是 {ADJ,EXP,INT,PR} × {confirmed,pending_approval,rejected}，
-- 都在白名單內，所以加 CHECK 不會擋到既有資料。
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'inv.stock_adjustments'::regclass
       and conname  = 'stock_adjustments_category_check'
  ) then
    alter table inv.stock_adjustments
      add constraint stock_adjustments_category_check
      check (category = any (array['EXP', 'PR', 'SMP', 'INT', 'ADJ', 'CMB']));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'inv.stock_adjustments'::regclass
       and conname  = 'stock_adjustments_status_check'
  ) then
    alter table inv.stock_adjustments
      add constraint stock_adjustments_status_check
      check (status = any (array['draft', 'pending_approval', 'confirmed', 'rejected']));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1b. inv.inventory_adjustments 就地凍結
-- ---------------------------------------------------------------------------
-- 上面那段檔頭講了為什麼真相是 stock_adjustments。但「我們決定不寫那一張」與
-- 「那一張寫不進去」是兩件事 —— 前者只是這一次的共識，下一個人（或下一個
-- agent）看到 ProductDetailDialog 讀的是舊表，很可能就順手往那裡插一筆，然後
-- 同一次盤點被扣兩次，而且**沒有任何地方會報錯**。
--
-- 所以把決定做成守衛。UPDATE 與 DELETE 都留著（30 筆歷史要能被退回、被修），
-- 只擋 INSERT。
create or replace function inv.freeze_inventory_adjustments() returns trigger
    language plpgsql
    security definer
    set search_path to 'inv', 'public'
    as $$
BEGIN
  RAISE EXCEPTION
    'INVENTORY_ADJUSTMENTS_FROZEN: inv.inventory_adjustments 已於 0017 凍結（最後一筆 2026-03-02）。盤點與在庫異動一律寫 inv.stock_adjustments —— 兩張都寫等於同一次盤點扣兩次庫存。歷史資料請讀 public.inv_admin_product_movements。'
    USING ERRCODE = 'check_violation';
END;
$$;

comment on function inv.freeze_inventory_adjustments() is
  '擋住所有新的 INSERT。理由見 0017 檔頭「問題一」：兩張異動表都寫會讓同一次盤點扣兩次庫存。UPDATE/DELETE 不擋，30 筆歷史還要能修。';

drop trigger if exists freeze_inventory_adjustments on inv.inventory_adjustments;
create trigger freeze_inventory_adjustments
  before insert on inv.inventory_adjustments
  for each row execute function inv.freeze_inventory_adjustments();

-- ---------------------------------------------------------------------------
-- 2. inv.stock_adjustment_initial_status() —— 問題二的修法
-- ---------------------------------------------------------------------------
-- inv.initial_approval_status()（0016 建的）回的是 'pending'/'approved'，那是
-- approval_status 欄位的值域。inv.stock_adjustments 用的是 status 欄位，值域是
-- 'pending_approval'/'confirmed'。這支就是那個轉接頭。
--
-- fail-closed 的語意完全繼承：查不到設定 → 'pending' → 'pending_approval'。
create or replace function inv.stock_adjustment_initial_status()
returns text
language sql
stable
security definer
set search_path to 'inv', 'public'
as $$
  select case inv.initial_approval_status('stock_adjustments')
           when 'pending' then 'pending_approval'
           else 'confirmed'
         end;
$$;

comment on function inv.stock_adjustment_initial_status() is
  '新建一筆在庫異動／盤點單該用的 status。承接 inv.initial_approval_status(''stock_adjustments'') 的 fail-closed 語意，只是把值域換成這張表的 pending_approval/confirmed。';

revoke execute on function inv.stock_adjustment_initial_status() from public;
revoke execute on function inv.stock_adjustment_initial_status() from anon, authenticated;
grant  execute on function inv.stock_adjustment_initial_status() to service_role;

-- ---------------------------------------------------------------------------
-- 3. 問題三的修法 —— 進貨的 trigger 補兩條路徑
-- ---------------------------------------------------------------------------
-- 3a. update_stock_on_purchase()：加「數量被改了」的分支
--
-- 前兩段（INSERT、核准）與 0009 的版本逐字相同，不要動它們 —— 那是既有 993 件
-- 商品庫存的來源。新增的只有第三段。
create or replace function inv.update_stock_on_purchase() returns trigger
    language plpgsql
    security definer
    set search_path to 'inv', 'public'
    as $$
DECLARE
  v_consumed integer;
BEGIN
  -- On INSERT: only update stock if already approved
  IF TG_OP = 'INSERT' THEN
    NEW.remaining_quantity := NEW.quantity;
    IF NEW.approval_status = 'approved' THEN
      UPDATE inv.products
      SET stock_quantity = stock_quantity + NEW.quantity
      WHERE id = NEW.product_id;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- 核准那一刻：照舊。
    IF OLD.approval_status != 'approved' AND NEW.approval_status = 'approved' THEN
      NEW.remaining_quantity := NEW.quantity;
      UPDATE inv.products
      SET stock_quantity = stock_quantity + NEW.quantity
      WHERE id = NEW.product_id;
      RETURN NEW;
    END IF;

    -- ── 這一段是 0017 新增的（見檔頭「問題三」）──────────────────────────
    -- 數量被改了。已消耗量 = 原數量 − 原剩餘量，那是 FIFO 已經從這一批吃掉的
    -- 件數，不能被改小。改完之後 remaining_quantity 要重新對齊，否則 quantity
    -- 與 remaining_quantity 的差額會憑空多出一段假的「已消耗」。
    IF NEW.quantity IS DISTINCT FROM OLD.quantity THEN
      v_consumed := OLD.quantity - COALESCE(OLD.remaining_quantity, OLD.quantity);

      IF NEW.quantity < v_consumed THEN
        RAISE EXCEPTION
          'PURCHASE_BELOW_CONSUMED: 這批進貨已經有 % 件出庫了，數量不能改成比它小的 %。要沖掉已出庫的部分請開一張在庫異動單。',
          v_consumed, NEW.quantity
          USING ERRCODE = 'check_violation';
      END IF;

      NEW.remaining_quantity := NEW.quantity - v_consumed;

      -- 只有已核准的進貨才進過庫存，所以也只有它要補差額。
      IF NEW.approval_status = 'approved' THEN
        UPDATE inv.products
        SET stock_quantity = stock_quantity + (NEW.quantity - OLD.quantity)
        WHERE id = NEW.product_id;
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  RETURN NEW;
END;
$$;

comment on function inv.update_stock_on_purchase() is
  '進貨的庫存同步。0017 補上「數量被改了」這條路徑：remaining_quantity 與 FIFO 已消耗量重新對齊，庫存補差額，改到比已消耗量小就 RAISE。';

-- 3b. 刪除進貨 —— 0009 完全沒有這條路徑
--
-- 來源的刪除確認對話框自己寫著「注意：庫存數量不會自動調整」，那不是設計，
-- 是把一個 bug 寫成說明文字。刪掉一筆已入庫的進貨，貨的來源沒了、庫存還在，
-- 而且 FIFO 的批次也少了一個 —— 後面的銷售會去吃別批的成本。
create or replace function inv.rollback_stock_on_purchase_delete() returns trigger
    language plpgsql
    security definer
    set search_path to 'inv', 'public'
    as $$
DECLARE
  v_consumed integer;
BEGIN
  v_consumed := OLD.quantity - COALESCE(OLD.remaining_quantity, OLD.quantity);

  -- 已經被 FIFO 吃掉的批次不能刪：那些成本已經寫進 inv.sales.cost_price 了，
  -- 批次一消失就再也對不回去。與 inv_delete_product 的「賣過的請改用停用」
  -- 同一條規矩。
  IF v_consumed > 0 THEN
    RAISE EXCEPTION
      'PURCHASE_ALREADY_CONSUMED: 這批進貨已經有 % 件出庫了，不能刪除。要沖掉請開一張在庫異動單，帳才留得住。',
      v_consumed
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.approval_status = 'approved' THEN
    UPDATE inv.products
    SET stock_quantity = stock_quantity - OLD.quantity
    WHERE id = OLD.product_id;
  END IF;

  RETURN OLD;
END;
$$;

comment on function inv.rollback_stock_on_purchase_delete() is
  '刪除進貨時把庫存收回去。已經被 FIFO 消耗過的批次直接擋下來。0009 沒有這條路徑，來源是靠對話框上一句「庫存不會自動調整」帶過去的。';

drop trigger if exists rollback_stock_on_purchase_delete on inv.purchases;
create trigger rollback_stock_on_purchase_delete
  before delete on inv.purchases
  for each row execute function inv.rollback_stock_on_purchase_delete();

-- ---------------------------------------------------------------------------
-- 4. 在庫異動確認時的 FIFO 成本分攤
-- ---------------------------------------------------------------------------
-- 來源在**前端**呼叫 allocate_fifo_cost 再把回傳值塞進 insert/update 的 payload。
-- 兩個問題：(a) 走審核的單子（pending_approval）建立時不算，核准時也不算，
-- unit_cost 永遠是 NULL，報表就少一段成本；(b) 成本從瀏覽器送進來。
--
-- 搬到 BEFORE UPDATE 的 trigger 上，任何一條「變成 confirmed」的路徑都會被涵蓋，
-- 包含 inv_approve_record()。`unit_cost IS NULL` 是防重複分攤的 guard —— 與
-- inv.allocate_fifo_on_sale() 的第一句（「已經有成本 = 呼叫端自己分攤過了」）
-- 同一個寫法。
create or replace function inv.update_stock_on_stock_adjustment() returns trigger
    language plpgsql
    security definer
    set search_path to 'inv', 'public'
    as $$
BEGIN
  IF OLD.status IN ('draft', 'pending_approval') AND NEW.status = 'confirmed' THEN
    -- 負數量 = 出庫，要吃 FIFO 批次。unit_cost 已經有值就不再算一次。
    IF NEW.quantity < 0 AND NEW.unit_cost IS NULL THEN
      NEW.unit_cost  := inv.allocate_fifo_cost(NEW.product_id, NEW.user_id, abs(NEW.quantity));
      NEW.total_cost := NEW.unit_cost * abs(NEW.quantity);
    END IF;

    UPDATE inv.products
    SET stock_quantity = stock_quantity + NEW.quantity
    WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;

comment on function inv.update_stock_on_stock_adjustment() is
  'draft/pending_approval → confirmed 時更新庫存，並在負數量且尚未分攤過時補算 FIFO 成本。0017 把成本分攤從前端搬進來，讓走審核的單子也算得到。';

-- ---------------------------------------------------------------------------
-- 5. inv_approve_record —— 換掉 0016 的版本
-- ---------------------------------------------------------------------------
-- 只有 stock_adjustments 那個分支改了（'pending' → 'pending_approval'，見檔頭）。
-- 其他六個分支與 0016 逐字相同，一起帶過來是因為 create or replace 是整支換掉。
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
      -- 欄位是 status，通過的值是 'confirmed'。
      -- ⚠️ 0017 修正：起點是 'pending_approval' 不是 'pending'。0016 寫成
      --    IN ('draft','pending')，而 'pending' 這個值在這張表從來不存在，
      --    所以核准一筆待審單會靜默 changed=false、庫存不動。
      SELECT status INTO v_before FROM inv.stock_adjustments WHERE id = p_id;
      UPDATE inv.stock_adjustments
         SET status      = CASE WHEN p_approved THEN 'confirmed' ELSE 'rejected' END,
             approved_by = p_user_id,
             approved_at = now()
       WHERE id = p_id AND status IN ('draft', 'pending_approval');
      GET DIAGNOSTICS v_count = ROW_COUNT;

    WHEN 'inventory_adjustments' THEN
      -- ⚠️ 這張表已經凍結（見檔頭「問題一」），沒有任何一支寫入函式會建立新的
      --    inventory_adjustments。這個分支留著是因為 30 筆歷史資料全部是
      --    approved，萬一有人要退回其中一筆，路還在。
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
      SELECT approval_status INTO v_before FROM inv.vendors WHERE id = p_id;
      UPDATE inv.vendors
         SET approval_status = CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
             approved_by     = p_user_id,
             approved_at     = now()
       WHERE id = p_id AND approval_status = 'pending';
      GET DIAGNOSTICS v_count = ROW_COUNT;

    WHEN 'price_changes' THEN
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
  '審核／退回一筆記錄。module 是白名單代號，表名與狀態欄位寫死在 CASE 裡（沒有動態 SQL）。0017 修正 stock_adjustments 的起點狀態為 pending_approval。';

revoke execute on function public.inv_approve_record(uuid, text, uuid, boolean) from public;
revoke execute on function public.inv_approve_record(uuid, text, uuid, boolean) from anon, authenticated;
grant  execute on function public.inv_approve_record(uuid, text, uuid, boolean) to service_role;

-- 5b. 直接以 confirmed 建立的異動單也要分攤 FIFO
--
-- 上面第 4 節管的是「UPDATE 成 confirmed」。審核關掉的時候，異動單是**一出生就
-- confirmed**，那條路徑走的是 BEFORE INSERT。形狀與 inv.sales 的
-- allocate_fifo_before_sale_insert 逐字對應（同樣的 unit_cost IS NULL guard）。
create or replace function inv.allocate_fifo_on_stock_adjustment() returns trigger
    language plpgsql
    security definer
    set search_path to 'inv', 'public'
    as $$
BEGIN
  IF NEW.status = 'confirmed' AND NEW.quantity < 0 AND NEW.unit_cost IS NULL THEN
    NEW.unit_cost  := inv.allocate_fifo_cost(NEW.product_id, NEW.user_id, abs(NEW.quantity));
    NEW.total_cost := NEW.unit_cost * abs(NEW.quantity);
  END IF;
  RETURN NEW;
END;
$$;

comment on function inv.allocate_fifo_on_stock_adjustment() is
  '一出生就是 confirmed 的出庫異動單，在 INSERT 時分攤 FIFO 成本。unit_cost 已有值就跳過（與 allocate_fifo_on_sale 同一個 guard）。';

drop trigger if exists allocate_fifo_before_adjustment_insert on inv.stock_adjustments;
create trigger allocate_fifo_before_adjustment_insert
  before insert on inv.stock_adjustments
  for each row execute function inv.allocate_fifo_on_stock_adjustment();

-- ---------------------------------------------------------------------------
-- 6. 進貨的寫入函式
-- ---------------------------------------------------------------------------
-- 與 0016 的商品函式同一套規矩：payload 的每一個欄位**逐一具名取出**。送
-- approval_status、remaining_quantity、user_id 這些 key 進來一律被忽略，因為
-- 根本沒有一行程式去讀它們。

-- 6a. inv_save_purchase —— 新增／編輯一筆進貨
--
-- p_id 為 NULL = 新增，否則 = 編輯。
--
-- 來源的編輯**不讓改數量**（UPDATE payload 裡刻意沒有 quantity），因為那時候改
-- 數量會讓庫存與 remaining_quantity 對不起來。0017 的 trigger 補好那兩條路徑之
-- 後，改數量是安全的，所以這裡放開 —— 改到比已消耗量小會被 trigger 擋下來。
--
-- product_id 仍然不讓改：那等於「把這批貨換成另一件商品」，庫存要同時從 A 減、
-- 往 B 加，FIFO 批次也要跟著搬。要換商品就刪掉重開一張。
create or replace function public.inv_save_purchase(
  p_user_id uuid,
  p_id      uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_id       uuid;
  v_created  boolean := false;
  v_status   text;
  v_product  uuid;
  v_qty      integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'PURCHASE_NO_OPERATOR: 必須記錄操作人員';
  END IF;

  v_qty := (p_payload ->> 'quantity')::integer;

  IF p_id IS NULL THEN
    v_product := (p_payload ->> 'product_id')::uuid;
    IF v_product IS NULL THEN
      RAISE EXCEPTION 'PURCHASE_NO_PRODUCT: 請選擇要進貨的商品';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM inv.products WHERE id = v_product) THEN
      RAISE EXCEPTION 'PURCHASE_PRODUCT_NOT_FOUND: 找不到這件商品'
        USING ERRCODE = 'no_data_found';
    END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'PURCHASE_BAD_QUANTITY: 進貨數量必須大於 0';
    END IF;

    -- ← 不是從 payload 拿。與 0016 的 inv_save_product 同一條規矩。
    v_status := inv.initial_approval_status('purchases');

    INSERT INTO inv.purchases (
      user_id, product_id, item_name, purchase_date, quantity, unit_cost,
      vendor_id, vendor, publisher, notes, expiry_date, expiry_alert_days,
      approval_status
    ) VALUES (
      p_user_id,
      v_product,
      nullif(btrim(coalesce(p_payload ->> 'item_name', '')), ''),
      coalesce((p_payload ->> 'purchase_date')::date, CURRENT_DATE),
      v_qty,
      (p_payload ->> 'unit_cost')::numeric,
      (p_payload ->> 'vendor_id')::uuid,
      nullif(btrim(coalesce(p_payload ->> 'vendor', '')), ''),
      nullif(btrim(coalesce(p_payload ->> 'publisher', '')), ''),
      nullif(btrim(coalesce(p_payload ->> 'notes', '')), ''),
      (p_payload ->> 'expiry_date')::date,
      CASE WHEN (p_payload ->> 'expiry_date') IS NULL THEN NULL
           ELSE coalesce((p_payload ->> 'expiry_alert_days')::integer, 7) END,
      v_status
    )
    RETURNING id INTO v_id;

    v_created := true;

  ELSE
    SELECT approval_status INTO v_status FROM inv.purchases WHERE id = p_id;
    IF v_status IS NULL THEN
      RAISE EXCEPTION 'PURCHASE_NOT_FOUND: 找不到這筆進貨'
        USING ERRCODE = 'no_data_found';
    END IF;
    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'PURCHASE_BAD_QUANTITY: 進貨數量必須大於 0';
    END IF;

    UPDATE inv.purchases
       SET item_name         = nullif(btrim(coalesce(p_payload ->> 'item_name', '')), ''),
           purchase_date     = coalesce((p_payload ->> 'purchase_date')::date, purchase_date),
           quantity          = v_qty,
           unit_cost         = (p_payload ->> 'unit_cost')::numeric,
           vendor_id         = (p_payload ->> 'vendor_id')::uuid,
           vendor            = nullif(btrim(coalesce(p_payload ->> 'vendor', '')), ''),
           publisher         = nullif(btrim(coalesce(p_payload ->> 'publisher', '')), ''),
           notes             = nullif(btrim(coalesce(p_payload ->> 'notes', '')), ''),
           expiry_date       = (p_payload ->> 'expiry_date')::date,
           expiry_alert_days = CASE WHEN (p_payload ->> 'expiry_date') IS NULL THEN NULL
                                    ELSE coalesce((p_payload ->> 'expiry_alert_days')::integer, 7) END
     WHERE id = p_id;

    v_id := p_id;
  END IF;

  RETURN jsonb_build_object(
    'id', v_id,
    'created', v_created,
    'approval_status', v_status,
    'needs_approval', v_status = 'pending'
  );
END;
$$;

comment on function public.inv_save_purchase(uuid, uuid, jsonb) is
  '新增／編輯一筆進貨。approval_status 由 inv.initial_approval_status(''purchases'') 決定，呼叫端指定不了。編輯可以改數量（0017 的 trigger 會把 remaining_quantity 與庫存一起對齊），但不能換商品。';

revoke execute on function public.inv_save_purchase(uuid, uuid, jsonb) from public;
revoke execute on function public.inv_save_purchase(uuid, uuid, jsonb) from anon, authenticated;
grant  execute on function public.inv_save_purchase(uuid, uuid, jsonb) to service_role;

-- 6b. inv_delete_purchase
--
-- 守衛在 trigger（rollback_stock_on_purchase_delete）：已經被 FIFO 消耗過的批次
-- 直接 RAISE，沒被消耗過的把庫存收回去。這裡只負責把訊息講清楚。
create or replace function public.inv_delete_purchase(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_qty      integer;
  v_rem      integer;
  v_status   text;
  v_product  uuid;
BEGIN
  SELECT quantity, coalesce(remaining_quantity, quantity), approval_status, product_id
    INTO v_qty, v_rem, v_status, v_product
    FROM inv.purchases WHERE id = p_id;

  IF v_qty IS NULL THEN
    RAISE EXCEPTION 'PURCHASE_NOT_FOUND: 找不到這筆進貨'
      USING ERRCODE = 'no_data_found';
  END IF;

  DELETE FROM inv.purchases WHERE id = p_id;

  RETURN jsonb_build_object(
    'deleted', true,
    'quantity', v_qty,
    -- 已核准的進貨被刪掉時 trigger 會把庫存收回去。回傳這一個布林讓 UI 講對話。
    'stock_rolled_back', v_status = 'approved',
    'product_id', v_product
  );
END;
$$;

comment on function public.inv_delete_purchase(uuid) is
  '刪除一筆進貨。已被 FIFO 消耗過的批次會被 rollback_stock_on_purchase_delete() 擋下來；沒被消耗過的，已核准部分的庫存由同一支 trigger 收回。';

revoke execute on function public.inv_delete_purchase(uuid) from public;
revoke execute on function public.inv_delete_purchase(uuid) from anon, authenticated;
grant  execute on function public.inv_delete_purchase(uuid) to service_role;

-- 6c. inv_batch_update_purchases —— 批次改供應商／效期
--
-- 只受理四個欄位，而且**只有 patch 裡出現的 key 才會被寫**：沒出現 = 不動，
-- 出現但值是 null = 明確清空。來源的對話框就是這個語意（兩個 checkbox 各控一組）。
-- 數量與商品不在這裡 —— 那兩個要一筆一筆看 FIFO。
create or replace function public.inv_batch_update_purchases(
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
  v_count integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'PURCHASE_NO_OPERATOR: 必須記錄操作人員';
  END IF;
  IF p_ids IS NULL OR array_length(p_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'BATCH_EMPTY: 沒有選取任何進貨';
  END IF;
  -- 與 schemas.ts 的 500 上限對齊。
  IF array_length(p_ids, 1) > 500 THEN
    RAISE EXCEPTION 'BATCH_TOO_MANY: 一次最多 500 筆，請分批';
  END IF;
  IF NOT (p_patch ? 'vendor' OR p_patch ? 'expiry') THEN
    RAISE EXCEPTION 'BATCH_NO_FIELD: 請至少選一組要更新的欄位';
  END IF;

  UPDATE inv.purchases p
     SET vendor_id = CASE WHEN p_patch ? 'vendor'
                          THEN (p_patch -> 'vendor' ->> 'vendor_id')::uuid
                          ELSE p.vendor_id END,
         vendor    = CASE WHEN p_patch ? 'vendor'
                          THEN nullif(btrim(coalesce(p_patch -> 'vendor' ->> 'vendor', '')), '')
                          ELSE p.vendor END,
         expiry_date = CASE WHEN p_patch ? 'expiry'
                            THEN (p_patch -> 'expiry' ->> 'expiry_date')::date
                            ELSE p.expiry_date END,
         expiry_alert_days = CASE
             WHEN NOT (p_patch ? 'expiry') THEN p.expiry_alert_days
             WHEN (p_patch -> 'expiry' ->> 'expiry_date') IS NULL THEN NULL
             ELSE coalesce((p_patch -> 'expiry' ->> 'expiry_alert_days')::integer, 7)
           END
   WHERE p.id = ANY (p_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('updated', v_count);
END;
$$;

comment on function public.inv_batch_update_purchases(uuid, uuid[], jsonb) is
  '批次改進貨的供應商與效期。patch 只認 vendor 與 expiry 兩個 key，沒出現的欄位不動、出現但值為 null 是明確清空。數量與商品不開放批次改。';

revoke execute on function public.inv_batch_update_purchases(uuid, uuid[], jsonb) from public;
revoke execute on function public.inv_batch_update_purchases(uuid, uuid[], jsonb) from anon, authenticated;
grant  execute on function public.inv_batch_update_purchases(uuid, uuid[], jsonb) to service_role;

-- 6d. inv_import_purchases —— Excel 匯入
--
-- 來源是在瀏覽器裡跑一個 for 迴圈，一列一次 insert、沒有交易：建商品成功但建
-- 進貨失敗就留下一件孤兒商品，而且沒有任何地方會發現。這裡整批在一個函式裡跑，
-- 任何一列爆掉整批回滾。
--
-- Excel 的**解析**留在瀏覽器（xlsx 那包在 SSR 會炸，0016 已經踩過）；送進來的
-- 是已經對好欄位的 jsonb 陣列。
create or replace function public.inv_import_purchases(
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
  v_row            jsonb;
  v_product_id     uuid;
  v_name           text;
  v_issue          text;
  v_series         text;
  v_barcode        text;
  v_qty            integer;
  v_cost           numeric;
  v_created_p      integer := 0;
  v_created_pur    integer := 0;
  v_status_pur     text;
  v_status_prod    text;
  v_default_vendor uuid;
  v_default_cat    uuid;
  v_vendor_id      uuid;
  v_type           text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'IMPORT_NO_OPERATOR: 必須記錄操作人員';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'IMPORT_EMPTY: 沒有要匯入的資料';
  END IF;
  -- 與 schemas.ts 的 2000 上限對齊。
  IF jsonb_array_length(p_rows) > 2000 THEN
    RAISE EXCEPTION 'IMPORT_TOO_MANY: 一次最多 2000 列，請分批';
  END IF;

  v_status_pur     := inv.initial_approval_status('purchases');
  v_status_prod    := inv.initial_approval_status('products');
  v_default_vendor := (p_options ->> 'default_vendor_id')::uuid;
  v_default_cat    := (p_options ->> 'default_category_id')::uuid;

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_name    := nullif(btrim(coalesce(v_row ->> 'name', '')), '');
    v_issue   := nullif(btrim(coalesce(v_row ->> 'issue_number', '')), '');
    v_series  := nullif(btrim(coalesce(v_row ->> 'series', '')), '');
    v_barcode := nullif(btrim(coalesce(v_row ->> 'barcode', '')), '');
    v_qty     := (v_row ->> 'quantity')::integer;
    v_cost    := (v_row ->> 'unit_cost')::numeric;

    IF v_qty IS NULL OR v_qty <= 0 THEN
      RAISE EXCEPTION 'IMPORT_BAD_QUANTITY: 「%」的數量必須大於 0', coalesce(v_name, '(未命名)');
    END IF;

    v_vendor_id := coalesce((v_row ->> 'vendor_id')::uuid, v_default_vendor);

    -- 商品比對。呼叫端已經比過一輪（它手上有整份商品清單），這裡再比一次是因為
    -- 「呼叫端說找不到」與「真的找不到」是兩件事 —— 兩次解析之間可能有人新增了
    -- 同一件商品。比對順序與來源的 findProduct 一致：條碼 > 名稱+期數+系列。
    v_product_id := (v_row ->> 'product_id')::uuid;

    IF v_product_id IS NULL AND v_barcode IS NOT NULL THEN
      SELECT id INTO v_product_id FROM inv.products
       WHERE lower(barcode) = lower(v_barcode) LIMIT 1;
    END IF;

    IF v_product_id IS NULL AND v_name IS NOT NULL THEN
      SELECT id INTO v_product_id FROM inv.products
       WHERE lower(name) = lower(v_name)
         AND coalesce(lower(issue_number), '') = coalesce(lower(v_issue), '')
         AND coalesce(lower(series), '')       = coalesce(lower(v_series), '')
       LIMIT 1;
    END IF;

    -- 還是沒有 → 建一件新商品。售價 0、庫存 0（庫存由下面那筆進貨的 trigger 加）。
    IF v_product_id IS NULL THEN
      IF v_name IS NULL THEN
        RAISE EXCEPTION 'IMPORT_NO_NAME: 有一列既沒有對到商品也沒有商品名稱';
      END IF;

      v_type := coalesce(nullif(btrim(coalesce(v_row ->> 'product_type', '')), ''), 'outright');
      IF v_type NOT IN ('outright', 'consignment', 'rental') THEN
        v_type := 'outright';
      END IF;

      INSERT INTO inv.products (
        user_id, name, issue_number, series, barcode,
        cost_price, selling_price, stock_quantity,
        product_type, category_id, vendor_id, approval_status
      ) VALUES (
        p_user_id, v_name, v_issue, v_series, v_barcode,
        coalesce(v_cost, 0), 0, 0,
        v_type,
        coalesce((v_row ->> 'category_id')::uuid, v_default_cat),
        v_vendor_id,
        v_status_prod
      )
      RETURNING id INTO v_product_id;

      v_created_p := v_created_p + 1;
    END IF;

    INSERT INTO inv.purchases (
      user_id, product_id, item_name, quantity, unit_cost,
      vendor_id, vendor, purchase_date, notes,
      expiry_date, expiry_alert_days, approval_status
    ) VALUES (
      p_user_id,
      v_product_id,
      v_name,
      v_qty,
      v_cost,
      v_vendor_id,
      nullif(btrim(coalesce(v_row ->> 'vendor', '')), ''),
      coalesce((v_row ->> 'purchase_date')::date,
               (p_options ->> 'default_purchase_date')::date,
               CURRENT_DATE),
      -- 來源一律加這個標記，留著 —— 對帳時看得出哪些是手打哪些是匯入。
      CASE WHEN nullif(btrim(coalesce(v_row ->> 'notes', '')), '') IS NULL
           THEN 'Excel 匯入'
           ELSE btrim(v_row ->> 'notes') || ' (Excel 匯入)' END,
      (v_row ->> 'expiry_date')::date,
      CASE WHEN (v_row ->> 'expiry_date') IS NULL THEN NULL
           ELSE coalesce((v_row ->> 'expiry_alert_days')::integer,
                         (p_options ->> 'default_expiry_alert_days')::integer,
                         7) END,
      v_status_pur
    );

    v_created_pur := v_created_pur + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'purchases_created', v_created_pur,
    'products_created',  v_created_p,
    'approval_status',   v_status_pur,
    'needs_approval',    v_status_pur = 'pending'
  );
END;
$$;

comment on function public.inv_import_purchases(uuid, jsonb, jsonb) is
  'Excel 進貨匯入。整批在同一個交易裡，任何一列失敗全部回滾（來源是逐筆 insert，建了商品但進貨失敗會留孤兒）。比對不到的商品自動新建，approval_status 一律由 initial_approval_status 決定。';

revoke execute on function public.inv_import_purchases(uuid, jsonb, jsonb) from public;
revoke execute on function public.inv_import_purchases(uuid, jsonb, jsonb) from anon, authenticated;
grant  execute on function public.inv_import_purchases(uuid, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 7. 在庫異動與盤點的寫入函式
-- ---------------------------------------------------------------------------
-- 全部寫 inv.stock_adjustments，一筆都不寫 inv.inventory_adjustments（檔頭問題一）。
-- status 全部由 inv.stock_adjustment_initial_status() 決定（檔頭問題二）。
-- 庫存全部由 trigger 加減，這裡沒有一行 UPDATE inv.products.stock_quantity。

-- 7a. inv_save_stock_adjustment —— 新增一張在庫異動單
--
-- p_submit = false → 存成草稿（不動庫存，之後可以改可以刪）
-- p_submit = true  → 送出。要不要審核由資料庫決定，**不是呼叫端說了算**。
create or replace function public.inv_save_stock_adjustment(
  p_user_id uuid,
  p_payload jsonb,
  p_submit  boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_id       uuid;
  v_status   text;
  v_product  uuid;
  v_qty      integer;
  v_stock    integer;
  v_cost     numeric;
  v_number   text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_NO_OPERATOR: 必須記錄操作人員';
  END IF;

  v_product := (p_payload ->> 'product_id')::uuid;
  v_qty     := (p_payload ->> 'quantity')::integer;

  IF v_product IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_NO_PRODUCT: 請選擇商品';
  END IF;
  IF v_qty IS NULL OR v_qty = 0 THEN
    RAISE EXCEPTION 'ADJUSTMENT_ZERO_QUANTITY: 異動數量不可為 0';
  END IF;

  SELECT stock_quantity, cost_price INTO v_stock, v_cost
    FROM inv.products WHERE id = v_product;
  IF v_stock IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_PRODUCT_NOT_FOUND: 找不到這件商品'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- ← 不是從 payload 拿。這一行就是「盤點繞過審核」的修法。
  v_status := CASE WHEN p_submit THEN inv.stock_adjustment_initial_status() ELSE 'draft' END;

  INSERT INTO inv.stock_adjustments (
    user_id, product_id, adjustment_date, category, quantity,
    unit_cost, total_cost, status, reason, notes, stock_before
  ) VALUES (
    p_user_id,
    v_product,
    coalesce((p_payload ->> 'adjustment_date')::date, CURRENT_DATE),
    p_payload ->> 'category',
    v_qty,
    -- 進貨（正數）用商品成本；出庫（負數）交給 FIFO trigger 算，這裡留 NULL。
    CASE WHEN v_qty > 0 THEN coalesce(v_cost, 0) ELSE NULL END,
    CASE WHEN v_qty > 0 THEN coalesce(v_cost, 0) * v_qty ELSE NULL END,
    v_status,
    nullif(btrim(coalesce(p_payload ->> 'reason', '')), ''),
    nullif(btrim(coalesce(p_payload ->> 'notes', '')), ''),
    v_stock
  )
  RETURNING id, adjustment_number INTO v_id, v_number;

  RETURN jsonb_build_object(
    'id', v_id,
    'adjustment_number', v_number,
    'status', v_status,
    'needs_approval', v_status = 'pending_approval',
    'stock_before', v_stock
  );
END;
$$;

comment on function public.inv_save_stock_adjustment(uuid, jsonb, boolean) is
  '新增一張在庫異動單。status 由 inv.stock_adjustment_initial_status() 決定，payload 裡的 status 一律被忽略。庫存由 trigger 加減。';

revoke execute on function public.inv_save_stock_adjustment(uuid, jsonb, boolean) from public;
revoke execute on function public.inv_save_stock_adjustment(uuid, jsonb, boolean) from anon, authenticated;
grant  execute on function public.inv_save_stock_adjustment(uuid, jsonb, boolean) to service_role;

-- 7b. inv_record_stock_count —— 盤點（單筆與批次同一支）
--
-- ⚠️ 呼叫端送的是**實盤數量**，不是差異。差異在資料庫這邊用當下的 stock_quantity
--    算 —— 這不是潔癖：來源是在瀏覽器算 `actual - product.stock_quantity`，而那個
--    stock_quantity 是頁面載入時抓的。店員開著盤點畫面十分鐘，中間櫃檯賣掉三本，
--    送出的差異就會多扣三本。在資料庫算，差異永遠是對著送出當下的帳面。
--
-- 差異為 0 的列直接跳過（來源也是這個行為），回傳 skipped 讓 UI 講得出來。
create or replace function public.inv_record_stock_count(
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
  v_row      jsonb;
  v_product  uuid;
  v_actual   integer;
  v_stock    integer;
  v_cost     numeric;
  v_diff     integer;
  v_status   text;
  v_created  integer := 0;
  v_skipped  integer := 0;
  v_shrink   integer := 0;
  v_surplus  integer := 0;
  v_reason   text;
  v_notes    text;
  v_date     date;
  v_ids      uuid[] := '{}';
  v_id       uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_NO_OPERATOR: 必須記錄操作人員';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'COUNT_EMPTY: 沒有要盤點的商品';
  END IF;
  IF jsonb_array_length(p_rows) > 500 THEN
    RAISE EXCEPTION 'COUNT_TOO_MANY: 一次最多盤 500 件，請分批';
  END IF;

  v_reason := nullif(btrim(coalesce(p_options ->> 'reason', '')), '');
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'COUNT_NO_REASON: 請選擇盤點差異的原因';
  END IF;

  v_notes := nullif(btrim(coalesce(p_options ->> 'notes', '')), '');
  v_date  := coalesce((p_options ->> 'adjustment_date')::date, CURRENT_DATE);

  -- 同一批的 status 一次算完，不要在迴圈裡每列查一次設定。
  v_status := inv.stock_adjustment_initial_status();

  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    v_product := (v_row ->> 'product_id')::uuid;
    v_actual  := (v_row ->> 'actual_quantity')::integer;

    IF v_product IS NULL THEN
      RAISE EXCEPTION 'COUNT_NO_PRODUCT: 有一列沒有指定商品';
    END IF;
    IF v_actual IS NULL OR v_actual < 0 THEN
      RAISE EXCEPTION 'COUNT_BAD_QUANTITY: 實際盤點數量不可為負數';
    END IF;

    SELECT stock_quantity, cost_price INTO v_stock, v_cost
      FROM inv.products WHERE id = v_product;
    IF v_stock IS NULL THEN
      RAISE EXCEPTION 'COUNT_PRODUCT_NOT_FOUND: 找不到其中一件商品'
        USING ERRCODE = 'no_data_found';
    END IF;

    v_diff := v_actual - v_stock;   -- ← 差異在這裡算，不是在瀏覽器

    IF v_diff = 0 THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    INSERT INTO inv.stock_adjustments (
      user_id, product_id, adjustment_date, category, quantity,
      unit_cost, total_cost, status, reason, notes, stock_before
    ) VALUES (
      p_user_id, v_product, v_date,
      'ADJ',                       -- 盤點固定是 ADJ，與來源一致
      v_diff,
      CASE WHEN v_diff > 0 THEN coalesce(v_cost, 0) ELSE NULL END,
      CASE WHEN v_diff > 0 THEN coalesce(v_cost, 0) * v_diff ELSE NULL END,
      v_status,
      v_reason,
      v_notes,
      v_stock
    )
    RETURNING id INTO v_id;

    v_ids   := v_ids || v_id;
    v_created := v_created + 1;
    IF v_diff < 0 THEN v_shrink := v_shrink + 1; ELSE v_surplus := v_surplus + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'created',        v_created,
    'skipped',        v_skipped,
    'shrinkage',      v_shrink,
    'surplus',        v_surplus,
    'status',         v_status,
    'needs_approval', v_status = 'pending_approval',
    'ids',            to_jsonb(v_ids)
  );
END;
$$;

comment on function public.inv_record_stock_count(uuid, jsonb, jsonb) is
  '盤點。呼叫端送實盤數量，差異由資料庫用當下的 stock_quantity 算（來源在瀏覽器算，畫面開太久就會扣錯）。一律寫 inv.stock_adjustments 的 ADJ 類，status 由 stock_adjustment_initial_status() 決定。';

revoke execute on function public.inv_record_stock_count(uuid, jsonb, jsonb) from public;
revoke execute on function public.inv_record_stock_count(uuid, jsonb, jsonb) from anon, authenticated;
grant  execute on function public.inv_record_stock_count(uuid, jsonb, jsonb) to service_role;

-- 7c. inv_submit_stock_adjustment —— 草稿送出
--
-- 來源的「確認異動」按鈕是直接 update status='confirmed'，審核開著的時候才在
-- 前端改成 pending_approval。這裡把那個判斷搬進資料庫。
create or replace function public.inv_submit_stock_adjustment(
  p_user_id uuid,
  p_id      uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_before text;
  v_next   text;
  v_count  integer := 0;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_NO_OPERATOR: 必須記錄操作人員';
  END IF;

  SELECT status INTO v_before FROM inv.stock_adjustments WHERE id = p_id;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_NOT_FOUND: 找不到這張異動單'
      USING ERRCODE = 'no_data_found';
  END IF;

  v_next := inv.stock_adjustment_initial_status();

  -- 只有草稿能送出。已確認的再送一次就是扣兩次庫存。
  UPDATE inv.stock_adjustments
     SET status = v_next
   WHERE id = p_id AND status = 'draft';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'changed',         v_count > 0,
    'previous_status', v_before,
    'status',          CASE WHEN v_count > 0 THEN v_next ELSE v_before END,
    'needs_approval',  v_next = 'pending_approval'
  );
END;
$$;

comment on function public.inv_submit_stock_adjustment(uuid, uuid) is
  '把草稿異動單送出。要不要進待審由 inv.stock_adjustment_initial_status() 決定。只受理 draft，已確認的單子重送會回 changed=false 而不是扣第二次庫存。';

revoke execute on function public.inv_submit_stock_adjustment(uuid, uuid) from public;
revoke execute on function public.inv_submit_stock_adjustment(uuid, uuid) from anon, authenticated;
grant  execute on function public.inv_submit_stock_adjustment(uuid, uuid) to service_role;

-- 7d. inv_delete_stock_adjustment —— 只能刪草稿
--
-- 真正的守衛是 0009 的 trg_prevent_confirmed_delete（BEFORE DELETE，confirmed 就
-- RAISE）。這裡多擋一層 pending_approval：那張單正等著別人審，刪掉審核的人會
-- 看到一筆消失的資料。
create or replace function public.inv_delete_stock_adjustment(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_status text;
  v_number text;
BEGIN
  SELECT status, adjustment_number INTO v_status, v_number
    FROM inv.stock_adjustments WHERE id = p_id;

  IF v_status IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_NOT_FOUND: 找不到這張異動單'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_status = 'confirmed' THEN
    RAISE EXCEPTION 'ADJUSTMENT_CONFIRMED: 已確認的異動單不可刪除，請改用沖帳'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_status = 'pending_approval' THEN
    RAISE EXCEPTION 'ADJUSTMENT_PENDING: 這張單正在等待審核，不能刪除。請先請審核人退回。'
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM inv.stock_adjustments WHERE id = p_id;

  RETURN jsonb_build_object('deleted', true, 'adjustment_number', v_number);
END;
$$;

comment on function public.inv_delete_stock_adjustment(uuid) is
  '刪除異動單。confirmed 由 0009 的 trg_prevent_confirmed_delete 擋；pending_approval 在這裡擋（正在等人審的單子不該憑空消失）。';

revoke execute on function public.inv_delete_stock_adjustment(uuid) from public;
revoke execute on function public.inv_delete_stock_adjustment(uuid) from anon, authenticated;
grant  execute on function public.inv_delete_stock_adjustment(uuid) to service_role;

-- 7e. inv_reverse_stock_adjustment —— 沖帳
--
-- 沖帳 = 新增一筆反向的 confirmed 單，原單不動。這是來源的語意，留著 —— 帳要
-- 留痕，不能把原單改掉。
--
-- ⚠️ 沖帳單一律直接 confirmed，**不進審核**。理由：沖的是一筆已經生效的異動，
--    庫存現在就是錯的；讓它卡在待審等於明知帳錯還要等人按。要防的是亂沖，那
--    靠的是「沖帳單自己不能再被沖」（reversal_of 已有值就擋）。
create or replace function public.inv_reverse_stock_adjustment(
  p_user_id uuid,
  p_id      uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_src      record;
  v_new_id   uuid;
  v_number   text;
  v_stock    integer;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_NO_OPERATOR: 必須記錄操作人員';
  END IF;

  SELECT * INTO v_src FROM inv.stock_adjustments WHERE id = p_id;
  IF v_src.id IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_NOT_FOUND: 找不到這張異動單'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_src.status <> 'confirmed' THEN
    RAISE EXCEPTION 'ADJUSTMENT_NOT_CONFIRMED: 只有已確認的異動單需要沖帳（目前：%）', v_src.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_src.reversal_of IS NOT NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_ALREADY_REVERSAL: 這張本身就是沖帳單，不能再沖一次'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (SELECT 1 FROM inv.stock_adjustments WHERE reversal_of = p_id) THEN
    RAISE EXCEPTION 'ADJUSTMENT_ALREADY_REVERSED: 這張單已經沖過帳了'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT stock_quantity INTO v_stock FROM inv.products WHERE id = v_src.product_id;

  INSERT INTO inv.stock_adjustments (
    user_id, product_id, adjustment_date, category, quantity,
    unit_cost, total_cost, status, reason, notes, reversal_of, stock_before
  ) VALUES (
    p_user_id,
    v_src.product_id,
    CURRENT_DATE,
    v_src.category,
    -v_src.quantity,
    -- 反向單是進貨方向（原單是出庫）時用原單的成本，帳才對得回去；
    -- 反向單是出庫方向時留 NULL 交給 FIFO trigger。
    CASE WHEN -v_src.quantity > 0 THEN v_src.unit_cost ELSE NULL END,
    CASE WHEN -v_src.quantity > 0 THEN v_src.unit_cost * abs(v_src.quantity) ELSE NULL END,
    'confirmed',
    v_src.reason,
    '沖帳：' || coalesce(v_src.adjustment_number, p_id::text)
      || coalesce(' / 原備註：' || v_src.notes, ''),
    p_id,
    v_stock
  )
  RETURNING id, adjustment_number INTO v_new_id, v_number;

  RETURN jsonb_build_object(
    'id', v_new_id,
    'adjustment_number', v_number,
    'quantity', -v_src.quantity,
    'reversal_of', p_id
  );
END;
$$;

comment on function public.inv_reverse_stock_adjustment(uuid, uuid) is
  '沖帳：建立一筆反向的已確認異動單，原單不動。沖帳單自己不能再被沖，同一張單也不能沖兩次。';

revoke execute on function public.inv_reverse_stock_adjustment(uuid, uuid) from public;
revoke execute on function public.inv_reverse_stock_adjustment(uuid, uuid) from anon, authenticated;
grant  execute on function public.inv_reverse_stock_adjustment(uuid, uuid) to service_role;

-- 7f. inv_resubmit_stock_adjustment —— 被退回的重新送審
create or replace function public.inv_resubmit_stock_adjustment(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, inv
as $$
DECLARE
  v_before text;
  v_count  integer := 0;
BEGIN
  SELECT status INTO v_before FROM inv.stock_adjustments WHERE id = p_id;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'ADJUSTMENT_NOT_FOUND: 找不到這張異動單'
      USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE inv.stock_adjustments
     SET status      = 'pending_approval',
         approved_by = NULL,
         approved_at = NULL
   WHERE id = p_id AND status = 'rejected';
  GET DIAGNOSTICS v_count = ROW_COUNT;

  RETURN jsonb_build_object('changed', v_count > 0, 'previous_status', v_before);
END;
$$;

comment on function public.inv_resubmit_stock_adjustment(uuid) is
  '被退回的異動單重新送審。只受理 rejected —— 從別的狀態跳進 pending_approval 會讓庫存扣兩次。';

revoke execute on function public.inv_resubmit_stock_adjustment(uuid) from public;
revoke execute on function public.inv_resubmit_stock_adjustment(uuid) from anon, authenticated;
grant  execute on function public.inv_resubmit_stock_adjustment(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 8. 三個唯讀 view
-- ---------------------------------------------------------------------------
-- 理由與 0012／0014／0016 相同：inv 不在 PostgREST 的 db_schema 裡。
-- ⚠️ 全部 security_invoker = false，所以 grant 給誰就是全部的防線。

-- 8a. inv_admin_purchases —— 進貨清單
create or replace view public.inv_admin_purchases
with (security_invoker = false) as
select
  pu.id                      as purchase_id,
  pu.product_id              as product_id,
  p.name                     as product_name,
  p.issue_number             as issue_number,
  p.series                   as series,
  p.product_type             as product_type,
  p.category_id              as category_id,
  c.name                     as category_name,
  pu.item_name               as item_name,
  pu.purchase_date           as purchase_date,
  pu.quantity                as quantity,
  coalesce(pu.remaining_quantity, pu.quantity) as remaining_quantity,
  -- 已消耗 = FIFO 從這一批吃掉的件數。前端要靠它算「已用 N／已售完」。
  pu.quantity - coalesce(pu.remaining_quantity, pu.quantity) as consumed_quantity,
  pu.unit_cost               as unit_cost,
  pu.quantity * coalesce(pu.unit_cost, 0) as subtotal,
  pu.vendor_id               as vendor_id,
  v.name                     as vendor_name,
  v.short_name               as vendor_short_name,
  pu.vendor                  as vendor_text,
  pu.publisher               as publisher,
  pu.notes                   as notes,
  pu.expiry_date             as expiry_date,
  pu.expiry_alert_days       as expiry_alert_days,
  pu.approval_status         as approval_status,
  pu.approved_at             as approved_at,
  approver.name              as approved_by_name,
  pu.user_id                 as user_id,
  creator.name               as creator_name,
  pu.created_at              as created_at
from inv.purchases pu
left join inv.products p         on p.id  = pu.product_id
left join inv.categories c       on c.id  = p.category_id
left join inv.vendors    v       on v.id  = pu.vendor_id
left join inv.profiles   creator  on creator.user_id  = pu.user_id
left join inv.profiles   approver on approver.user_id = pu.approved_by;

comment on view public.inv_admin_purchases is
  '進貨清單。consumed_quantity 是 FIFO 已經從這一批吃掉的件數 —— 編輯與刪除的守衛都是對著它。只給 service_role。';

-- 8b. inv_admin_stock_adjustments —— 在庫異動清單
--
-- reversal_of 這裡 join 成單號。來源的詳情頁直接印 UUID，店員看到一串亂碼。
create or replace view public.inv_admin_stock_adjustments
with (security_invoker = false) as
select
  a.id                as adjustment_id,
  a.adjustment_number as adjustment_number,
  a.product_id        as product_id,
  p.name              as product_name,
  p.issue_number      as issue_number,
  p.series            as series,
  p.stock_quantity    as product_stock_quantity,
  p.category_id       as category_id,
  c.name              as category_name,
  a.adjustment_date   as adjustment_date,
  a.category          as category,
  a.quantity          as quantity,
  a.unit_cost         as unit_cost,
  a.total_cost        as total_cost,
  a.status            as status,
  a.reason            as reason,
  a.notes             as notes,
  a.stock_before      as stock_before,
  a.reversal_of       as reversal_of,
  src.adjustment_number as reversal_of_number,
  rev.id                as reversed_by_id,
  rev.adjustment_number as reversed_by_number,
  a.approved_at       as approved_at,
  approver.name       as approved_by_name,
  a.user_id           as user_id,
  creator.name        as creator_name,
  a.created_at        as created_at
from inv.stock_adjustments a
left join inv.products   p   on p.id = a.product_id
left join inv.categories c   on c.id = p.category_id
left join inv.stock_adjustments src on src.id = a.reversal_of
left join inv.stock_adjustments rev on rev.reversal_of = a.id
left join inv.profiles   creator  on creator.user_id  = a.user_id
left join inv.profiles   approver on approver.user_id = a.approved_by;

comment on view public.inv_admin_stock_adjustments is
  '在庫異動與盤點清單（同一張表，靠 category 區分，ADJ = 盤點）。reversal_of 已經 join 成單號，reversed_by_* 讓 UI 知道這張已經被沖過了。只給 service_role。';

-- 8c. inv_admin_product_movements —— 商品詳細頁的異動紀錄
--
-- 這個 view 就是檔頭「問題一」的驗收：把**現役的** inv.stock_adjustments 與
-- **凍結的** inv.inventory_adjustments union 起來，所以
--   · 剛做完的盤點看得到（來源看不到，因為詳情頁只讀舊表）
--   · 1–3 月那 30 筆歷史也還在
--   · 而且新的寫入只進其中一張，不會扣兩次
--
-- source 欄位保留來源，因為兩張表的語意本來就不同，不要假裝它們一樣：
--   stock_adjustment   → code 是六類代碼（EXP/PR/SMP/INT/ADJ/CMB）
--   inventory_adjustment → code 是 shrinkage/surplus
create or replace view public.inv_admin_product_movements
with (security_invoker = false) as
select
  'stock_adjustment'::text as source,
  a.id                as movement_id,
  a.product_id        as product_id,
  a.adjustment_number as document_number,
  a.adjustment_date   as movement_date,
  a.category          as code,
  a.quantity          as quantity,
  a.status            as status,
  a.reason            as reason,
  a.notes             as notes,
  a.unit_cost         as unit_cost,
  a.total_cost        as total_cost,
  a.stock_before      as stock_before,
  a.created_at        as created_at,
  creator.name        as creator_name
from inv.stock_adjustments a
left join inv.profiles creator on creator.user_id = a.user_id

union all

select
  'inventory_adjustment'::text as source,
  ia.id               as movement_id,
  ia.product_id       as product_id,
  NULL::text          as document_number,
  ia.adjustment_date  as movement_date,
  ia.adjustment_type  as code,
  ia.quantity         as quantity,
  ia.approval_status  as status,
  ia.reason           as reason,
  ia.notes            as notes,
  NULL::numeric       as unit_cost,
  NULL::numeric       as total_cost,
  ia.stock_before     as stock_before,
  ia.created_at       as created_at,
  creator.name        as creator_name
from inv.inventory_adjustments ia
left join inv.profiles creator on creator.user_id = ia.user_id;

comment on view public.inv_admin_product_movements is
  '單一商品的庫存異動紀錄。union 了現役的 inv.stock_adjustments 與已凍結的 inv.inventory_adjustments（30 筆歷史，2026-03 之後就沒有新資料）。新的寫入只會出現在前者 —— 兩張都寫等於同一次盤點扣兩次庫存。只給 service_role。';

-- ---------------------------------------------------------------------------
-- 9. 權限
-- ---------------------------------------------------------------------------
-- ⚠️ revoke 才是真正生效的那一半。Supabase 對 public schema 有 ALTER DEFAULT
--    PRIVILEGES，新建的 view 一出生就對 anon/authenticated 是 ALL —— 只下
--    `grant select to service_role` 會留下那個 ALL。0013 就是在修這個坑。
revoke all on public.inv_admin_purchases          from anon, authenticated;
revoke all on public.inv_admin_stock_adjustments  from anon, authenticated;
revoke all on public.inv_admin_product_movements  from anon, authenticated;

grant select on public.inv_admin_purchases          to service_role;
grant select on public.inv_admin_stock_adjustments  to service_role;
grant select on public.inv_admin_product_movements  to service_role;

commit;

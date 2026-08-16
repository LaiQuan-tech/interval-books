-- 0018_inventory_combos_secondhand.sql —— 套餐、二手書，以及 OCR 的私有 bucket
--
-- 0016 讓店員維護商品主檔，0017 讓庫存動起來，0014 讓他們在櫃檯賣單品。這一份
-- 補上櫃檯還缺的兩條結帳路徑（套餐、二手書），順手把 Phase 1 刻意留下的那個
-- 資料模型矛盾收掉。
--
-- 前一個 migration：0017_inventory_purchases_adjustments.sql。既有 0001–0017
-- 一律不動（0009／0011 自己的檔頭也是這樣宣告的），要改行為就在這裡
-- `create or replace`。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 這個檔案要解掉三個問題，都不是搬運問題
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ── 問題一：套餐的組合價怎麼分攤到組成品項 ────────────────────────────────
--
-- 這是這一期唯一一個「答錯了不會有人發現，但會少付錢給寄賣廠商」的問題。
--
-- 來源的做法（pages/Sales.tsx:673，同一段在三個檔案裡各抄一份）：
--
--     const itemAmount    = isFirstItem ? comboItem.sellingPrice : 0;
--     const itemUnitPrice = isFirstItem ? comboItem.sellingPrice / item.quantity : 0;
--
-- **第一件吃掉全部營收，其餘每一件記 0。** 正式庫裡 215 筆套餐銷售列全都長這樣：
--
--     紅烏龍茶餅      82 列   營收 0       FIFO 成本 574   ← 看起來純虧損
--     紅烏龍茶包-店內 40 列   營收 8,000   FIFO 成本 0     ← 看起來 100% 毛利
--
-- 兩件事同時錯：
--
--   1. **寄賣結帳會算錯。** 寄賣廠商的拆帳基礎是 inv.sales.amount。組成品項裡
--      只要有一件是 consignment 而它不是「第一件」，那家廠商這一單分到 NT$0。
--      這一期正式庫的套餐組成剛好全是 outright，所以還沒有人受害 —— 但
--      combo_set_items 是店員自己維護的，加一件寄賣品進去就中獎，而且沒有任何
--      東西會叫。
--   2. **「第一件」根本不是穩定的概念。** 來源抓 combo_set_items 沒有 order by
--      （ComboSaleTab.tsx:102），第一件由 PostgreSQL 的 heap 掃描順序決定。
--      VACUUM 一次、UPDATE 一次搬動 tuple，同一個套餐的全額就換一件商品去背。
--
-- **這一版選的口徑：依組成品項自身的「售價 × 數量」比例分攤，餘數用最大餘額法
--   補給權重最大的那一項。只要有任何一件的售價是 0，整個套餐退回「按數量均分」。**
--
-- 那條退路不是防呆，是這家店的常態。正式庫三個還在賣的套餐長這樣：
--
--     B1紅烏龍茶套餐 = [紅烏龍茶包-店內 售價 0] + [紅烏龍茶餅 售價 18]
--
-- 「-店內」那幾件的售價是 0，因為它們只在套餐裡出現，從來不單賣。純比例分攤會
-- 把 200 元全部記到茶餅頭上、茶包記 0 —— 那跟來源那個「第一件吃全額」一樣糟，
-- 只是換一個品項去背。相對售價法的前提是**每一件都有定價**；缺一件，這個方法就
-- 沒有輸入，這時候按數量均分才是誠實的答案（B1 變成 100 / 100）。
--
-- 反過來說，這也給了店家一個明確的行動：把組成品項的定價填好，分攤就會自動從
-- 均分切換成比例。後台的套餐頁會把「這個套餐用哪一種分攤」直接寫在畫面上。
--
-- 選它的四個理由：
--
--   a. 這是聯產品成本會計的標準做法（relative sales value method）。套餐的折扣
--      按各品項自身的貴重程度等比例吃下去，而不是集中在某一件身上。
--   b. 它讓每一件組成品項都拿得到非零營收，寄賣拆帳才有分母。
--   c. 最大餘額法保證 `sum(amount) = 套餐售價`，一分不多一分不少。這一條很重要：
--      **套餐層級的合計在新舊口徑下完全一樣**，所以既有 215 筆歷史資料與新資料
--      放在同一張報表裡加總不會打架，只有「逐品項」那一維的歸屬變了。
--   d. 它不需要任何新欄位。分攤結果就寫在 inv.sales.amount／unit_price 上，
--      跟單品銷售同一個欄位、同一個意思。
--
-- 不選「按成本比例分攤」是因為成本會隨 FIFO 批次浮動，同一個套餐今天賣跟明天賣
-- 的營收拆法會不一樣 —— 那對帳更難解釋。不選「均分」是因為一本 500 元的書跟一包
-- 18 元的茶包各記 100 元，寄賣廠商會問為什麼。
--
-- ⚠️ 歷史資料不動。那 215 筆維持「第一件吃全額」，就地凍結成歷史，理由與 0017
--    對 inventory_adjustments 的處理一樣：改寫歷史會讓已經結過的帳對不起來。
--    Phase 6 的對帳報表要逐欄比對時，記得 combo_sale_group 的分界線是這個
--    migration 的套用時間。
--
-- ── 問題二：套餐一次動多個品項，這是最容易死鎖的形狀 ──────────────────────
--
-- 0011 §「所有會動到某品項庫存的路徑，第一步都是依 id 排序 FOR UPDATE」。0004 的
-- atomic_deduct_stock、0011 的保留 ledger、0014 的 pos_checkout 都遵守。
--
-- 來源的套餐結帳**一條都沒有遵守**：它在瀏覽器裡跑三層 for 迴圈，每一件商品各發
-- 兩次 HTTP（先 rpc allocate_fifo_cost，再 insert），每一次 insert 各自是一個
-- 交易。兩個櫃檯同時賣兩個組成品項順序相反的套餐時：
--
--     終端 A：套餐甲 = [茶包, 茶餅]  → 先鎖茶包，再鎖茶餅
--     終端 B：套餐乙 = [茶餅, 茶包]  → 先鎖茶餅，再鎖茶包
--
-- 標準的 ABBA 死鎖。而且因為每一次 insert 是獨立交易，死鎖之前就已經有幾列寫進去
-- 了 —— 死鎖不會回捲那些，只會留下半個套餐。
--
-- inv_combo_checkout() 把整個套餐收進**一個**交易，而且第一件事就是把所有組成
-- 品項**依 id 排序**一次鎖完。順序由 id 決定，跟套餐怎麼定義無關，所以兩個套餐
-- 不管組成順序怎麼寫，拿鎖的順序都一樣。
--
-- 附帶好處：來源那個「allocate_fifo_cost 已經吃掉批次，但後面的 insert 失敗了」
-- 的漏帳窗口一起消失 —— 兩件事現在在同一個交易裡。
--
-- ── 問題三：二手書的資料模型有兩套，其中一套是死的 ────────────────────────
--
-- inv.update_stock_on_sale() 裡有一個 `v_product_type = 'secondhand'` 的分支，
-- 但 inv.products.product_type 的 CHECK 只允許 outright/consignment/rental。
-- 0009 搬遷時原樣保留並加註「兩者的關係要等搬 Sales 模組時當面查清楚」。
--
-- 查清楚了，答案是：**二手書根本沒有 inv.products 這一列。**
--
--   · 正式庫 45 筆 is_secondhand = true 的銷售，product_id 全部是 NULL，
--     cost_price 全部是 NULL（沒有進貨批次，也就沒有 FIFO 成本）。
--   · 來源的寫入只有一處（pages/Sales.tsx:286），明文寫著
--     `product_id: null, // No product linked`。
--   · 來源自己的 migration 史更直接：2026-01-26 早上那一支先把二手當成一種
--     product_type 寫了這個分支，**同一天下午**就改成「銷售列上的一個旗標、
--     不建商品」（DROP NOT NULL on product_id + ADD is_secondhand），但沒有把
--     早上那段拿掉。它從出生那天就是死的。
--
-- **所以選「刪死碼」，不選「補 CHECK」。** 補 CHECK 等於把一個已經被作者否決過
-- 的模型重新合法化，而且會多出一種「有庫存的二手商品」—— 那跟二手書一本一件、
-- 賣掉就沒了的實際情況相反，也跟現在 45 筆資料的形狀相反。
--
-- 刪掉之後行為一個字都沒變（那個分支本來就進不去），但下一個讀這段程式的人不會
-- 再花半天去想「二手商品的庫存是怎麼算的」。
--
-- 同時補一條真正該有的 CHECK：**is_secondhand = true 的列，product_id 必須是
-- NULL**。反過來不成立（product_id 是 NULL 但不是二手的列現在有 1 筆 —— 那是
-- sales_product_id_fkey 的 ON DELETE SET NULL 造出來的，商品被刪了、銷售還在），
-- 所以只擋單向。擋的是「拿一件真商品當二手賣」：那會靜默跳過扣庫存。

begin;

-- ---------------------------------------------------------------------------
-- 1. 二手書：刪死碼
-- ---------------------------------------------------------------------------
-- 兩支函式各有一個 product_type = 'secondhand' 的判斷，方向還相反（一支是 `=`
-- 早退，一支是 `!=` 包住 UPDATE）。兩個都是 no-op，但長得不像對方，下一個人會
-- 以為它們語意不同。一起拿掉。
--
-- ⚠️ 真正生效的二手判斷是第一句 `NEW.product_id IS NULL OR NEW.is_secondhand`，
--    那一句留著，一個字都不動。

create or replace function inv.update_stock_on_sale()
returns trigger
language plpgsql
security definer
set search_path to 'inv', 'public'
as $$
DECLARE
  v_product_type text;
  v_base_product_id uuid;
  v_pack_size integer;
  v_deduct_product_id uuid;
  v_deduct_quantity integer;
  v_stock integer;
  v_reserved integer;
  v_available integer;
BEGIN
  -- 二手書：沒有商品列，也就沒有庫存可扣。這一句是真正生效的那個判斷。
  IF NEW.product_id IS NULL OR NEW.is_secondhand = true THEN
    RETURN NEW;
  END IF;

  SELECT product_type, base_product_id, pack_size
  INTO v_product_type, v_base_product_id, v_pack_size
  FROM inv.products
  WHERE id = NEW.product_id;

  -- 0009／0011 這裡本來還有一個 `v_product_type = 'secondhand'` 的分支。它從
  -- 來源系統出生那天就進不去（CHECK 只允許 outright/consignment/rental），
  -- 0018 刪掉。商品列不見了還是要早退 —— 那是 FK 的 ON DELETE SET NULL 造出來
  -- 的孤兒列，扣不到庫存。
  IF v_product_type IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_base_product_id IS NOT NULL THEN
    v_deduct_product_id := v_base_product_id;
    v_deduct_quantity := NEW.quantity * COALESCE(v_pack_size, 1);
  ELSE
    v_deduct_product_id := NEW.product_id;
    v_deduct_quantity := NEW.quantity;
  END IF;

  -- ---- 先鎖目標列，再算可售量（同一條規矩） ------------------------------
  -- 套餐走 inv_combo_checkout() 時這一列已經被鎖住了（那支先依 id 排序鎖完
  -- 全部組成品項）。同一個交易再鎖一次是 no-op，不會自我死鎖。
  SELECT stock_quantity INTO v_stock
    FROM inv.products
   WHERE id = v_deduct_product_id
     FOR UPDATE;

  SELECT COALESCE(SUM(r.quantity), 0)::integer INTO v_reserved
    FROM public.stock_reservations r
   WHERE r.inv_product_id = v_deduct_product_id;

  v_available := COALESCE(v_stock, 0) - v_reserved;

  IF COALESCE(NEW.channel, 'pos') = 'pos'
     AND COALESCE(NEW.override_reservation, false) = false THEN
    IF v_available < v_deduct_quantity THEN
      RAISE EXCEPTION 'INSUFFICIENT_STOCK:%', v_deduct_product_id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF COALESCE(NEW.override_reservation, false) = true
        AND v_available < v_deduct_quantity THEN
    -- 逃生門留痕。order_id 是 NULL：櫃檯的強制放行沒有對應的網路訂單。
    INSERT INTO public.stock_oversold_alerts
      (order_id, inv_product_id, shortfall, source, sale_id)
    VALUES
      (NULL, v_deduct_product_id, v_deduct_quantity - v_available, 'pos_override', NEW.id);
  END IF;

  UPDATE inv.products
  SET stock_quantity = stock_quantity - v_deduct_quantity
  WHERE id = v_deduct_product_id;

  RETURN NEW;
END;
$$;

comment on function inv.update_stock_on_sale() is
  '銷售扣庫存（AFTER INSERT on inv.sales）。二手書由第一句的 is_secondhand/product_id IS NULL 早退。0018 刪掉了 product_type = ''secondhand'' 那個永遠不成立的分支。';

-- 沖銷那一支的對稱處理。它原本用 `!=` 包住整段還原，效果同樣是「永遠會執行」。
create or replace function inv.rollback_fifo_cost()
returns trigger
language plpgsql
security definer
set search_path to 'inv', 'public'
as $$
DECLARE
  v_remaining integer;
  v_batch RECORD;
  v_give_back integer;
  v_base_product_id uuid;
  v_pack_size integer;
  v_product_type text;
  v_actual_product_id uuid;
  v_actual_quantity integer;
BEGIN
  -- 與 update_stock_on_sale 同一句判斷：二手書沒有商品列、沒有批次、沒有庫存。
  IF OLD.product_id IS NULL OR OLD.is_secondhand = true THEN
    RETURN OLD;
  END IF;

  SELECT base_product_id, pack_size, product_type
  INTO v_base_product_id, v_pack_size, v_product_type
  FROM inv.products
  WHERE id = OLD.product_id;

  -- 商品已經被刪掉（FK ON DELETE SET NULL 之前的競態）→ 沒有東西可以還。
  IF v_product_type IS NULL THEN
    RETURN OLD;
  END IF;

  IF v_base_product_id IS NOT NULL THEN
    v_actual_product_id := v_base_product_id;
    v_actual_quantity := OLD.quantity * COALESCE(v_pack_size, 1);
  ELSE
    v_actual_product_id := OLD.product_id;
    v_actual_quantity := OLD.quantity;
  END IF;

  -- 庫存加回去。先鎖再改，與扣的那一側同一條規矩。
  PERFORM 1 FROM inv.products WHERE id = v_actual_product_id FOR UPDATE;

  UPDATE inv.products
  SET stock_quantity = stock_quantity + v_actual_quantity
  WHERE id = v_actual_product_id;

  -- FIFO 批次還原：由新往舊補，正好是 allocate_fifo_cost 消耗順序的反向。
  v_remaining := v_actual_quantity;

  FOR v_batch IN
    SELECT id, quantity, remaining_quantity
    FROM inv.purchases
    WHERE product_id = v_actual_product_id
      AND remaining_quantity < quantity
    ORDER BY purchase_date DESC, created_at DESC
  LOOP
    IF v_remaining <= 0 THEN
      EXIT;
    END IF;

    v_give_back := LEAST(v_remaining, v_batch.quantity - v_batch.remaining_quantity);

    UPDATE inv.purchases
    SET remaining_quantity = remaining_quantity + v_give_back
    WHERE id = v_batch.id;

    v_remaining := v_remaining - v_give_back;
  END LOOP;

  RETURN OLD;
END;
$$;

comment on function inv.rollback_fifo_cost() is
  '刪除銷售時還原庫存與 FIFO 批次（BEFORE DELETE on inv.sales）。0018 刪掉了 product_type != ''secondhand'' 那個永遠成立的判斷。';

-- ---------------------------------------------------------------------------
-- 1b. 二手書：補上該有的那條 CHECK
-- ---------------------------------------------------------------------------
-- 只擋單向：is_secondhand = true → product_id 必須是 NULL。
--
-- 反向不擋，因為 sales_product_id_fkey 是 ON DELETE SET NULL，刪一件商品就會
-- 製造出「product_id IS NULL 但 is_secondhand = false」的列（正式庫現在有 1 筆）。
-- 那種列是歷史殘留，不是錯誤。
--
-- 擋的是「拿一件真商品當二手賣」：update_stock_on_sale 的第一句會因為
-- is_secondhand 早退，於是庫存靜默不扣 —— 帳面上東西還在，架上已經沒了。
alter table inv.sales
  drop constraint if exists sales_secondhand_has_no_product;

alter table inv.sales
  add constraint sales_secondhand_has_no_product
  check (is_secondhand = false or product_id is null);

comment on constraint sales_secondhand_has_no_product on inv.sales is
  '二手書不進 inv.products（一本一件、沒有批次、沒有庫存），所以 is_secondhand 的列不可以掛著 product_id —— 那會讓 update_stock_on_sale 靜默跳過扣庫存。反向不擋：FK 的 ON DELETE SET NULL 會製造 product_id IS NULL 的非二手歷史列。';

-- ---------------------------------------------------------------------------
-- 2. 套餐：資料模型補強
-- ---------------------------------------------------------------------------
-- 0009 建這兩張表時什麼 CHECK 都沒有：售價可以是負的、組成數量可以是 0 或負的、
-- approval_status 可以是任何字串。下面三條都先對現有 6 + 6 筆驗過。

alter table inv.combo_sets
  drop constraint if exists combo_sets_selling_price_non_negative;
alter table inv.combo_sets
  add constraint combo_sets_selling_price_non_negative
  check (selling_price >= 0);

alter table inv.combo_sets
  drop constraint if exists combo_sets_approval_status_check;
alter table inv.combo_sets
  add constraint combo_sets_approval_status_check
  check (approval_status = any (array['pending', 'approved', 'rejected']));

alter table inv.combo_set_items
  drop constraint if exists combo_set_items_positive_quantity;
alter table inv.combo_set_items
  add constraint combo_set_items_positive_quantity
  check (quantity > 0);

comment on column inv.combo_sets.selling_price is
  '整個套餐的組合價。0018 起由 inv.allocate_combo_amounts() 依組成品項自身售價比例分攤到每一列 inv.sales.amount，加總必等於這個數字。';

-- ---------------------------------------------------------------------------
-- 3. 分攤：inv.allocate_combo_amounts()
-- ---------------------------------------------------------------------------
-- 純函式（immutable），不碰任何表 —— 好處是可以單獨拿測試資料餵它驗算，不必先
-- 建一個套餐。輸入是「已經依 product_id 排好序」的權重陣列，輸出是同樣長度的
-- 金額陣列。
--
-- 「權重要怎麼算」不在這裡，在 inv_combo_checkout()：那裡才知道售價缺不缺。
-- 這支只負責「給我一組權重，我把總額分乾淨」，全 0 時退回均分當安全網。
--
-- 演算法（最大餘額法 / Hare quota）：
--   1. 權重 wᵢ 由呼叫端給。全部為 0 時這裡自己退回均分（不能除以 0，而且
--      「都沒填就都不分」會讓整筆營收憑空消失）。
--   2. 理想值 rᵢ = P × wᵢ / Σw，先各取 floor 到「分」（這裡是整數元，見下）。
--   3. 剩下的餘額一元一元發給小數部分最大的那幾項；小數部分相同時發給權重大的，
--      再相同時發給位置在前的（陣列已依 product_id 排序，所以這是決定性的）。
--
-- ⚠️ 為什麼取整到「元」而不是「分」：inv.sales.unit_price 與 amount 是
--    numeric(10,2)，但這家店的售價全是整數元，而且來源的組合價也都是整數
--    （正式庫 6 個套餐全是 200）。取整到元讓收據上不會出現 66.67 這種數字。
--    如果哪天出現有小數的組合價，下面的 v_scale 改成 100 就好，其餘不用動。
create or replace function inv.allocate_combo_amounts(
  p_total   numeric,
  p_weights numeric[]
)
returns numeric[]
language plpgsql
immutable
as $$
DECLARE
  v_scale     integer := 1;      -- 1 = 取整到元；改成 100 就是取整到分
  v_n         integer;
  v_sum       numeric := 0;
  v_units     bigint;            -- 整個組合價換算成「最小單位」的個數
  v_assigned  bigint := 0;
  v_base      bigint[];
  v_frac      numeric[];
  v_out       numeric[];
  v_i         integer;
  v_best      integer;
  v_ideal     numeric;
BEGIN
  v_n := coalesce(array_length(p_weights, 1), 0);
  IF v_n = 0 THEN
    RETURN array[]::numeric[];
  END IF;

  IF p_total IS NULL OR p_total < 0 THEN
    RAISE EXCEPTION 'COMBO_BAD_TOTAL: 套餐售價不可為負數';
  END IF;

  FOR v_i IN 1 .. v_n LOOP
    IF p_weights[v_i] IS NULL OR p_weights[v_i] < 0 THEN
      RAISE EXCEPTION 'COMBO_BAD_WEIGHT: 分攤權重不可為負數';
    END IF;
    v_sum := v_sum + p_weights[v_i];
  END LOOP;

  v_units := round(p_total * v_scale)::bigint;

  -- 權重全是 0（例如組成品項的售價都沒填）→ 退回均分。這裡不能除以 0，而且
  -- 「都沒填就都不分」會讓整筆營收憑空消失。
  IF v_sum = 0 THEN
    FOR v_i IN 1 .. v_n LOOP
      v_base[v_i] := v_units / v_n;
      v_frac[v_i] := (v_units % v_n)::numeric / v_n;  -- 全部一樣，靠位置決勝
      v_assigned := v_assigned + v_base[v_i];
    END LOOP;
  ELSE
    FOR v_i IN 1 .. v_n LOOP
      v_ideal := (v_units::numeric * p_weights[v_i]) / v_sum;
      v_base[v_i] := floor(v_ideal)::bigint;
      v_frac[v_i] := v_ideal - floor(v_ideal);
      v_assigned := v_assigned + v_base[v_i];
    END LOOP;
  END IF;

  -- 餘額一單位一單位發出去。最多發 v_n - 1 次（floor 的總損失小於 n），
  -- 但寫成 while 比較安全 —— 均分那一支的餘額也是 < n。
  WHILE v_assigned < v_units LOOP
    v_best := 1;
    FOR v_i IN 2 .. v_n LOOP
      IF v_frac[v_i] > v_frac[v_best]
         OR (v_frac[v_i] = v_frac[v_best] AND p_weights[v_i] > p_weights[v_best]) THEN
        v_best := v_i;
      END IF;
    END LOOP;
    v_base[v_best] := v_base[v_best] + 1;
    -- 拿過的那一項要退出競爭，否則餘額會全部堆到同一件商品上。
    v_frac[v_best] := -1;
    v_assigned := v_assigned + 1;
  END LOOP;

  FOR v_i IN 1 .. v_n LOOP
    v_out[v_i] := v_base[v_i]::numeric / v_scale;
  END LOOP;

  RETURN v_out;
END;
$$;

comment on function inv.allocate_combo_amounts(numeric, numeric[]) is
  '把套餐組合價依權重分攤成每一件的金額，最大餘額法，保證 sum(結果) = p_total。權重全 0 時均分。純函式，不碰表。';

revoke execute on function inv.allocate_combo_amounts(numeric, numeric[]) from public;
revoke execute on function inv.allocate_combo_amounts(numeric, numeric[]) from anon, authenticated;
grant  execute on function inv.allocate_combo_amounts(numeric, numeric[]) to service_role;

-- ---------------------------------------------------------------------------
-- 4. 套餐結帳：public.inv_combo_checkout()
-- ---------------------------------------------------------------------------
-- 一個套餐、一個交易、一次鎖完。
--
-- 順序（**不可以換**）：
--   1. 讀套餐本身，順便擋掉停用／未審核的。
--   2. 讀組成品項，**依 product_id 排序**。
--   3. 對這些 product_id **依 id 排序** FOR UPDATE 一次鎖完 —— 防死鎖唯一的機制。
--      注意鎖的是「要扣庫存的那一列」，母子品項的話是母品項（base_product_id）。
--   4. 算分攤。
--   5. 依同樣的順序 insert，讓 trigger 去扣庫存與吃 FIFO 批次。
--
-- ⚠️ 這支不自己 UPDATE inv.products.stock_quantity，也不自己呼叫
--    allocate_fifo_cost。庫存由 on_sale_insert 扣、成本由
--    allocate_fifo_before_sale_insert 算 —— 與單品銷售完全同一條路。多一條路
--    就會多一種扣兩次的方法（0017 的問題一就是這樣來的）。
--
-- ⚠️ 不收 approval_status、不收 cost_price、不收 amount。呼叫端能決定的只有
--    「賣哪個套餐、幾份、什麼時候、用什麼付款」。金額是這裡算的。
create or replace function public.inv_combo_checkout(
  p_user_id           uuid,
  p_combo_set_id      uuid,
  p_quantity          integer,
  p_sale_date         date,
  p_payment_method_id uuid    default null,
  p_notes             text    default null,
  p_override_reservation boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'inv', 'public'
as $$
DECLARE
  v_combo       record;
  v_items       record;
  v_product_ids uuid[] := '{}';
  v_lock_ids    uuid[] := '{}';
  v_weights     numeric[] := '{}';
  v_amounts     numeric[];
  v_qtys        integer[] := '{}';
  v_n           integer;
  v_i           integer;
  v_set         integer;
  v_group       uuid;
  v_sale_id     uuid;
  v_sale_ids    uuid[] := '{}';
  v_group_ids   uuid[] := '{}';
  v_total       numeric := 0;
  v_cost        numeric := 0;
  v_row_cost    numeric;
  v_zero_price  boolean := false;
  v_basis       text;
BEGIN
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 100 THEN
    RAISE EXCEPTION 'COMBO_BAD_QUANTITY: 份數必須是 1 到 100 之間的整數';
  END IF;

  -- ---- 1. 套餐本身 -------------------------------------------------------
  SELECT id, name, selling_price, is_active, approval_status
  INTO v_combo
  FROM inv.combo_sets
  WHERE id = p_combo_set_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMBO_NOT_FOUND: 找不到這個套餐';
  END IF;
  IF v_combo.is_active = false THEN
    RAISE EXCEPTION 'COMBO_INACTIVE: 「%」已停用，不能販售', v_combo.name;
  END IF;
  -- 來源只看 is_active（ComboSaleTab.tsx:94），所以待審核的套餐照賣不誤 ——
  -- 審核流程對營收完全沒有效力。這裡補上。
  IF v_combo.approval_status <> 'approved' THEN
    RAISE EXCEPTION 'COMBO_NOT_APPROVED: 「%」尚未通過審核，不能販售', v_combo.name;
  END IF;

  -- ---- 2. 組成品項，依 product_id 排序 -----------------------------------
  -- 排序是這一整支函式的地基：它同時決定拿鎖的順序（防死鎖）與陣列的位置
  -- （讓分攤結果是決定性的）。來源這一段沒有 order by。
  FOR v_items IN
    SELECT i.product_id,
           i.quantity                                   as item_qty,
           coalesce(p.selling_price, 0)                 as unit_selling_price,
           coalesce(p.base_product_id, i.product_id)    as lock_id,
           p.name                                       as product_name,
           p.is_active                                  as product_active
    FROM inv.combo_set_items i
    JOIN inv.products p ON p.id = i.product_id
    WHERE i.combo_set_id = p_combo_set_id
    ORDER BY i.product_id
  LOOP
    IF v_items.product_active = false THEN
      RAISE EXCEPTION 'COMBO_ITEM_INACTIVE: 組成品項「%」已停用，套餐不能販售',
        v_items.product_name;
    END IF;
    IF v_items.unit_selling_price <= 0 THEN
      v_zero_price := true;
    END IF;
    v_product_ids := v_product_ids || v_items.product_id;
    v_lock_ids    := v_lock_ids    || v_items.lock_id;
    v_qtys        := v_qtys        || v_items.item_qty;
    v_weights     := v_weights     || (v_items.unit_selling_price * v_items.item_qty);
  END LOOP;

  v_n := coalesce(array_length(v_product_ids, 1), 0);
  IF v_n = 0 THEN
    -- 正式庫有三個這樣的套餐（A1/A2/A3，組成品項被刪光了但歷史銷售還在）。
    -- 賣一個空套餐等於收錢不出貨。
    RAISE EXCEPTION 'COMBO_NO_ITEMS: 「%」沒有設定組成品項，不能販售', v_combo.name;
  END IF;

  -- ---- 3. 依 id 排序，一次鎖完 -------------------------------------------
  -- 這是 0004 atomic_deduct_stock / 0011 保留 ledger / 0014 pos_checkout 的
  -- 同一條規矩。鎖的是要扣庫存的那一列（母子品項時是母品項），而且用 distinct
  -- ——同一個母品項被兩件子品項共用時只鎖一次。
  PERFORM 1
  FROM (SELECT DISTINCT unnest(v_lock_ids) AS id) t
  JOIN inv.products p ON p.id = t.id
  ORDER BY p.id
  FOR UPDATE OF p;

  -- ---- 4. 分攤 -----------------------------------------------------------
  -- 相對售價法的前提是每一件都有定價。缺一件（這家店的「-店內」品項售價都是 0），
  -- 整組退回按數量均分 —— 不能只把缺的那件記 0，那跟來源「第一件吃全額」一樣是
  -- 把營收憑空挪到別的品項上，只是換一個品項去背。見檔頭問題一。
  IF v_zero_price THEN
    v_weights := '{}';
    FOR v_i IN 1 .. v_n LOOP
      v_weights := v_weights || v_qtys[v_i]::numeric;
    END LOOP;
    v_basis := 'quantity';
  ELSE
    v_basis := 'list_price';
  END IF;

  v_amounts := inv.allocate_combo_amounts(v_combo.selling_price, v_weights);

  -- ---- 5. 寫入 -----------------------------------------------------------
  -- 每一份套餐一個 combo_sale_group（與來源一致：買三份 = 三個 group，
  -- 退貨時可以只退其中一份）。
  FOR v_set IN 1 .. p_quantity LOOP
    v_group := gen_random_uuid();
    v_group_ids := v_group_ids || v_group;

    FOR v_i IN 1 .. v_n LOOP
      INSERT INTO inv.sales (
        user_id, product_id, sale_date, quantity,
        unit_price, amount, cost_price,
        combo_set_id, combo_sale_group,
        payment_method_id, notes, channel, override_reservation
      ) VALUES (
        p_user_id,
        v_product_ids[v_i],
        p_sale_date,
        v_qtys[v_i],
        -- unit_price × quantity 必須等於 amount，否則報表的兩種營收口徑會打架
        -- （0014 §毛利那段講的就是這件事）。分攤到元、數量是整數，所以這裡
        -- 用 numeric 相除再交給 numeric(10,2) 存，不會有浮點誤差。
        round(v_amounts[v_i] / v_qtys[v_i], 2),
        v_amounts[v_i],
        NULL,   -- ← 讓 allocate_fifo_before_sale_insert 去算，與單品同一條路
        p_combo_set_id,
        v_group,
        p_payment_method_id,
        p_notes,
        'pos',
        p_override_reservation
      )
      RETURNING id, cost_price INTO v_sale_id, v_row_cost;

      v_sale_ids := v_sale_ids || v_sale_id;
      v_cost := v_cost + coalesce(v_row_cost, 0) * v_qtys[v_i];
    END LOOP;

    v_total := v_total + v_combo.selling_price;
  END LOOP;

  RETURN jsonb_build_object(
    'combo_set_id',  p_combo_set_id,
    'combo_name',    v_combo.name,
    'sets',          p_quantity,
    'sale_ids',      to_jsonb(v_sale_ids),
    'sale_groups',   to_jsonb(v_group_ids),
    'total_amount',  v_total,
    'total_cost',    v_cost,
    -- 'list_price' = 依定價比例；'quantity' = 有品項沒定價，退回按數量均分。
    -- 前端把這個字直接寫在結帳結果上，店員才知道錢是怎麼拆的。
    'basis',         v_basis,
    'allocation',    (
      SELECT jsonb_agg(jsonb_build_object(
               'product_id', v_product_ids[i],
               'quantity',   v_qtys[i],
               'amount',     v_amounts[i]
             ) ORDER BY i)
      FROM generate_series(1, v_n) AS i
    )
  );
END;
$$;

comment on function public.inv_combo_checkout(uuid, uuid, integer, date, uuid, text, boolean) is
  '套餐結帳。整份一個交易；先依 id 排序把所有組成品項 FOR UPDATE 鎖完（防兩個組成順序相反的套餐同時賣時死鎖），再依自身售價比例分攤組合價。庫存與 FIFO 成本都交給 inv.sales 的 trigger，這裡不自己扣。';

revoke execute on function public.inv_combo_checkout(uuid, uuid, integer, date, uuid, text, boolean) from public;
revoke execute on function public.inv_combo_checkout(uuid, uuid, integer, date, uuid, text, boolean) from anon, authenticated;
grant  execute on function public.inv_combo_checkout(uuid, uuid, integer, date, uuid, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 5. 二手書結帳：public.inv_secondhand_checkout()
-- ---------------------------------------------------------------------------
-- 對照組：這一支刻意什麼庫存都不碰，因為二手書沒有商品列。它存在的理由是
-- 「銷售的所有寫入都走 SECURITY DEFINER 函式」這條規矩 —— 讓 repo 層永遠不需要
-- 直接 insert inv.sales。
create or replace function public.inv_secondhand_checkout(
  p_user_id           uuid,
  p_item_name         text,
  p_quantity          integer,
  p_unit_price        numeric,
  p_sale_date         date,
  p_payment_method_id uuid default null,
  p_notes             text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'inv', 'public'
as $$
DECLARE
  v_name   text := nullif(btrim(p_item_name), '');
  v_amount numeric;
  v_id     uuid;
BEGIN
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'SECONDHAND_NO_NAME: 請填書名';
  END IF;
  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 999 THEN
    RAISE EXCEPTION 'SECONDHAND_BAD_QUANTITY: 數量必須是 1 到 999 之間的整數';
  END IF;
  IF p_unit_price IS NULL OR p_unit_price < 0 THEN
    RAISE EXCEPTION 'SECONDHAND_BAD_PRICE: 售價不可為負數';
  END IF;

  v_amount := round(p_unit_price, 2) * p_quantity;

  INSERT INTO inv.sales (
    user_id, product_id, is_secondhand, item_name,
    sale_date, quantity, unit_price, amount, cost_price,
    payment_method_id, notes, channel
  ) VALUES (
    p_user_id,
    NULL,        -- ← 二手書不建商品列。這是整個模型的重點，見檔頭問題三。
    true,
    v_name,
    p_sale_date,
    p_quantity,
    round(p_unit_price, 2),
    v_amount,
    NULL,        -- ← 沒有進貨批次就沒有 FIFO 成本。trigger 也會早退。
    p_payment_method_id,
    p_notes,
    'pos'
  )
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'sale_id',   v_id,
    'item_name', v_name,
    'quantity',  p_quantity,
    'amount',    v_amount
  );
END;
$$;

comment on function public.inv_secondhand_checkout(uuid, text, integer, numeric, date, uuid, text) is
  '二手書結帳。product_id 一定是 NULL、cost_price 一定是 NULL —— 二手書不進 inv.products，所以沒有庫存也沒有 FIFO 成本。';

revoke execute on function public.inv_secondhand_checkout(uuid, text, integer, numeric, date, uuid, text) from public;
revoke execute on function public.inv_secondhand_checkout(uuid, text, integer, numeric, date, uuid, text) from anon, authenticated;
grant  execute on function public.inv_secondhand_checkout(uuid, text, integer, numeric, date, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. 套餐維護：存檔／停用／刪除／重新送審
-- ---------------------------------------------------------------------------
-- 與 0016 對 products 的六支寫入函式同一個形狀：approval_status 在資料庫算，
-- 呼叫端連這個 key 都送不進來。
create or replace function public.inv_save_combo_set(
  p_user_id uuid,
  p_id      uuid,
  p_payload jsonb,
  p_items   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'inv', 'public'
as $$
DECLARE
  v_id            uuid;
  v_created       boolean := false;
  v_name          text := nullif(btrim(p_payload->>'name'), '');
  v_price         numeric := coalesce((p_payload->>'selling_price')::numeric, 0);
  v_notes         text := nullif(btrim(coalesce(p_payload->>'notes', '')), '');
  v_is_active     boolean := coalesce((p_payload->>'is_active')::boolean, true);
  v_status        text;
  v_old_price     numeric;
  v_old_status    text;
  v_item          jsonb;
  v_item_count    integer := 0;
  v_seen          uuid[] := '{}';
  v_pid           uuid;
  v_qty           integer;
BEGIN
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'COMBO_NO_NAME: 請填套餐名稱';
  END IF;
  IF v_price < 0 THEN
    RAISE EXCEPTION 'COMBO_BAD_PRICE: 套餐售價不可為負數';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'COMBO_NO_ITEMS: 套餐至少要有一件組成品項';
  END IF;

  IF p_id IS NULL THEN
    -- 新增：狀態由 0016 那支 fail-closed 的函式決定。
    v_status := inv.initial_approval_status('combo_sets');

    INSERT INTO inv.combo_sets (user_id, name, selling_price, notes, is_active, approval_status)
    VALUES (p_user_id, v_name, v_price, v_notes, v_is_active, v_status)
    RETURNING id INTO v_id;

    v_created := true;
  ELSE
    SELECT selling_price, approval_status
    INTO v_old_price, v_old_status
    FROM inv.combo_sets
    WHERE id = p_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'COMBO_NOT_FOUND: 找不到這個套餐';
    END IF;

    -- 來源的 updateMutation 從來不重設 approval_status（ComboSets.tsx:274）：
    -- 把一個已核准套餐的售價從 200 改成 20，它還是 approved，直接生效。
    -- 這裡：**改到價錢就重新送審**（審核有開的話）。改名字、改備註不算。
    IF v_old_price IS DISTINCT FROM v_price
       AND inv.initial_approval_status('combo_sets') = 'pending' THEN
      v_status := 'pending';
    ELSE
      v_status := v_old_status;
    END IF;

    UPDATE inv.combo_sets
    SET name            = v_name,
        selling_price   = v_price,
        notes           = v_notes,
        is_active       = v_is_active,
        approval_status = v_status,
        -- 重新送審就把上一次的核准痕跡清掉，否則畫面會顯示「待審核，核准人 XXX」
        approved_by     = CASE WHEN v_status = 'pending' THEN NULL ELSE approved_by END,
        approved_at     = CASE WHEN v_status = 'pending' THEN NULL ELSE approved_at END,
        updated_at      = now()
    WHERE id = p_id;

    v_id := p_id;
  END IF;

  -- 組成品項整組換掉。逐筆比對沒有意義（沒有穩定的 item id 給前端），而且
  -- delete + insert 在同一個交易裡，中途不會有「套餐暫時沒有組成品項」的狀態。
  DELETE FROM inv.combo_set_items WHERE combo_set_id = v_id;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_pid := (v_item->>'product_id')::uuid;
    v_qty := coalesce((v_item->>'quantity')::integer, 1);

    IF v_pid IS NULL THEN
      RAISE EXCEPTION 'COMBO_BAD_ITEM: 組成品項缺少商品';
    END IF;
    IF v_qty < 1 THEN
      RAISE EXCEPTION 'COMBO_BAD_ITEM: 組成品項的數量必須大於 0';
    END IF;
    IF v_pid = ANY(v_seen) THEN
      RAISE EXCEPTION 'COMBO_DUP_ITEM: 同一件商品不可以在套餐裡出現兩次（請改數量）';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM inv.products WHERE id = v_pid) THEN
      RAISE EXCEPTION 'COMBO_BAD_ITEM: 組成品項指向一件不存在的商品';
    END IF;

    v_seen := v_seen || v_pid;
    INSERT INTO inv.combo_set_items (combo_set_id, product_id, quantity)
    VALUES (v_id, v_pid, v_qty);
    v_item_count := v_item_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'id', v_id,
    'created', v_created,
    'approval_status', coalesce(v_status, 'approved'),
    'item_count', v_item_count
  );
END;
$$;

comment on function public.inv_save_combo_set(uuid, uuid, jsonb, jsonb) is
  '新增／編輯套餐。approval_status 由 inv.initial_approval_status() 算，payload 裡送這個 key 沒有任何一行程式會讀它。改動售價會重新送審 —— 來源不會，於是改價可以繞過審核。';

revoke execute on function public.inv_save_combo_set(uuid, uuid, jsonb, jsonb) from public;
revoke execute on function public.inv_save_combo_set(uuid, uuid, jsonb, jsonb) from anon, authenticated;
grant  execute on function public.inv_save_combo_set(uuid, uuid, jsonb, jsonb) to service_role;

create or replace function public.inv_set_combo_set_active(
  p_id        uuid,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path to 'inv', 'public'
as $$
DECLARE
  v_name text;
BEGIN
  UPDATE inv.combo_sets
  SET is_active = p_is_active, updated_at = now()
  WHERE id = p_id
  RETURNING name INTO v_name;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMBO_NOT_FOUND: 找不到這個套餐';
  END IF;

  RETURN jsonb_build_object('id', p_id, 'name', v_name, 'is_active', p_is_active);
END;
$$;

revoke execute on function public.inv_set_combo_set_active(uuid, boolean) from public;
revoke execute on function public.inv_set_combo_set_active(uuid, boolean) from anon, authenticated;
grant  execute on function public.inv_set_combo_set_active(uuid, boolean) to service_role;

create or replace function public.inv_delete_combo_set(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'inv', 'public'
as $$
DECLARE
  v_name  text;
  v_sales integer;
BEGIN
  SELECT name INTO v_name FROM inv.combo_sets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMBO_NOT_FOUND: 找不到這個套餐';
  END IF;

  SELECT count(*)::integer INTO v_sales FROM inv.sales WHERE combo_set_id = p_id;
  IF v_sales > 0 THEN
    -- sales_combo_set_id_fkey 沒有 ON DELETE 動作，所以刪下去會被 FK 擋成一句
    -- 英文錯誤。這裡先擋，講一句店員看得懂的話，並指出正確做法。
    RAISE EXCEPTION 'COMBO_HAS_SALES: 「%」已經有 % 筆銷售紀錄，不能刪除。請改成停用。',
      v_name, v_sales;
  END IF;

  DELETE FROM inv.combo_sets WHERE id = p_id;  -- items 由 ON DELETE CASCADE 帶走
  RETURN jsonb_build_object('id', p_id, 'name', v_name);
END;
$$;

revoke execute on function public.inv_delete_combo_set(uuid) from public;
revoke execute on function public.inv_delete_combo_set(uuid) from anon, authenticated;
grant  execute on function public.inv_delete_combo_set(uuid) to service_role;

create or replace function public.inv_resubmit_combo_set(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'inv', 'public'
as $$
DECLARE
  v_name text;
BEGIN
  UPDATE inv.combo_sets
  SET approval_status = 'pending', approved_by = NULL, approved_at = NULL, updated_at = now()
  WHERE id = p_id AND approval_status = 'rejected'
  RETURNING name INTO v_name;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMBO_NOT_REJECTED: 只有被退回的套餐可以重新送審';
  END IF;

  RETURN jsonb_build_object('id', p_id, 'name', v_name);
END;
$$;

revoke execute on function public.inv_resubmit_combo_set(uuid) from public;
revoke execute on function public.inv_resubmit_combo_set(uuid) from anon, authenticated;
grant  execute on function public.inv_resubmit_combo_set(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. 唯讀 view
-- ---------------------------------------------------------------------------
-- 理由同 0012／0014／0016／0017：inv 不在 PostgREST 的 db_schema 裡，所以連
-- service_role 的 supabase-js client 都打不到 inv.*。要讀就得從 public 開一扇窗。
--
-- ⚠️ 全部 security_invoker = false，所以 grant 給誰就是全部的防線。
--
-- ⚠️ 這三支是 `drop + create`，不是 `create or replace`。理由：`create or replace
--    view` **不能改欄位的名稱或順序**（"cannot change name of view column"），
--    所以只要有人日後在中間插一欄，重跑這個檔案就會炸在半路。這三個 view 都是
--    0018 新建的，沒有任何東西 depend on 它們，drop 是安全的。下面的 revoke／
--    grant 在 create 之後才跑，所以權限不會有空窗。

drop view if exists public.inv_admin_combo_sets cascade;
create view public.inv_admin_combo_sets
with (security_invoker = false) as
select
  cs.id                as combo_set_id,
  cs.name              as name,
  cs.selling_price     as selling_price,
  cs.is_active         as is_active,
  cs.notes             as notes,
  cs.approval_status   as approval_status,
  cs.approved_at       as approved_at,
  approver.name        as approved_by_name,
  cs.user_id           as user_id,
  creator.name         as creator_name,
  cs.created_at        as created_at,
  cs.updated_at        as updated_at,
  coalesce(items.item_count, 0)      as item_count,
  coalesce(items.total_list_price, 0) as total_list_price,
  -- 這一份套餐賣出去時錢會怎麼拆。與 inv_combo_checkout() 裡的判斷同一條規則
  -- （只要有一件沒定價就整組均分），讓店員在賣之前就看得到，而不是事後對帳才發現。
  case when coalesce(items.item_count, 0) = 0 then null
       when coalesce(items.zero_priced, 0) > 0 then 'quantity'
       else 'list_price' end          as allocation_basis,
  coalesce(items.zero_priced, 0)      as zero_priced_items,
  -- 這一份套餐最多還能組幾份。母子品項時看母品項的庫存，而且要除以 pack_size。
  items.max_sets                     as max_sets,
  coalesce(sold.sale_groups, 0)      as sold_sets,
  coalesce(sold.revenue, 0)          as sold_revenue
from inv.combo_sets cs
left join inv.profiles creator  on creator.user_id  = cs.user_id
left join inv.profiles approver on approver.user_id = cs.approved_by
left join lateral (
  select count(*)::integer                                        as item_count,
         sum(coalesce(p.selling_price, 0) * i.quantity)           as total_list_price,
         count(*) filter (where coalesce(p.selling_price, 0) <= 0)::integer as zero_priced,
         min(
           floor(
             greatest(coalesce(base.stock_quantity, p.stock_quantity), 0)::numeric
             / (i.quantity * case when p.base_product_id is null then 1
                                  else greatest(coalesce(p.pack_size, 1), 1) end)
           )
         )::integer                                               as max_sets
  from inv.combo_set_items i
  join inv.products p on p.id = i.product_id
  left join inv.products base on base.id = p.base_product_id
  where i.combo_set_id = cs.id
) items on true
left join lateral (
  select count(distinct s.combo_sale_group)::integer as sale_groups,
         sum(s.amount)                               as revenue
  from inv.sales s
  where s.combo_set_id = cs.id
) sold on true;

comment on view public.inv_admin_combo_sets is
  '後台的套餐清單。max_sets 是「還能再組幾份」（取組成品項庫存的最小值），sold_sets 數的是 combo_sale_group 的個數而不是列數。只給 service_role。';

drop view if exists public.inv_admin_combo_set_items cascade;
create view public.inv_admin_combo_set_items
with (security_invoker = false) as
select
  i.id                          as item_id,
  i.combo_set_id                as combo_set_id,
  i.product_id                  as product_id,
  i.quantity                    as quantity,
  p.name                        as product_name,
  p.issue_number                as issue_number,
  p.series                      as series,
  p.product_type                as product_type,
  coalesce(p.selling_price, 0)  as selling_price,
  p.is_active                   as product_active,
  p.base_product_id             as base_product_id,
  greatest(coalesce(p.pack_size, 1), 1) as pack_size,
  coalesce(base.stock_quantity, p.stock_quantity) as stock_quantity
from inv.combo_set_items i
join inv.products p on p.id = i.product_id
left join inv.products base on base.id = p.base_product_id;

comment on view public.inv_admin_combo_set_items is
  '套餐的組成品項。selling_price 是分攤權重的來源（見 inv.allocate_combo_amounts）。只給 service_role。';

-- 套餐銷售明細：把同一個 combo_sale_group 的列收成一份。來源那兩支報表元件
-- （ComboSetSalesReport / ComboSetSalesDetailDialog）都是抓全表回前端再 group，
-- 而且各自抄了一份加總公式。這裡一個 view 一份定義。
drop view if exists public.inv_admin_combo_sales cascade;
create view public.inv_admin_combo_sales
with (security_invoker = false) as
select
  s.combo_sale_group                       as sale_group,
  s.combo_set_id                           as combo_set_id,
  cs.name                                  as combo_name,
  min(s.sale_date)                         as sale_date,
  min(s.created_at)                        as created_at,
  count(*)::integer                        as row_count,
  sum(s.amount)                            as revenue,
  sum(coalesce(s.cost_price, 0) * s.quantity) as cost,
  sum(s.amount) - sum(coalesce(s.cost_price, 0) * s.quantity) as gross_profit,
  -- user_id 與付款方式在同一個 group 裡必然相同（一次 inv_combo_checkout 寫出來
  -- 的），所以放進 group by 而不是聚合。⚠️ 不要改用 min(s.user_id)：PostgreSQL
  -- 沒有 min(uuid)，那會讓整個 migration 在套用時才炸。
  s.user_id                                as user_id,
  operator.name                            as operator_name,
  pm.name                                  as payment_method_name
from inv.sales s
join inv.combo_sets cs on cs.id = s.combo_set_id
left join inv.profiles operator on operator.user_id = s.user_id
left join inv.payment_methods pm on pm.id = s.payment_method_id
where s.combo_sale_group is not null
group by s.combo_sale_group, s.combo_set_id, cs.name, s.user_id, operator.name, pm.name;

comment on view public.inv_admin_combo_sales is
  '套餐銷售，一個 combo_sale_group 一列。營收與成本在這裡加總 —— 逐列看的話，2026-08 以前的舊資料是「第一件吃全額、其餘記 0」，只有加總才對得起來。只給 service_role。';

revoke all on public.inv_admin_combo_sets      from anon, authenticated;
revoke all on public.inv_admin_combo_set_items from anon, authenticated;
revoke all on public.inv_admin_combo_sales     from anon, authenticated;

grant select on public.inv_admin_combo_sets      to service_role;
grant select on public.inv_admin_combo_set_items to service_role;
grant select on public.inv_admin_combo_sales     to service_role;

-- ---------------------------------------------------------------------------
-- 8. OCR 掃描圖的私有 bucket
-- ---------------------------------------------------------------------------
-- 與 0003 的 site-images **不一樣**：那個是 public read（前台要顯示），這個是
-- private。理由兩條：
--
--   1. 進貨單上有廠商名稱、單價、聯絡資訊。0009 §0 為了 inv.vendors 的身分證
--      字號把整個 inv schema 移出 PostgREST；把同一批資訊拍成照片放進一個
--      公開 bucket 等於從後門送出去。
--   2. 辨識失敗時要有原圖可以回溯（「AI 說單價 50，單子上到底寫什麼」）。所以
--      圖不能是丟完就忘的暫存，得留著，那就更不能公開。
--
-- 一樣是零 storage.objects policy：只有 service_role 讀得到、寫得到。前端拿到的
-- 是一個 signed URL（有效期由 src/server/storage.ts 決定），不是永久網址。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ocr-scans',
  'ocr-scans',
  false,   -- ← 與 site-images 唯一的關鍵差別
  4194304, -- 4 MiB。書封壓到 2000px WebP 大約 200KB，進貨單放寬一點。
  array['image/webp', 'image/jpeg', 'image/png']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

commit;

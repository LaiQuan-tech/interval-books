-- 0009_inventory_schema.sql —— 進銷存 schema（inv）
--
-- ⚠️ 這個檔案是產生出來的，不要手改。改法是改 scripts/rewrite-inv-schema.mjs
-- 再重跑：
--   pg_restore --schema-only --schema=public --no-owner -f /tmp/src.sql <備份>
--   node scripts/rewrite-inv-schema.mjs /tmp/src.sql -o supabase/migrations/0009_inventory_schema.sql
--
-- 來源：小時光書店進銷存（Lovable / Supabase 專案 qbxonowiwatriqrfflkr）
--       備份 bookstock_260815.backup，PostgreSQL 17.6，21 張表 2,864 筆
--
-- ── 為什麼是 inv，不是 public ────────────────────────────────────────────
-- 這個專案的 PostgREST 只掛 db_schema = "public,graphql_public"。放進 inv 之後
-- 瀏覽器**結構上**就打不到進銷存的表 —— 不管拿到哪把 key、不管 RLS 怎麼設，
-- PostgREST 根本不會把 inv 掛出去。這件事之所以要緊，是因為 inv.vendors 有 48 欄，
-- 裡面有身分證字號、統一編號、銀行帳戶。
--
-- 由此推出這個檔案的三個刻意選擇：
--   1. 來源的 83 條 RLS policy 一條都不搬 —— inv 不對外，policy 沒有作用對象。
--   2. anon / authenticated 對 inv 零 grant，連 USAGE ON SCHEMA 都沒有。
--   3. 每張表仍然 ENABLE ROW LEVEL SECURITY 且零 policy。這不是多餘：萬一
--      哪天有人手滑把 inv 加進 db_schema，RLS 預設拒絕會是第二道門。
--      （與 0002_admin.sql:56 對 public.profiles 的做法一致。）
--
-- ── 相對來源的三處行為修正（都在改寫腳本裡，有註解）────────────────────
--   * inventory_adjustments 只留一個 trigger（來源兩個綁同一個函式，INSERT 會
--     重複扣加庫存兩次）
--   * generate_stock_adjustment_number() / generate_vendor_return_number()
--     改成「沒有單號才產號」（來源無條件覆寫，每次 UPDATE 都會跳號）
--   * update_stock_on_sale() 的 secondhand 死碼原樣保留，只加註解
--
-- 前一個 migration：0008_invoice_cron.sql。既有 0001–0008 一律不動。

begin;

-- LANGUAGE sql 的函式在 CREATE 時會被驗證，而 pg_dump 把函式排在資料表前面，
-- 所以 is_admin() / has_permission() 這幾支會參照到還沒建立的 inv.profiles。
-- pg_dump 自己也是靠這一行過關的。
set check_function_bodies = false;

-- ---------------------------------------------------------------------------
-- 0. schema 與權限地基
-- ---------------------------------------------------------------------------
create schema if not exists inv;

comment on schema inv is
  '小時光書店進銷存（2026-08 從 Lovable 專案搬入）。刻意不在 PostgREST 的 db_schema 裡，瀏覽器結構上打不到。只有 service_role 進得來。';

-- 先關門再蓋房子：後面所有物件都在門關著的情況下建立。
revoke all on schema inv from anon, authenticated;
revoke all on schema inv from public;
grant usage on schema inv to service_role;

--
-- Name: allocate_fifo_cost(uuid, uuid, integer); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.allocate_fifo_cost(p_product_id uuid, p_user_id uuid, p_sale_quantity integer) RETURNS numeric
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
DECLARE
  v_remaining integer;
  v_total_cost numeric := 0;
  v_batch RECORD;
  v_take integer;
  v_base_product_id uuid;
  v_pack_size integer;
  v_actual_product_id uuid;
  v_actual_quantity integer;
BEGIN
  -- Check if product has a base product
  SELECT base_product_id, pack_size 
  INTO v_base_product_id, v_pack_size
  FROM inv.products
  WHERE id = p_product_id;
  
  IF v_base_product_id IS NOT NULL THEN
    v_actual_product_id := v_base_product_id;
    v_actual_quantity := p_sale_quantity * COALESCE(v_pack_size, 1);
  ELSE
    v_actual_product_id := p_product_id;
    v_actual_quantity := p_sale_quantity;
  END IF;
  
  v_remaining := v_actual_quantity;
  
  FOR v_batch IN 
    SELECT id, unit_cost, remaining_quantity
    FROM inv.purchases
    WHERE product_id = v_actual_product_id
      AND remaining_quantity > 0
    ORDER BY purchase_date ASC, created_at ASC
  LOOP
    IF v_remaining <= 0 THEN
      EXIT;
    END IF;
    
    v_take := LEAST(v_remaining, v_batch.remaining_quantity);
    v_total_cost := v_total_cost + (v_take * COALESCE(v_batch.unit_cost, 0));
    v_remaining := v_remaining - v_take;
    
    UPDATE inv.purchases
    SET remaining_quantity = remaining_quantity - v_take
    WHERE id = v_batch.id;
  END LOOP;
  
  IF p_sale_quantity > 0 THEN
    RETURN v_total_cost / p_sale_quantity;
  ELSE
    RETURN 0;
  END IF;
END;
$$;
--
-- Name: can_modify_record(uuid); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.can_modify_record(record_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
BEGIN
  -- 如果是管理員，可以修改任何記錄
  IF EXISTS (
    SELECT 1 FROM inv.profiles 
    WHERE user_id = auth.uid() AND is_admin = true
  ) THEN
    RETURN true;
  END IF;
  
  -- 如果是記錄的建立者，可以修改
  IF record_user_id = auth.uid() THEN
    RETURN true;
  END IF;
  
  RETURN false;
END;
$$;
--
-- Name: ensure_single_default_payment_method(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.ensure_single_default_payment_method() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
BEGIN
  -- If the new row is being set as default, unset all other defaults
  IF NEW.is_default = true THEN
    UPDATE inv.payment_methods
    SET is_default = false
    WHERE id != NEW.id AND is_default = true;
  END IF;
  RETURN NEW;
END;
$$;
--
-- Name: generate_stock_adjustment_number(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.generate_stock_adjustment_number() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
DECLARE
  v_date_str text;
  v_seq integer;
  v_number text;
BEGIN
  -- 只在單號還沒有值的時候才產號。原版是無條件覆寫，配上 BEFORE INSERT
  -- 的觸發時機，任何一次 UPDATE 都會重新產號並讓序號跳號。
  IF NEW.adjustment_number IS NULL OR NEW.adjustment_number = '' THEN
    v_date_str := to_char(COALESCE(NEW.adjustment_date, CURRENT_DATE), 'YYYYMMDD');
    v_seq := nextval('inv.stock_adjustment_seq');
    v_number := 'ADJ-' || v_date_str || '-' || LPAD(v_seq::text, 3, '0');
    NEW.adjustment_number := v_number;
  END IF;
  RETURN NEW;
END;
$$;
--
-- Name: generate_vendor_code(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.generate_vendor_code() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
DECLARE
  prefix TEXT;
  seq_num INTEGER;
BEGIN
  -- 根據實體類型決定前綴
  CASE NEW.entity_type
    WHEN 'domestic_company' THEN prefix := 'VC-';
    WHEN 'domestic_individual' THEN prefix := 'VI-';
    WHEN 'foreign' THEN prefix := 'VF-';
    WHEN 'foreign_individual' THEN prefix := 'VFI-';
    ELSE prefix := 'V-';
  END CASE;
  
  -- 取得序號
  seq_num := nextval('inv.vendor_code_seq');
  
  -- 組合編號
  NEW.vendor_code := prefix || LPAD(seq_num::TEXT, 5, '0');
  
  RETURN NEW;
END;
$$;
--
-- Name: generate_vendor_return_number(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.generate_vendor_return_number() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
DECLARE
  v_date_str text;
  v_seq integer;
BEGIN
  -- 同 generate_stock_adjustment_number()：只在沒有單號時才產號。
  IF NEW.return_number IS NULL OR NEW.return_number = '' THEN
    v_date_str := to_char(COALESCE(NEW.return_date, CURRENT_DATE), 'YYYYMMDD');
    v_seq := nextval('inv.vendor_return_seq');
    NEW.return_number := 'VR-' || v_date_str || '-' || LPAD(v_seq::text, 3, '0');
  END IF;
  RETURN NEW;
END;
$$;
--
-- Name: get_all_display_names(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.get_all_display_names() RETURNS TABLE(user_id uuid, display_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
  SELECT user_id, COALESCE(name, '') as display_name FROM inv.profiles;
$$;
--
-- Name: get_user_display_name(uuid); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.get_user_display_name(_user_id uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
  SELECT COALESCE(name, '') FROM inv.profiles WHERE user_id = _user_id LIMIT 1;
$$;
--
-- Name: has_permission(uuid, text); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.has_permission(_user_id uuid, _permission text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
  SELECT inv.is_admin() OR EXISTS (
    SELECT 1 FROM inv.user_permissions
    WHERE user_id = _user_id AND permission = _permission
  )
$$;
--
-- Name: is_admin(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.is_admin() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM inv.profiles 
    WHERE user_id = auth.uid() AND is_admin = true
  );
END;
$$;
--
-- Name: is_approved(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.is_approved() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM inv.profiles 
    WHERE user_id = auth.uid() AND is_approved = true
  );
END;
$$;
--
-- Name: prevent_confirmed_adjustment_delete(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.prevent_confirmed_adjustment_delete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
BEGIN
  IF OLD.status = 'confirmed' THEN
    RAISE EXCEPTION '已確認的異動單據不可刪除，請使用沖帳功能';
  END IF;
  RETURN OLD;
END;
$$;
--
-- Name: prevent_privilege_escalation(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.prevent_privilege_escalation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
BEGIN
  -- If the user is an admin, allow any changes
  IF EXISTS (
    SELECT 1 FROM inv.profiles 
    WHERE user_id = auth.uid() AND is_admin = true
  ) THEN
    RETURN NEW;
  END IF;

  -- For non-admins: block changes to is_admin and is_approved
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
    RAISE EXCEPTION '權限不足：無法變更管理員狀態';
  END IF;

  IF NEW.is_approved IS DISTINCT FROM OLD.is_approved THEN
    RAISE EXCEPTION '權限不足：無法變更核准狀態';
  END IF;

  RETURN NEW;
END;
$$;
--
-- Name: rollback_fifo_cost(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.rollback_fifo_cost() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
DECLARE
  v_remaining integer;
  v_batch RECORD;
  v_give_back integer;
  v_product_type text;
  v_base_product_id uuid;
  v_pack_size integer;
  v_deduct_product_id uuid;
  v_deduct_quantity integer;
BEGIN
  IF OLD.product_id IS NULL OR OLD.is_secondhand = true THEN
    RETURN OLD;
  END IF;
  
  SELECT product_type, base_product_id, pack_size 
  INTO v_product_type, v_base_product_id, v_pack_size
  FROM inv.products
  WHERE id = OLD.product_id;
  
  -- Determine which product to restore and how much
  IF v_base_product_id IS NOT NULL THEN
    v_deduct_product_id := v_base_product_id;
    v_deduct_quantity := OLD.quantity * COALESCE(v_pack_size, 1);
  ELSE
    v_deduct_product_id := OLD.product_id;
    v_deduct_quantity := OLD.quantity;
  END IF;
  
  IF v_product_type IS NULL OR v_product_type != 'secondhand' THEN
    UPDATE inv.products
    SET stock_quantity = stock_quantity + v_deduct_quantity
    WHERE id = v_deduct_product_id;
  END IF;
  
  v_remaining := v_deduct_quantity;
  
  FOR v_batch IN 
    SELECT id, quantity, remaining_quantity
    FROM inv.purchases
    WHERE product_id = v_deduct_product_id
      AND remaining_quantity < quantity
    ORDER BY purchase_date DESC, created_at DESC
  LOOP
    IF v_remaining <= 0 THEN
      EXIT;
    END IF;
    
    v_give_back := LEAST(v_remaining, v_batch.quantity - v_batch.remaining_quantity);
    v_remaining := v_remaining - v_give_back;
    
    UPDATE inv.purchases
    SET remaining_quantity = remaining_quantity + v_give_back
    WHERE id = v_batch.id;
  END LOOP;
  
  RETURN OLD;
END;
$$;
--
-- Name: stock_adjustment_insert_confirm(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.stock_adjustment_insert_confirm() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
BEGIN
  IF NEW.status = 'confirmed' THEN
    UPDATE inv.products
    SET stock_quantity = stock_quantity + NEW.quantity
    WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;
--
-- Name: sync_vendor_to_product(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.sync_vendor_to_product() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
BEGIN
  -- 只在進貨有設定 vendor_id 時執行
  IF NEW.vendor_id IS NOT NULL THEN
    -- 更新商品主檔的 vendor_id（僅當商品尚未設定供應商時）
    UPDATE inv.products
    SET vendor_id = NEW.vendor_id,
        updated_at = now()
    WHERE id = NEW.product_id
      AND vendor_id IS NULL;
  END IF;
  
  RETURN NEW;
END;
$$;
--
-- Name: update_stock_on_adjustment(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.update_stock_on_adjustment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
BEGIN
  -- On INSERT: only adjust stock if approved
  IF TG_OP = 'INSERT' THEN
    IF NEW.approval_status = 'approved' THEN
      UPDATE inv.products
      SET stock_quantity = stock_quantity + NEW.quantity
      WHERE id = NEW.product_id;
    END IF;
    RETURN NEW;
  END IF;
  
  -- On UPDATE: if approval_status changed to 'approved', adjust stock
  IF TG_OP = 'UPDATE' THEN
    IF OLD.approval_status != 'approved' AND NEW.approval_status = 'approved' THEN
      UPDATE inv.products
      SET stock_quantity = stock_quantity + NEW.quantity
      WHERE id = NEW.product_id;
    END IF;
    RETURN NEW;
  END IF;
  
  RETURN NEW;
END;
$$;
--
-- Name: update_stock_on_purchase(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.update_stock_on_purchase() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
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
  
  -- On UPDATE: if approval_status changed to 'approved', add stock
  IF TG_OP = 'UPDATE' THEN
    IF OLD.approval_status != 'approved' AND NEW.approval_status = 'approved' THEN
      NEW.remaining_quantity := NEW.quantity;
      UPDATE inv.products
      SET stock_quantity = stock_quantity + NEW.quantity
      WHERE id = NEW.product_id;
    END IF;
    RETURN NEW;
  END IF;
  
  RETURN NEW;
END;
$$;
--
-- Name: update_stock_on_sale(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.update_stock_on_sale() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
DECLARE
  v_product_type text;
  v_base_product_id uuid;
  v_pack_size integer;
  v_deduct_product_id uuid;
  v_deduct_quantity integer;
BEGIN
  IF NEW.product_id IS NULL OR NEW.is_secondhand = true THEN
    RETURN NEW;
  END IF;
  
  SELECT product_type, base_product_id, pack_size 
  INTO v_product_type, v_base_product_id, v_pack_size
  FROM inv.products
  WHERE id = NEW.product_id;
  
  -- ⚠️ 死碼，刻意保留（2026-08 搬遷）：products.product_type 的 CHECK 只允許
  -- outright/consignment/rental，所以 = 'secondhand' 這個分支永遠不成立。
  -- 但 sales.is_secondhand 欄位是活的（來源前端 SecondhandSaleDialog.tsx 在用），
  -- 上面那段 IF NEW.is_secondhand = true 才是真正生效的二手判斷。
  -- 兩者的關係要等搬 Sales 模組時當面查清楚，這一期原樣保留、不改行為。
  IF v_product_type IS NULL OR v_product_type = 'secondhand' THEN
    RETURN NEW;
  END IF;
  
  -- Determine which product to deduct from and how much
  IF v_base_product_id IS NOT NULL THEN
    v_deduct_product_id := v_base_product_id;
    v_deduct_quantity := NEW.quantity * COALESCE(v_pack_size, 1);
  ELSE
    v_deduct_product_id := NEW.product_id;
    v_deduct_quantity := NEW.quantity;
  END IF;
  
  UPDATE inv.products
  SET stock_quantity = stock_quantity - v_deduct_quantity
  WHERE id = v_deduct_product_id;
  
  RETURN NEW;
END;
$$;
--
-- Name: update_stock_on_stock_adjustment(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.update_stock_on_stock_adjustment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
BEGIN
  -- Trigger on status change to 'confirmed' from 'pending_approval'
  IF OLD.status IN ('draft', 'pending_approval') AND NEW.status = 'confirmed' THEN
    UPDATE inv.products
    SET stock_quantity = stock_quantity + NEW.quantity
    WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;
--
-- Name: update_stock_on_vendor_return_confirm(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.update_stock_on_vendor_return_confirm() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
DECLARE
  v_item RECORD;
  v_base_product_id uuid;
  v_pack_size integer;
  v_deduct_product_id uuid;
  v_deduct_quantity integer;
BEGIN
  -- Only trigger when status changes to confirmed
  IF OLD.status = 'draft' AND NEW.status = 'confirmed' THEN
    FOR v_item IN
      SELECT ri.product_id, ri.quantity
      FROM inv.vendor_return_items ri
      WHERE ri.vendor_return_id = NEW.id
    LOOP
      -- Check for base product linkage
      SELECT base_product_id, pack_size
      INTO v_base_product_id, v_pack_size
      FROM inv.products
      WHERE id = v_item.product_id;

      IF v_base_product_id IS NOT NULL THEN
        v_deduct_product_id := v_base_product_id;
        v_deduct_quantity := v_item.quantity * COALESCE(v_pack_size, 1);
      ELSE
        v_deduct_product_id := v_item.product_id;
        v_deduct_quantity := v_item.quantity;
      END IF;

      UPDATE inv.products
      SET stock_quantity = stock_quantity - v_deduct_quantity
      WHERE id = v_deduct_product_id;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: inv; Owner: -
--

CREATE FUNCTION inv.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inv', 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--
-- Name: approval_settings; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.approval_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    module text NOT NULL,
    is_enabled boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid
);
--
-- Name: categories; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    icon text,
    display_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--
-- Name: combo_set_items; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.combo_set_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    combo_set_id uuid NOT NULL,
    product_id uuid NOT NULL,
    quantity integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--
-- Name: combo_sets; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.combo_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    selling_price numeric DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    approval_status text DEFAULT 'pending'::text NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone
);
--
-- Name: products; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.products (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    category_id uuid,
    name text NOT NULL,
    cost_price numeric(10,2) DEFAULT 0,
    selling_price numeric(10,2) DEFAULT 0,
    stock_quantity integer DEFAULT 0 NOT NULL,
    low_stock_alert integer DEFAULT 1,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    barcode text,
    product_type text DEFAULT 'outright'::text NOT NULL,
    publisher text,
    issue_number text,
    series text,
    vendor_id uuid,
    approval_status text DEFAULT 'pending'::text NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    pending_cost_price numeric,
    pending_selling_price numeric,
    price_change_status text,
    price_change_requested_by uuid,
    price_change_requested_at timestamp with time zone,
    pack_size integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    base_product_id uuid,
    CONSTRAINT positive_cost_price CHECK ((cost_price >= (0)::numeric)),
    CONSTRAINT positive_selling_price CHECK ((selling_price >= (0)::numeric)),
    CONSTRAINT products_product_type_check CHECK ((product_type = ANY (ARRAY['outright'::text, 'consignment'::text, 'rental'::text])))
);
--
-- Name: COLUMN products.product_type; Type: COMMENT; Schema: inv; Owner: -
--

COMMENT ON COLUMN inv.products.product_type IS '商品類型: outright=買斷, consignment=寄賣, rental=租借(展示用)';
--
-- Name: COLUMN products.issue_number; Type: COMMENT; Schema: inv; Owner: -
--

COMMENT ON COLUMN inv.products.issue_number IS '期數，用於區分同名但不同期的雜誌或刊物';
--
-- Name: COLUMN products.vendor_id; Type: COMMENT; Schema: inv; Owner: -
--

COMMENT ON COLUMN inv.products.vendor_id IS 'Reference to vendor for consignment products';
--
-- Name: purchases; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.purchases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    product_id uuid NOT NULL,
    purchase_date date DEFAULT CURRENT_DATE NOT NULL,
    quantity integer NOT NULL,
    unit_cost numeric(10,2),
    vendor text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    publisher text,
    remaining_quantity integer DEFAULT 0,
    vendor_id uuid,
    expiry_date date,
    expiry_alert_days integer DEFAULT 7,
    approval_status text DEFAULT 'pending'::text NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    item_name text,
    CONSTRAINT non_negative_unit_cost CHECK ((unit_cost >= (0)::numeric)),
    CONSTRAINT positive_purchase_quantity CHECK ((quantity > 0))
);
--
-- Name: expiring_purchases; Type: VIEW; Schema: inv; Owner: -
--

CREATE VIEW inv.expiring_purchases WITH (security_invoker='on') AS
 SELECT p.id AS purchase_id,
    p.product_id,
    p.expiry_date,
    p.expiry_alert_days,
    p.remaining_quantity,
    p.quantity,
    p.purchase_date,
    p.user_id,
    pr.name AS product_name,
    pr.issue_number,
    pr.series,
    (p.expiry_date - CURRENT_DATE) AS days_until_expiry,
        CASE
            WHEN (p.expiry_date < CURRENT_DATE) THEN 'expired'::text
            WHEN ((p.expiry_date - CURRENT_DATE) <= p.expiry_alert_days) THEN 'warning'::text
            ELSE 'ok'::text
        END AS expiry_status
   FROM (inv.purchases p
     JOIN inv.products pr ON ((pr.id = p.product_id)))
  WHERE ((p.expiry_date IS NOT NULL) AND (p.remaining_quantity > 0))
  ORDER BY p.expiry_date;
--
-- Name: VIEW expiring_purchases; Type: COMMENT; Schema: inv; Owner: -
--

COMMENT ON VIEW inv.expiring_purchases IS 'View for tracking expiring purchase batches with security_invoker';
--
-- Name: inventory_adjustments; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.inventory_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    product_id uuid NOT NULL,
    adjustment_date date DEFAULT CURRENT_DATE NOT NULL,
    adjustment_type text NOT NULL,
    quantity integer NOT NULL,
    reason text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    approval_status text DEFAULT 'pending'::text NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    stock_before integer,
    CONSTRAINT inventory_adjustments_adjustment_type_check CHECK ((adjustment_type = ANY (ARRAY['shrinkage'::text, 'surplus'::text])))
);
--
-- Name: payment_methods; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.payment_methods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    display_order integer DEFAULT 0,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fee_category text DEFAULT 'none'::text NOT NULL,
    is_default boolean DEFAULT false NOT NULL
);
--
-- Name: profiles; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_approved boolean DEFAULT false NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    email text,
    name text
);
--
-- Name: sales; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.sales (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    product_id uuid,
    sale_date date DEFAULT CURRENT_DATE NOT NULL,
    quantity integer NOT NULL,
    unit_price numeric(10,2),
    amount numeric(10,2),
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cost_price numeric,
    is_secondhand boolean DEFAULT false NOT NULL,
    item_name text,
    combo_set_id uuid,
    combo_sale_group uuid,
    payment_method_id uuid,
    is_reconciled boolean DEFAULT false NOT NULL,
    reconciled_at timestamp with time zone,
    reconciled_by uuid,
    CONSTRAINT non_negative_unit_price CHECK ((unit_price >= (0)::numeric)),
    CONSTRAINT positive_quantity CHECK ((quantity > 0))
);
--
-- Name: stock_adjustment_seq; Type: SEQUENCE; Schema: inv; Owner: -
--

CREATE SEQUENCE inv.stock_adjustment_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--
-- Name: stock_adjustments; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.stock_adjustments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    adjustment_number text,
    user_id uuid NOT NULL,
    product_id uuid NOT NULL,
    adjustment_date date DEFAULT CURRENT_DATE NOT NULL,
    category text NOT NULL,
    quantity integer NOT NULL,
    unit_cost numeric,
    total_cost numeric,
    status text DEFAULT 'draft'::text NOT NULL,
    reversal_of uuid,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    CONSTRAINT non_zero_quantity CHECK ((quantity <> 0))
);
--
-- Name: tax_types; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.tax_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    rate numeric(5,2) DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--
-- Name: user_permissions; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.user_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    permission text NOT NULL,
    granted_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--
-- Name: vendor_attachments; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.vendor_attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    file_name text NOT NULL,
    file_path text NOT NULL,
    file_type text NOT NULL,
    file_size bigint,
    description text,
    storage_type text DEFAULT 'supabase'::text NOT NULL,
    uploaded_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attachment_type text DEFAULT 'general'::text NOT NULL,
    contract_start_date date,
    contract_end_date date,
    contract_version text,
    is_current boolean DEFAULT false
);
--
-- Name: vendor_bank_accounts; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.vendor_bank_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    account_holder_name text NOT NULL,
    bank_code text NOT NULL,
    bank_name text NOT NULL,
    branch_code text,
    branch_name text,
    account_number text NOT NULL,
    account_purpose text,
    is_default boolean DEFAULT false,
    notes text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--
-- Name: vendor_categories; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.vendor_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--
-- Name: vendor_code_seq; Type: SEQUENCE; Schema: inv; Owner: -
--

CREATE SEQUENCE inv.vendor_code_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--
-- Name: vendor_contacts; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.vendor_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    name text NOT NULL,
    job_title text,
    phone text,
    mobile text,
    email text,
    is_primary boolean DEFAULT false,
    is_finance_contact boolean DEFAULT false,
    notes text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--
-- Name: vendor_return_items; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.vendor_return_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_return_id uuid NOT NULL,
    product_id uuid NOT NULL,
    quantity integer DEFAULT 0 NOT NULL,
    unit_cost numeric DEFAULT 0,
    subtotal numeric DEFAULT 0,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--
-- Name: vendor_return_seq; Type: SEQUENCE; Schema: inv; Owner: -
--

CREATE SEQUENCE inv.vendor_return_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
--
-- Name: vendor_returns; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.vendor_returns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_id uuid NOT NULL,
    return_number text,
    return_date date DEFAULT CURRENT_DATE NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    notes text,
    total_quantity integer DEFAULT 0,
    total_cost numeric DEFAULT 0,
    created_by uuid NOT NULL,
    confirmed_by uuid,
    confirmed_at timestamp with time zone,
    settled_by uuid,
    settled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);
--
-- Name: vendors; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.vendors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    vendor_code text NOT NULL,
    entity_type text NOT NULL,
    category_id uuid,
    name text NOT NULL,
    name_en text,
    short_name text,
    representative text,
    tax_id text,
    id_number text,
    foreign_id text,
    foreign_id_type text,
    residence_permit_number text,
    taiwan_residency_status text,
    country_code text,
    phone text,
    fax text,
    email text,
    address text,
    address_en text,
    default_tax_type_id uuid,
    default_withholding_category_id uuid,
    is_nhi_applicable boolean DEFAULT false,
    voucher_category text DEFAULT 'invoice'::text,
    einvoice_type text DEFAULT 'none'::text,
    invoice_address text,
    payment_terms text DEFAULT 'immediate'::text,
    payment_terms_note text,
    settlement_type text DEFAULT 'invoice_date'::text,
    settlement_start_day integer,
    settlement_interval_days integer,
    bill_due_day integer,
    contact_employee_id uuid,
    status text DEFAULT 'active'::text NOT NULL,
    is_preferred boolean DEFAULT false,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    is_consignment boolean DEFAULT false NOT NULL,
    cash_fee_rate numeric DEFAULT 0.08,
    domestic_card_fee_rate numeric DEFAULT 0.101,
    foreign_card_fee_rate numeric DEFAULT 0.1115,
    commission_rate numeric,
    approval_status text DEFAULT 'pending'::text NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    CONSTRAINT valid_einvoice_type CHECK ((einvoice_type = ANY (ARRAY['none'::text, 'b2b'::text, 'b2c'::text]))),
    CONSTRAINT valid_entity_type CHECK ((entity_type = ANY (ARRAY['domestic_company'::text, 'domestic_individual'::text, 'foreign'::text, 'foreign_individual'::text]))),
    CONSTRAINT valid_payment_terms CHECK ((payment_terms = ANY (ARRAY['immediate'::text, 'monthly'::text, 'negotiated'::text]))),
    CONSTRAINT valid_settlement_type CHECK ((settlement_type = ANY (ARRAY['invoice_date'::text, 'end_of_month'::text, 'monthly'::text]))),
    CONSTRAINT valid_status CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'inactive'::text]))),
    CONSTRAINT valid_taiwan_residency CHECK (((taiwan_residency_status IS NULL) OR (taiwan_residency_status = ANY (ARRAY['over_183'::text, 'under_183'::text])))),
    CONSTRAINT valid_voucher_category CHECK ((voucher_category = ANY (ARRAY['invoice'::text, 'receipt'::text, 'official_document'::text, 'labor_payment'::text, 'none'::text])))
);
--
-- Name: COLUMN vendors.commission_rate; Type: COMMENT; Schema: inv; Owner: -
--

COMMENT ON COLUMN inv.vendors.commission_rate IS 'Commission rate for commission-based vendors (stored as decimal, e.g. 0.3 = 30%)';
--
-- Name: withholding_categories; Type: TABLE; Schema: inv; Owner: -
--

CREATE TABLE inv.withholding_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);
--
-- Name: approval_settings approval_settings_module_key; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.approval_settings
    ADD CONSTRAINT approval_settings_module_key UNIQUE (module);
--
-- Name: approval_settings approval_settings_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.approval_settings
    ADD CONSTRAINT approval_settings_pkey PRIMARY KEY (id);
--
-- Name: categories categories_name_key; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.categories
    ADD CONSTRAINT categories_name_key UNIQUE (name);
--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);
--
-- Name: combo_set_items combo_set_items_combo_set_id_product_id_key; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.combo_set_items
    ADD CONSTRAINT combo_set_items_combo_set_id_product_id_key UNIQUE (combo_set_id, product_id);
--
-- Name: combo_set_items combo_set_items_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.combo_set_items
    ADD CONSTRAINT combo_set_items_pkey PRIMARY KEY (id);
--
-- Name: combo_sets combo_sets_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.combo_sets
    ADD CONSTRAINT combo_sets_pkey PRIMARY KEY (id);
--
-- Name: inventory_adjustments inventory_adjustments_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.inventory_adjustments
    ADD CONSTRAINT inventory_adjustments_pkey PRIMARY KEY (id);
--
-- Name: payment_methods payment_methods_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.payment_methods
    ADD CONSTRAINT payment_methods_pkey PRIMARY KEY (id);
--
-- Name: products products_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);
--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
--
-- Name: profiles profiles_user_id_key; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.profiles
    ADD CONSTRAINT profiles_user_id_key UNIQUE (user_id);
--
-- Name: purchases purchases_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.purchases
    ADD CONSTRAINT purchases_pkey PRIMARY KEY (id);
--
-- Name: sales sales_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.sales
    ADD CONSTRAINT sales_pkey PRIMARY KEY (id);
--
-- Name: stock_adjustments stock_adjustments_adjustment_number_key; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.stock_adjustments
    ADD CONSTRAINT stock_adjustments_adjustment_number_key UNIQUE (adjustment_number);
--
-- Name: stock_adjustments stock_adjustments_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.stock_adjustments
    ADD CONSTRAINT stock_adjustments_pkey PRIMARY KEY (id);
--
-- Name: tax_types tax_types_code_key; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.tax_types
    ADD CONSTRAINT tax_types_code_key UNIQUE (code);
--
-- Name: tax_types tax_types_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.tax_types
    ADD CONSTRAINT tax_types_pkey PRIMARY KEY (id);
--
-- Name: user_permissions user_permissions_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.user_permissions
    ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (id);
--
-- Name: user_permissions user_permissions_user_id_permission_key; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.user_permissions
    ADD CONSTRAINT user_permissions_user_id_permission_key UNIQUE (user_id, permission);
--
-- Name: vendor_attachments vendor_attachments_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendor_attachments
    ADD CONSTRAINT vendor_attachments_pkey PRIMARY KEY (id);
--
-- Name: vendor_bank_accounts vendor_bank_accounts_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendor_bank_accounts
    ADD CONSTRAINT vendor_bank_accounts_pkey PRIMARY KEY (id);
--
-- Name: vendor_categories vendor_categories_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendor_categories
    ADD CONSTRAINT vendor_categories_pkey PRIMARY KEY (id);
--
-- Name: vendor_contacts vendor_contacts_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendor_contacts
    ADD CONSTRAINT vendor_contacts_pkey PRIMARY KEY (id);
--
-- Name: vendor_return_items vendor_return_items_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendor_return_items
    ADD CONSTRAINT vendor_return_items_pkey PRIMARY KEY (id);
--
-- Name: vendor_returns vendor_returns_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendor_returns
    ADD CONSTRAINT vendor_returns_pkey PRIMARY KEY (id);
--
-- Name: vendors vendors_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendors
    ADD CONSTRAINT vendors_pkey PRIMARY KEY (id);
--
-- Name: vendors vendors_vendor_code_key; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendors
    ADD CONSTRAINT vendors_vendor_code_key UNIQUE (vendor_code);
--
-- Name: withholding_categories withholding_categories_code_key; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.withholding_categories
    ADD CONSTRAINT withholding_categories_code_key UNIQUE (code);
--
-- Name: withholding_categories withholding_categories_pkey; Type: CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.withholding_categories
    ADD CONSTRAINT withholding_categories_pkey PRIMARY KEY (id);
--
-- Name: idx_combo_set_items_combo_set_id; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_combo_set_items_combo_set_id ON inv.combo_set_items USING btree (combo_set_id);
--
-- Name: idx_combo_set_items_product_id; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_combo_set_items_product_id ON inv.combo_set_items USING btree (product_id);
--
-- Name: idx_combo_sets_is_active; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_combo_sets_is_active ON inv.combo_sets USING btree (is_active);
--
-- Name: idx_combo_sets_user_id; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_combo_sets_user_id ON inv.combo_sets USING btree (user_id);
--
-- Name: idx_products_barcode; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_products_barcode ON inv.products USING btree (barcode);
--
-- Name: idx_products_name_issue; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_products_name_issue ON inv.products USING btree (name, issue_number);
--
-- Name: idx_products_vendor_id; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_products_vendor_id ON inv.products USING btree (vendor_id);
--
-- Name: idx_purchases_expiry_date; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_purchases_expiry_date ON inv.purchases USING btree (expiry_date) WHERE (expiry_date IS NOT NULL);
--
-- Name: idx_purchases_vendor_id; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_purchases_vendor_id ON inv.purchases USING btree (vendor_id);
--
-- Name: idx_sales_combo_sale_group; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_sales_combo_sale_group ON inv.sales USING btree (combo_sale_group);
--
-- Name: idx_sales_combo_set_id; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_sales_combo_set_id ON inv.sales USING btree (combo_set_id);
--
-- Name: idx_vendors_category; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_vendors_category ON inv.vendors USING btree (category_id);
--
-- Name: idx_vendors_entity_type; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_vendors_entity_type ON inv.vendors USING btree (entity_type);
--
-- Name: idx_vendors_name; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_vendors_name ON inv.vendors USING btree (name);
--
-- Name: idx_vendors_status; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_vendors_status ON inv.vendors USING btree (status);
--
-- Name: idx_vendors_tax_id; Type: INDEX; Schema: inv; Owner: -
--

CREATE INDEX idx_vendors_tax_id ON inv.vendors USING btree (tax_id);
--
-- Name: payment_methods ensure_single_default_payment_method_trigger; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER ensure_single_default_payment_method_trigger BEFORE INSERT OR UPDATE ON inv.payment_methods FOR EACH ROW EXECUTE FUNCTION inv.ensure_single_default_payment_method();
--
-- Name: sales on_sale_insert; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER on_sale_insert AFTER INSERT ON inv.sales FOR EACH ROW EXECUTE FUNCTION inv.update_stock_on_sale();
--
-- Name: profiles prevent_privilege_escalation_trigger; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER prevent_privilege_escalation_trigger BEFORE UPDATE ON inv.profiles FOR EACH ROW EXECUTE FUNCTION inv.prevent_privilege_escalation();
--
-- Name: sales rollback_fifo_on_sale_delete; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER rollback_fifo_on_sale_delete BEFORE DELETE ON inv.sales FOR EACH ROW EXECUTE FUNCTION inv.rollback_fifo_cost();
--
-- Name: purchases sync_vendor_on_purchase; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER sync_vendor_on_purchase AFTER INSERT ON inv.purchases FOR EACH ROW EXECUTE FUNCTION inv.sync_vendor_to_product();
--
-- Name: stock_adjustments trg_prevent_confirmed_delete; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER trg_prevent_confirmed_delete BEFORE DELETE ON inv.stock_adjustments FOR EACH ROW EXECUTE FUNCTION inv.prevent_confirmed_adjustment_delete();
--
-- Name: stock_adjustments trg_stock_adjustment_confirm; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER trg_stock_adjustment_confirm BEFORE UPDATE ON inv.stock_adjustments FOR EACH ROW EXECUTE FUNCTION inv.update_stock_on_stock_adjustment();
--
-- Name: stock_adjustments trg_stock_adjustment_insert_confirm; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER trg_stock_adjustment_insert_confirm AFTER INSERT ON inv.stock_adjustments FOR EACH ROW EXECUTE FUNCTION inv.stock_adjustment_insert_confirm();
--
-- Name: stock_adjustments trg_stock_adjustment_number; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER trg_stock_adjustment_number BEFORE INSERT ON inv.stock_adjustments FOR EACH ROW EXECUTE FUNCTION inv.generate_stock_adjustment_number();
--
-- Name: vendors trigger_generate_vendor_code; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER trigger_generate_vendor_code BEFORE INSERT ON inv.vendors FOR EACH ROW WHEN (((new.vendor_code IS NULL) OR (new.vendor_code = ''::text))) EXECUTE FUNCTION inv.generate_vendor_code();
--
-- Name: vendor_returns trigger_generate_vendor_return_number; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER trigger_generate_vendor_return_number BEFORE INSERT ON inv.vendor_returns FOR EACH ROW EXECUTE FUNCTION inv.generate_vendor_return_number();
--
-- Name: vendor_returns trigger_update_stock_on_vendor_return_confirm; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER trigger_update_stock_on_vendor_return_confirm BEFORE UPDATE ON inv.vendor_returns FOR EACH ROW EXECUTE FUNCTION inv.update_stock_on_vendor_return_confirm();
--
-- Name: vendor_returns trigger_vendor_returns_updated_at; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER trigger_vendor_returns_updated_at BEFORE UPDATE ON inv.vendor_returns FOR EACH ROW EXECUTE FUNCTION inv.update_updated_at_column();
--
-- Name: combo_sets update_combo_sets_updated_at; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER update_combo_sets_updated_at BEFORE UPDATE ON inv.combo_sets FOR EACH ROW EXECUTE FUNCTION inv.update_updated_at_column();
--
-- Name: payment_methods update_payment_methods_updated_at; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER update_payment_methods_updated_at BEFORE UPDATE ON inv.payment_methods FOR EACH ROW EXECUTE FUNCTION inv.update_updated_at_column();
--
-- Name: products update_products_updated_at; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON inv.products FOR EACH ROW EXECUTE FUNCTION inv.update_updated_at_column();
--
-- Name: profiles update_profiles_updated_at; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON inv.profiles FOR EACH ROW EXECUTE FUNCTION inv.update_updated_at_column();
--
-- Name: inventory_adjustments update_stock_on_adjustment; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER update_stock_on_adjustment BEFORE INSERT OR UPDATE ON inv.inventory_adjustments FOR EACH ROW EXECUTE FUNCTION inv.update_stock_on_adjustment();
--
-- Name: purchases update_stock_on_purchase; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER update_stock_on_purchase BEFORE INSERT OR UPDATE ON inv.purchases FOR EACH ROW EXECUTE FUNCTION inv.update_stock_on_purchase();
--
-- Name: vendors update_vendors_updated_at; Type: TRIGGER; Schema: inv; Owner: -
--

CREATE TRIGGER update_vendors_updated_at BEFORE UPDATE ON inv.vendors FOR EACH ROW EXECUTE FUNCTION inv.update_updated_at_column();
--
-- Name: combo_set_items combo_set_items_combo_set_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.combo_set_items
    ADD CONSTRAINT combo_set_items_combo_set_id_fkey FOREIGN KEY (combo_set_id) REFERENCES inv.combo_sets(id) ON DELETE CASCADE;
--
-- Name: combo_set_items combo_set_items_product_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.combo_set_items
    ADD CONSTRAINT combo_set_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES inv.products(id) ON DELETE CASCADE;
--
-- Name: inventory_adjustments inventory_adjustments_product_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.inventory_adjustments
    ADD CONSTRAINT inventory_adjustments_product_id_fkey FOREIGN KEY (product_id) REFERENCES inv.products(id) ON DELETE CASCADE;
--
-- Name: products products_base_product_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.products
    ADD CONSTRAINT products_base_product_id_fkey FOREIGN KEY (base_product_id) REFERENCES inv.products(id) ON DELETE SET NULL;
--
-- Name: products products_category_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.products
    ADD CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES inv.categories(id);
--
-- Name: products products_user_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.products
    ADD CONSTRAINT products_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
--
-- Name: products products_vendor_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.products
    ADD CONSTRAINT products_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES inv.vendors(id) ON DELETE SET NULL;
--
-- Name: profiles profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.profiles
    ADD CONSTRAINT profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
--
-- Name: purchases purchases_product_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.purchases
    ADD CONSTRAINT purchases_product_id_fkey FOREIGN KEY (product_id) REFERENCES inv.products(id) ON DELETE CASCADE;
--
-- Name: purchases purchases_user_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.purchases
    ADD CONSTRAINT purchases_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
--
-- Name: purchases purchases_vendor_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.purchases
    ADD CONSTRAINT purchases_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES inv.vendors(id) ON DELETE SET NULL;
--
-- Name: sales sales_combo_set_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.sales
    ADD CONSTRAINT sales_combo_set_id_fkey FOREIGN KEY (combo_set_id) REFERENCES inv.combo_sets(id);
--
-- Name: sales sales_payment_method_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.sales
    ADD CONSTRAINT sales_payment_method_id_fkey FOREIGN KEY (payment_method_id) REFERENCES inv.payment_methods(id);
--
-- Name: sales sales_product_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.sales
    ADD CONSTRAINT sales_product_id_fkey FOREIGN KEY (product_id) REFERENCES inv.products(id) ON DELETE SET NULL;
--
-- Name: sales sales_user_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.sales
    ADD CONSTRAINT sales_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
--
-- Name: stock_adjustments stock_adjustments_product_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.stock_adjustments
    ADD CONSTRAINT stock_adjustments_product_id_fkey FOREIGN KEY (product_id) REFERENCES inv.products(id);
--
-- Name: stock_adjustments stock_adjustments_reversal_of_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.stock_adjustments
    ADD CONSTRAINT stock_adjustments_reversal_of_fkey FOREIGN KEY (reversal_of) REFERENCES inv.stock_adjustments(id);
--
-- Name: user_permissions user_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.user_permissions
    ADD CONSTRAINT user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
--
-- Name: vendor_attachments vendor_attachments_vendor_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendor_attachments
    ADD CONSTRAINT vendor_attachments_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES inv.vendors(id) ON DELETE CASCADE;
--
-- Name: vendor_bank_accounts vendor_bank_accounts_vendor_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendor_bank_accounts
    ADD CONSTRAINT vendor_bank_accounts_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES inv.vendors(id) ON DELETE CASCADE;
--
-- Name: vendor_contacts vendor_contacts_vendor_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendor_contacts
    ADD CONSTRAINT vendor_contacts_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES inv.vendors(id) ON DELETE CASCADE;
--
-- Name: vendor_return_items vendor_return_items_product_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendor_return_items
    ADD CONSTRAINT vendor_return_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES inv.products(id) ON DELETE RESTRICT;
--
-- Name: vendor_return_items vendor_return_items_vendor_return_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendor_return_items
    ADD CONSTRAINT vendor_return_items_vendor_return_id_fkey FOREIGN KEY (vendor_return_id) REFERENCES inv.vendor_returns(id) ON DELETE CASCADE;
--
-- Name: vendor_returns vendor_returns_vendor_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendor_returns
    ADD CONSTRAINT vendor_returns_vendor_id_fkey FOREIGN KEY (vendor_id) REFERENCES inv.vendors(id) ON DELETE RESTRICT;
--
-- Name: vendors vendors_category_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendors
    ADD CONSTRAINT vendors_category_id_fkey FOREIGN KEY (category_id) REFERENCES inv.vendor_categories(id) ON DELETE SET NULL;
--
-- Name: vendors vendors_default_tax_type_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendors
    ADD CONSTRAINT vendors_default_tax_type_id_fkey FOREIGN KEY (default_tax_type_id) REFERENCES inv.tax_types(id) ON DELETE SET NULL;
--
-- Name: vendors vendors_default_withholding_category_id_fkey; Type: FK CONSTRAINT; Schema: inv; Owner: -
--

ALTER TABLE ONLY inv.vendors
    ADD CONSTRAINT vendors_default_withholding_category_id_fkey FOREIGN KEY (default_withholding_category_id) REFERENCES inv.withholding_categories(id) ON DELETE SET NULL;
--
-- Name: approval_settings; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.approval_settings ENABLE ROW LEVEL SECURITY;
--
-- Name: categories; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.categories ENABLE ROW LEVEL SECURITY;
--
-- Name: combo_set_items; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.combo_set_items ENABLE ROW LEVEL SECURITY;
--
-- Name: combo_sets; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.combo_sets ENABLE ROW LEVEL SECURITY;
--
-- Name: inventory_adjustments; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.inventory_adjustments ENABLE ROW LEVEL SECURITY;
--
-- Name: payment_methods; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.payment_methods ENABLE ROW LEVEL SECURITY;
--
-- Name: products; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.products ENABLE ROW LEVEL SECURITY;
--
-- Name: profiles; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.profiles ENABLE ROW LEVEL SECURITY;
--
-- Name: purchases; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.purchases ENABLE ROW LEVEL SECURITY;
--
-- Name: sales; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.sales ENABLE ROW LEVEL SECURITY;
--
-- Name: stock_adjustments; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.stock_adjustments ENABLE ROW LEVEL SECURITY;
--
-- Name: tax_types; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.tax_types ENABLE ROW LEVEL SECURITY;
--
-- Name: user_permissions; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.user_permissions ENABLE ROW LEVEL SECURITY;
--
-- Name: vendor_attachments; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.vendor_attachments ENABLE ROW LEVEL SECURITY;
--
-- Name: vendor_bank_accounts; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.vendor_bank_accounts ENABLE ROW LEVEL SECURITY;
--
-- Name: vendor_categories; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.vendor_categories ENABLE ROW LEVEL SECURITY;
--
-- Name: vendor_contacts; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.vendor_contacts ENABLE ROW LEVEL SECURITY;
--
-- Name: vendor_return_items; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.vendor_return_items ENABLE ROW LEVEL SECURITY;
--
-- Name: vendor_returns; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.vendor_returns ENABLE ROW LEVEL SECURITY;
--
-- Name: vendors; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.vendors ENABLE ROW LEVEL SECURITY;
--
-- Name: withholding_categories; Type: ROW SECURITY; Schema: inv; Owner: -
--

ALTER TABLE inv.withholding_categories ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- 99. canonical grant —— inv 裡的每一個物件都只授給 service_role
-- ---------------------------------------------------------------------------
-- 來源那 217 條逐物件 GRANT 全部丟掉了（其中還有目標專案不存在的
-- sandbox_exec_* 角色）。改成整批授權有兩個好處：不會漏授，而且
-- 「anon/authenticated 對 inv 有幾筆權限」這個問題可以用一句 SQL 驗證。

grant all on all tables in schema inv to service_role;
grant all on all sequences in schema inv to service_role;
grant execute on all functions in schema inv to service_role;

-- PostgreSQL 建立函式時預設把 EXECUTE 授給 PUBLIC。inv 裡有 20 支
-- SECURITY DEFINER 函式，即使沒有 schema USAGE 就叫不到，還是收掉比較乾淨。
revoke execute on all functions in schema inv from public;
revoke all on all tables in schema inv from anon, authenticated;
revoke all on all sequences in schema inv from anon, authenticated;

-- 之後新增的物件也照這個規矩走。
alter default privileges in schema inv grant all on tables to service_role;
alter default privileges in schema inv grant all on sequences to service_role;
alter default privileges in schema inv grant execute on functions to service_role;

commit;

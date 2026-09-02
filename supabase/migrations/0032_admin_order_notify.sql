-- 0032_admin_order_notify.sql — 新訂單／新報名時通知店家
--
-- Requires 0022（email_outbox / enqueue_* / claim_order_notify）、
-- 0001（site_settings 單例設定表）。
--
-- ## §0  在補哪個洞
--
-- 0022 把 queueOrderNotifications() 排的兩封信全部寄給客人（付款成功、報名成功）。
-- 店家對「有新單」一無所知，只能自己登入後台翻——錢進來了，沒有任何人被通知。
-- 這一支加第三種信：新訂單／新報名通知，收件人在 public.site_settings 可設定
-- （逗號分隔可填多人），走**同一套** outbox + claim + dedupe_key 機制，不建第二條路。
--
-- 參考 Realreal 的做法（apps/api/src/lib/enqueue-post-payment.ts）：收件人是
-- `getSetting("notifications.admin_email")`，DB 可設定、逗號分隔多人。這裡只借
-- 那個形狀（設定值存資料庫、逗號分隔），不借程式碼——那邊是 Next.js + 獨立
-- Express API，這裡是 TanStack Start server fn + Supabase RPC，架構不同。
--
-- ## §0.1  收件人放 site_settings，不另開一張表
--
-- site_settings 已經是這個站的單例設定表（0001 §1）：contact_email／map_link／
-- social_line 這些同樣是「一個值，後台可以改」的設定。notify_emails 形狀完全
-- 一樣，沒有理由為它另開一張表——那樣店家要多學一個地方改設定，後台也要多一頁。
--
-- ## §0.2  ⚠️ site_settings 對 anon/authenticated 是公開表——notify_emails 不能沿用那個 grant
--
-- 0001:481-497 把整張 site_settings 開放給 anon/authenticated 的 table-level
-- SELECT（前台頁尾／聯絡頁要讀 short_desc / contact_email / map_link 這些公開
-- 欄位，src/lib/cms.ts 的 fetchSiteContent() 用的就是帶著公開 anon key 的瀏覽器
-- 端 client）。notify_emails 是店家內部收信地址，不是要給訪客看的東西——但如果
-- 直接把它加進同一張表又不處理 grant，任何人都能用瀏覽器 JS 裡那把本來就公開的
-- anon key，繞過 src/lib/cms.ts 明列的欄位清單，直接打
--
--     ${SUPABASE_URL}/rest/v1/site_settings?select=notify_emails
--
-- 讀到它——這不是理論風險，anon key 与 URL 本來就在瀏覽器可以看到的那份 JS 裡。
--
-- 這裡不是加一張新表把它藏起來（那樣店家又要多學一個地方），而是用 Postgres 的
-- column-level privilege：RLS 的 policy 留著不動（列本身還是「有」，
-- site_settings_select_public 管的是「哪些列看得到」），但把 anon/authenticated
-- 的 SELECT 從 table-level 收成明確的欄位清單，刻意漏掉 notify_emails——這一層
-- 管的是「哪些欄位看得到」，兩層互不取代。src/lib/cms.ts 的 fetchSiteContent()
-- 本來就是明列欄位（不是 select *），所以這裡不影響它今天實際打出去的任何一個
-- 請求；差別只在於「用公開的 anon key 手動打 REST API 也讀不到 notify_emails」
-- 這件事，從「程式恰好沒這樣寫」變成「資料庫層就擋掉」。
--
-- service_role 不受影響：0001:485 的 `grant all on table public.site_settings to
-- service_role` 是另一個角色的另一筆 grant，這裡的 column-level revoke/grant
-- 只動 anon/authenticated 兩個角色。src/server/repos/site-settings.ts 走的就是
-- service_role（supabaseAdmin()），後台照樣讀寫得到 notify_emails。
--
-- ## §0.3  dedupe_key 沿用 0022 §0.6 的格式
--
-- `order_notify_admin:<order_id>`。跟 order_paid / registration_ticket 同一個
-- unique 保證：webhook 重送、backlog 補跑，店家都只會收到一封。
--
-- ## §0.4  不需要 0022 §10 那種一次性回填
--
-- 這一期沒有開第二道 claim——enqueue_admin_order_email() 是在
-- queueOrderNotifications() 既有的 claim_order_notify() 之內多排一封信
-- （src/server/notify.ts），不是另一支獨立函式各走各的鎖。這代表它天生繼承 0022
-- 已經做過的事：任何在 0022 上線之前就付過款、'notify' 步驟已經 completed_at 的
-- 舊訂單，claim_order_notify() 一律回 already_sent，queueWithClaim() 根本不會被
-- 呼叫到——套用這一支的當下不會突然給店家寄出幾百封舊訂單通知信。
--
-- ## §0.5  emails 是不是空的，用「拿掉逗號與空白後還有沒有東西」判斷，不是純 btrim
--
-- 允許 `'a@x.com, ,  '` 這種打字失手：把逗號與空白都拿掉之後還有沒有剩東西才算
-- 「有設定」，否則一個只打了逗號的欄位會被判定成「有設定」，插進 outbox 之後才在
-- 寄送那一步（src/server/email.ts 的 parseRecipients()，見 src/lib/email-templates.ts）
-- 發現其實是空的，白白燒掉重試額度。真正把逗號分隔字串拆成乾淨地址陣列的邏輯只有
-- parseRecipients() 一份，SQL 這裡只判斷「值得不值得插這一列」。
--
-- ## §0.6  這支不動 0022 的任何函式／表，只新增
--
-- 沒有 alter 打在 email_outbox 上，也沒有 drop。site_settings 只有 add column
-- 與 anon/authenticated 的 grant 調整（§0.2）。

begin;

-- ---------------------------------------------------------------------------
-- §1  site_settings.notify_emails —— 新訂單／新報名通知信收件人
-- ---------------------------------------------------------------------------
alter table public.site_settings
  add column if not exists notify_emails text not null default 'info@intervalbooks.tw';

comment on column public.site_settings.notify_emails is
  '新訂單／新報名通知信收件人。逗號分隔可填多人，前後空白與空字串由 src/lib/email-templates.ts 的 parseRecipients() 處理。⚠️ 內部用途——見本檔 §0.2：anon/authenticated 讀不到這一欄（column-level grant 刻意漏掉它）。空字串＝不寄通知信，enqueue_admin_order_email() 安靜跳過，不是錯誤。';

-- §0.2：把 anon/authenticated 的 SELECT 從 table-level 收成明確欄位清單，漏掉
-- notify_emails。先 revoke 整張表的 select（0001:484 那一筆），再用
-- column-level grant 重開——這裡刻意列出「除了 notify_emails 以外」現有的每一欄，
-- 而不是靠「沒列到就沒權限」的隱含行為，讀這一段就看得出公開欄位是哪些。
revoke select on public.site_settings from anon, authenticated;
grant select (
  id, short_desc, address, city, hours, closed, contact_email, site_url,
  social_instagram, social_facebook, social_line, map_embed, map_link, map_apple,
  meta_site_name, meta_author, meta_twitter_card, meta_og_type,
  default_meta_title, default_meta_description, created_at, updated_at
) on public.site_settings to anon, authenticated;

-- ---------------------------------------------------------------------------
-- §2  enqueue_admin_order_email() —— 店家的新訂單／新報名通知
-- ---------------------------------------------------------------------------
-- 形狀對應 0022 §7 的 enqueue_order_email()：地址由 SQL 自己查，不從呼叫端傳
-- 進來，也不回傳（§0.5 之外的另一半：明文一步都不用離開資料庫，即使 notify_emails
-- 不是客人的個資，一樣沿用同一個形狀，不為它另開一種呼叫慣例）。
--
-- 差別只在於這裡查的是 site_settings.notify_emails，不是 orders.customer_email，
-- 所以不需要 p_order_id 參數——dedupe_key 已經在呼叫端（src/server/notify.ts）
-- 用 order_id 組好了，這支函式只管「排不排得進 outbox」。
--
-- 用「目前設定的收件人」而不是排信當下 snapshot 一份，是刻意的：webhook 重送或
-- backlog 補跑時，應該寄到現在設定的信箱，不是訂單建立當下的信箱——店家把收件人
-- 從 A 換成 B 之後，不應該還有漏網的信繼續往 A 送。
create or replace function public.enqueue_admin_order_email(
  p_dedupe_key text,
  p_subject    text,
  p_body_text  text,
  p_body_html  text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emails text;
  v_ok     boolean;
begin
  if p_dedupe_key is null or btrim(p_dedupe_key) = '' then
    raise exception 'EMPTY_DEDUPE_KEY';
  end if;

  select s.notify_emails into v_emails from public.site_settings s where s.id = 1;

  -- §0.5：拿掉逗號與空白之後還有沒有剩東西，而不是單純 btrim。
  if v_emails is null or regexp_replace(v_emails, '[,\s]+', '', 'g') = '' then
    return false;
  end if;

  insert into public.email_outbox (dedupe_key, to_email, subject, body_text, body_html)
  values (p_dedupe_key, btrim(v_emails), p_subject, coalesce(p_body_text, ''), coalesce(p_body_html, ''))
  on conflict (dedupe_key) do nothing
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

comment on function public.enqueue_admin_order_email(text, text, text, text) is
  '把一封新訂單／新報名通知信排給店家。地址從 site_settings.notify_emails 查，不從呼叫端傳入，也不回傳。回 true 代表這一次真的新增了一列（false = dedupe_key 已存在，或收件信箱是空的／只有逗號與空白）。';

-- ---------------------------------------------------------------------------
-- §3  權限——SECURITY DEFINER，處理方式同 0022 §12
-- ---------------------------------------------------------------------------
-- execute 預設會 grant 給 public，所以「從 public revoke」才是真正生效的那一半，
-- anon / authenticated 是保險（它是 public schema 的函式，PostgREST 會把它當
-- RPC 端點暴露出去）。
do $$
declare sig text;
begin
  foreach sig in array array[
    'public.enqueue_admin_order_email(text, text, text, text)'
  ]
  loop
    execute format('revoke execute on function %s from public', sig);
    execute format('revoke execute on function %s from anon, authenticated', sig);
    execute format('grant  execute on function %s to service_role', sig);
  end loop;
end $$;

commit;

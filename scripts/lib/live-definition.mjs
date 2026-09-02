/**
 * 「這支函式現在長什麼樣子」—— 從 supabase/migrations 找出**最後一支重新定義它**的
 * migration，並切出那一份定義。
 *
 * ═══ 為什麼需要這個檔案 ═════════════════════════════════════════════════════
 *
 * `admin_upsert_event_with_session()` 到目前為止被定義過三次：0026 建立、0027 加七個
 * 三語清單欄位、0029 加 show_seats_remaining。三次都是 `create or replace`（簽名是
 * 一個 payload jsonb，就是為了不必 drop）。所以**資料庫裡實際跑的永遠是最後那一份**。
 *
 * 但守著它的兩支自檢原本都把檔名寫死：
 *
 *   · scripts/event-blocks-selftest.mjs [7] —— 從 `0027_event_blocks.sql` 切函式，
 *     驗七個清單欄位有沒有在 insert / on conflict / coalesce-v_prev 三個地方出現，
 *     以及「products.description 取 events.summary」「不寫 seats_taken」這兩條
 *     0026 訂下的規則有沒有在重寫時走鐘。
 *   · scripts/event-product-selftest.mjs [8] —— 從 `0026_event_product_link.sql`
 *     切函式，驗它完全沒有寫 seats_taken。
 *
 * 兩條都是綠的，而且會**永遠**是綠的 —— 因為 0026 與 0027 是已套用的 migration，
 * 規約禁止再改它們一個字。也就是說：從 0027 那一刻起，event-product 那一條就已經
 * 在驗一份**沒有任何資料庫在跑的死定義**；0029 又讓 event-blocks 那一條變成同樣的
 * 狀態。畫面上全綠，實際覆蓋是零。
 *
 * 這正是這個 repo 反覆出現的假陽性形狀之一（「斷言釘死單一檔案路徑，程式碼搬家後
 * 靜默失去覆蓋」）。修法不是把 0027 改成 0029 —— 那只是把同一顆地雷往後埋一期，
 * 下一支重寫這支函式的 migration 會再踩一次，而且一樣沒有人會發現。修法是讓斷言
 * **自己去找**現在生效的那一份。
 *
 * ⚠️ 這裡刻意**不**接受「找不到就回空字串」。回空字串會讓所有
 *    `checkFalse("裡面沒有 X", /X/.test(body))` 這一類的否定斷言靜默通過 —— 與
 *    scripts/lib/migration-ledger.mjs 的 readSql() 是同一條理由。找不到就丟例外。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 找出最後一支定義 `public.<fnName>(` 的 migration，回傳
 * `{ file, body }` —— body 從 `create or replace function public.<fnName>` 起，
 * 到那一份定義結尾的 `$$;` 為止（含）。
 *
 * @param {string} migDir supabase/migrations 的絕對路徑
 * @param {string} fnName 函式名（不含 schema、不含參數）
 * @param {(sql: string) => string} [strip] 可選的前處理（各支自檢自己的 stripSqlComments）
 */
export function latestDefinition(migDir, fnName, strip = (s) => s) {
  let files;
  try {
    files = readdirSync(migDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (err) {
    throw new Error(`live-definition 讀不到目錄：${migDir}（${err.code ?? err.message}）`);
  }
  if (files.length === 0) {
    throw new Error(
      `live-definition：${migDir} 底下一個 .sql 都沒有 —— 這裡丟例外而不是回空清單，` +
        "因為空清單會讓「最後一份定義裡沒有 X」變成一個靜默成立的結論。",
    );
  }

  const head = `create or replace function public.${fnName}`;
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const sql = strip(readFileSync(join(migDir, files[i]), "utf8"));
    const at = sql.indexOf(head);
    if (at === -1) continue;
    // 一支 migration 可能定義同一支函式不只一次（理論上不該，但要抓得出來）：
    // 取**最後**一次，那才是這支 migration 跑完之後留在資料庫裡的那一份。
    const start = sql.lastIndexOf(head);
    const end = sql.indexOf("\n$$;", start);
    if (end === -1) {
      throw new Error(
        `live-definition：在 ${files[i]} 找到 ${fnName} 的定義開頭，卻找不到結尾的 $$; —— ` +
          "切不出完整的函式本體就不要回一段半截的字串（半截的本體會讓否定斷言誤判）。",
      );
    }
    return { file: files[i], body: sql.slice(start, end + 4) };
  }

  throw new Error(
    `live-definition：${files.length} 支 migration 裡沒有任何一支寫著 "${head}"。` +
      "函式改名了，還是這個名字打錯了？這裡丟例外而不是回空字串 —— 回空字串會讓" +
      "所有「這支函式裡沒有 X」的斷言從此靜默通過。",
  );
}

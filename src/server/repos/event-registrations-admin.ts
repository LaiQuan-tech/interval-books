/**
 * Data layer for the ONE legitimate write path onto public.event_registrations
 * that isn't reserve_session_seat() / release_session_seat() /
 * expire_unpaid_orders()：admin 移除單筆報名（0035）。
 *
 * ── 為什麼是一個新檔案，不是加進 src/server/repos/event-registrations.ts ──────
 * 那個檔案的檔頭第 4 條規矩寫死：「這個檔案不寫入。報名資料只由
 * reserve_session_seat() 寫、只由 release_session_seat() 與
 * expire_unpaid_orders() 刪」，理由是「佔了 N 個位子」與「有 N 位參加者」必須是
 * 同一句 SQL 的兩個面向，那個檔案多一條 insert 或 delete，這個不變量就沒了。
 *
 * 0035 加的 admin_delete_registration()（單筆移除、名額自動還）**沒有打破**這個
 * 不變量——它跟 release_session_seat() 一樣，刪與扣是同一句 SQL 裡的兩件事，只是
 * 粒度改成一列而不是整個 order_item。但那支 SQL 函式是新的第五個合法入口，混進
 * event-registrations.ts 會讓「這個檔案不寫入」那句話變成假的。分開之後那句話繼續
 * 成立，這裡是唯一多出來的例外，而且只做這一件事。
 *
 * ⚠️ log 紀律同 event-registrations.ts：console.error 只印 error.code 與
 *    error.message，不印整包 error（PostgREST 的 DETAIL 可能帶著參加者姓名）。
 */
import "@tanstack/react-start/server-only";
import { supabaseAdmin } from "@/server/supabase-admin";

export type DeleteRegistrationReason = "deleted" | "registration_not_found";

export type DeleteRegistrationOutcome = {
  deleted: boolean;
  reason: DeleteRegistrationReason;
  /** 這次還了幾個名額——deleted 時是 1，registration_not_found 時是 0。 */
  freed: number;
};

/**
 * 呼叫 public.admin_delete_registration(p_registration_id, p_actor_id)
 * （0035 §5）。已付款的報名也允許刪（user 決定）：這支不擋，警告文案由呼叫端
 * （名單頁）在確認對話框裡用 listSessionRoster() 已經回傳的 payment_status /
 * on_roster 顯示——這裡不需要為此多回傳一個欄位。
 */
export async function deleteAdminRegistration(input: {
  registrationId: string;
  actorId: string;
}): Promise<DeleteRegistrationOutcome> {
  const { data, error } = await supabaseAdmin().rpc("admin_delete_registration", {
    p_registration_id: input.registrationId,
    p_actor_id: input.actorId,
  });

  if (error) {
    console.error(`[repo/event-registrations-admin] delete 失敗：${error.code} ${error.message}`);
    throw new Error(`[repo/event-registrations-admin] 移除報名失敗：${error.code}`);
  }

  const row = (Array.isArray(data) ? data[0] : data) as
    | { deleted?: boolean; reason?: string; freed?: number }
    | undefined;

  if (!row || !row.reason) {
    throw new Error("[repo/event-registrations-admin] 移除報名沒有回傳結果");
  }

  return {
    deleted: row.deleted === true,
    reason: row.reason as DeleteRegistrationReason,
    freed: typeof row.freed === "number" ? row.freed : 0,
  };
}

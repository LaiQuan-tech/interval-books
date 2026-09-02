/**
 * 寄信的編排層：claim → 排信 → finish/fail，然後把 outbox 沖出去。
 *
 * ── 形狀逐字對應 src/server/invoice-issuer.ts ─────────────────────────────
 * 那個檔案已經把「付款之後要做一件會失敗的事」該長什麼樣子寫清楚了，這裡照抄：
 *
 *   1. claimOrderNotify()   —— 原子地宣告「這張的通知由我排」（0022 §8 的兩道閘門）
 *   2. 排信進 email_outbox   —— 只有拿到 claim 的人可以做這一步
 *   3. finish / fail        —— 一定要走到其中一個
 *
 * ── 為什麼這個檔案永不 throw ──────────────────────────────────────────────
 * 它跑在 PayUni webhook 的成功路徑上。docs/alignment-audit.md 與
 * invoice-issuer.ts:20-24 已經寫過同一件事：把會失敗的事塞進金流 webhook 的同步
 * 流程，那件事一掛就會讓 PayUni 收到 5xx 而**不斷重送同一則通知**。所以這裡的每
 * 一支公開函式回的都是一個可以忽略的結果物件，失敗留在 email_outbox 與
 * order_post_payment_log 裡等 backlog 收拾。
 *
 * ⚠️ scripts/notify-selftest.mjs 有一條靜態測試：**這個檔案裡不可以出現 `throw`。**
 *
 * ── 為什麼 claim 一定要在排信之前 ────────────────────────────────────────
 * 這一點比發票鬆得多（信重寄一次只是客人多收一封，發票開兩張要跑國稅局），但
 * claim 仍然值得：沒有它，一則被重送三次的 webhook 會讓「載入訂單 → 讀名單 →
 * 排信」跑三遍，而那是三倍的資料庫工作換同一個結果。真正的冪等保證在下面一層 ——
 * `email_outbox.dedupe_key` 是 unique，所以就算三次都跑完，信仍然只有一封。
 * **claim 省的是工，dedupe_key 保的是正確性。** 兩者不可互相取代。
 *
 * ── 信不帶發票號碼 ────────────────────────────────────────────────────────
 * 見 0022 檔頭 §0.3：發票那一步有 8 秒逾時保護，等它就等於讓 Amego 慢的時候
 * 信也不寄。
 *
 * ── 明文 email 不經過這個檔案 ────────────────────────────────────────────
 * 排信時送進資料庫的是 registration_id / order_id 與排好版的內容，地址由
 * 0022 §7 的 SQL 自己 join。這個檔案唯一碰得到地址的地方是 flushEmailOutbox()
 * 從 claimEmailBatch() 拿到的那一批 —— 而那是把信交給 Resend 必須的。
 *
 * ⚠️ **log 裡不准出現裸的收件地址**，一律走 maskEmail()。
 */
import "@tanstack/react-start/server-only";
import { sendEmail, emailConfigured } from "@/server/email";
import {
  claimEmailBatch,
  claimOrderNotify,
  enqueueAdminOrderEmail,
  enqueueOrderEmail,
  enqueueRegistrationEmails,
  failEmail,
  failOrderNotify,
  finishEmail,
  finishOrderNotify,
  getOrderForNotify,
  loadEmailCopy,
  loadOrderLocales,
  notifyBacklog,
  purgeSentEmailBodies,
  sessionsDueForReminder,
  EMAIL_FLUSH_BATCH,
  REMINDER_LEAD,
  type RegistrationMailItem,
} from "@/server/repos/email-outbox";
import { loadPaidRoster, loadPaidRosterByOrder } from "@/server/repos/event-registrations";
import { getEventSessionById } from "@/server/repos/event-sessions";
import {
  maskEmail,
  renderAdminOrderNotificationEmail,
  renderOrderPaidEmail,
  renderRegistrationTicketEmail,
  renderSessionReminderEmail,
  type SessionBrief,
} from "@/lib/email-templates";
import type { Lang } from "@/i18n/types";

export type NotifyOutcome =
  | { ok: true; queued: number; adopted: boolean }
  | { ok: false; reason: string };

/** dedupe_key 的四種格式。**只在這裡組**，免得有第二個地方拼錯前綴。 */
export const dedupeKeys = {
  orderPaid: (orderId: string) => `order_paid:${orderId}`,
  registrationTicket: (registrationId: string) => `registration_ticket:${registrationId}`,
  sessionReminder: (sessionId: string, registrationId: string) =>
    `session_reminder:${sessionId}:${registrationId}`,
  /** 0032：店家的新訂單／新報名通知。一張訂單一封，跟 orderPaid 用同一個實體 id。 */
  orderNotifyAdmin: (orderId: string) => `order_notify_admin:${orderId}`,
};

// -----------------------------------------------------------------------------
// 付款成功之後排信
// -----------------------------------------------------------------------------

/**
 * 一次把某張訂單該寄的信全部排進 outbox。**永不 throw。**
 *
 * 排幾封：訂購人 1 封（付款成功）＋ 店家 1 封（新訂單／新報名通知，0032，收件人
 * 是 site_settings.notify_emails，空白就安靜不排）＋ 這張訂單上每一位在簽到表上
 * 的參加者 1 封（報名成功）。只買書的訂單就是訂購人與店家各 1 封。
 *
 * 回傳 queued 是**這一次真的新增的列數**，重跑時會是 0（全部撞 dedupe_key），
 * 那是正常的，不是失敗。
 */
export async function queueOrderNotifications(orderId: string): Promise<NotifyOutcome> {
  const claim = await claimOrderNotify(orderId);
  if (!claim.claimed) {
    if (claim.reason === "already_sent") return { ok: true, queued: 0, adopted: true };
    // locked 是正常的併發結果，不值得吵；其餘都值得留紀錄（同 invoice-issuer.ts）。
    if (claim.reason !== "locked") {
      console.warn(`[notify] 未取得排信許可 order=${orderId} reason=${claim.reason}`);
    }
    return { ok: false, reason: claim.reason };
  }

  // 拿到 claim 之後，任何路徑都必須走到 finish 或 fail。
  try {
    return await queueWithClaim(orderId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] 排信途中發生未預期例外 order=${orderId} ${message}`);
    await failOrderNotify(orderId, `unexpected: ${message}`);
    return { ok: false, reason: "unexpected_error" };
  }
}

async function queueWithClaim(orderId: string): Promise<NotifyOutcome> {
  const loaded = await getOrderForNotify(orderId);
  if (!loaded) {
    await failOrderNotify(orderId, "order_not_found");
    return { ok: false, reason: "order_not_found" };
  }
  const { order, items } = loaded;
  const lang = order.locale;
  const copy = await loadEmailCopy();

  // 這張訂單買到的場次。一張訂單可以買到兩個不同場次的位子，所以是一組。
  const sessionIds = [...new Set(items.map((i) => i.sessionId).filter((s): s is string => !!s))];
  const sessions = await loadSessionBriefs(sessionIds);

  let queued = 0;

  // ---- 1. 訂購人的付款成功信 -------------------------------------------------
  // 先排這一封：它不依賴名單，所以名單那一步就算失敗，客人至少會收到「錢收到了」。
  // 之後 backlog 重跑時這一封會撞 dedupe_key 變成 no-op，不會寄第二次。
  const paidMail = renderOrderPaidEmail(
    {
      orderNo: order.orderNo,
      customerName: order.customerName,
      total: order.total,
      items: items.map((i) => ({ name: i.name, quantity: i.quantity, subtotal: i.subtotal })),
      sessions: sessionIds.map((id) => sessions.get(id)).filter((s): s is SessionBrief => !!s),
    },
    copy,
    lang,
  );
  const addedOrderMail = await enqueueOrderEmail({
    orderId,
    dedupeKey: dedupeKeys.orderPaid(orderId),
    subject: paidMail.subject,
    text: paidMail.text,
    html: paidMail.html,
  });
  if (addedOrderMail) queued += 1;

  // ---- 1.5 店家的新訂單／新報名通知（0032）------------------------------------
  // ⚠️ 整段包在自己的 try/catch 裡，**絕對不能讓店家信的任何失敗拖累客人的信**：
  //    上面訂購人的付款成功信已經排進去了，下面每一位參加者的報名成功信還沒排——
  //    這一段夾在中間，萬一 renderAdminOrderNotificationEmail() 或
  //    enqueueAdminOrderEmail() 丟出意外例外（不應該發生：兩者都設計成不 throw，
  //    但這裡按「防禦性」處理，不賭它們的實作永遠不變），try/catch 讓函式繼續往
  //    下跑到報名信的迴圈與 finishOrderNotify()，不會被這一段拖垮。
  //    店家信箱是空的（site_settings.notify_emails 沒設）不算失敗，是
  //    enqueue_admin_order_email() 內建的安靜跳過（0032 §2），這裡收到的就是
  //    普通的 false，不會進到 catch。
  try {
    // 場次的參加人數：這張訂單裡屬於同一個 session 的 item.quantity 加總。
    // ⚠️ 這是「這場買了幾個名額」，不是「簽到表上有幾筆」——不需要等下面的
    //    loadPaidRosterByOrder()，訂單的 order_items 就夠了，店家通知信也不需要
    //    逐位名單（那要登入後台看）。
    const sessionParticipants = new Map<string, number>();
    for (const it of items) {
      if (!it.sessionId) continue;
      sessionParticipants.set(
        it.sessionId,
        (sessionParticipants.get(it.sessionId) ?? 0) + it.quantity,
      );
    }
    const adminMail = renderAdminOrderNotificationEmail({
      orderNo: order.orderNo,
      total: order.total,
      paymentMethod: order.paymentMethod,
      shippingMethod: order.shippingMethod,
      items: items.map((i) => ({ name: i.name, quantity: i.quantity, subtotal: i.subtotal })),
      sessions: sessionIds.flatMap((id) => {
        const session = sessions.get(id);
        if (!session) return [];
        return [{ session, participants: sessionParticipants.get(id) ?? 0 }];
      }),
    });
    const addedAdminMail = await enqueueAdminOrderEmail({
      dedupeKey: dedupeKeys.orderNotifyAdmin(orderId),
      subject: adminMail.subject,
      text: adminMail.text,
      html: adminMail.html,
    });
    if (addedAdminMail) queued += 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] 店家通知信排入失敗 order=${order.orderNo} ${message}`);
  }

  // ---- 2. 每一位參加者的報名成功信 -------------------------------------------
  // ⚠️ 用 loadPaidRosterByOrder()，不是自己寫一次付款狀態的條件。「誰在簽到表上」
  //    只定義在 0021 §3 的 view 裡（見那支 repo 的檔頭）。
  //
  // ⚠️ 這裡拿到的是**遮罩過的**列，沒有明文地址 —— 排信只送 registration_id
  //    進去，地址由 0022 §7 的 SQL join。
  if (sessionIds.length > 0) {
    const roster = await loadPaidRosterByOrder(orderId);
    const mails: RegistrationMailItem[] = [];
    for (const row of roster) {
      // 沒留信箱的參加者（0020 允許只留電話）連信都不用排。SQL 那一側也會擋，
      // 這裡先擋掉只是為了讓 queued 的數字對得起來。
      if (!row.has_email) continue;
      const session = sessions.get(row.session_id);
      if (!session) continue;
      const mail = renderRegistrationTicketEmail(
        {
          participantName: row.name,
          seatNo: row.seat_no,
          orderNo: row.order_no,
          session,
        },
        copy,
        lang,
      );
      mails.push({
        registrationId: row.registration_id,
        dedupeKey: dedupeKeys.registrationTicket(row.registration_id),
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
    }
    queued += await enqueueRegistrationEmails(mails);
  }

  const done = await finishOrderNotify(orderId);
  if (!done) {
    // 信已經排進 outbox 了，只是 claim 沒結掉。**絕不能當成失敗重排** ——
    // 重排也只會撞 dedupe_key，但這個狀態值得被看見：它代表 log 那一列不見了。
    console.error(`[notify] 🚨 已排信但結不掉 claim order=${order.orderNo} —— 需人工確認 log 列`);
  }
  console.info(`[notify] 已排信 order=${order.orderNo} queued=${queued}`);
  return { ok: true, queued, adopted: false };
}

/** 場次的摘要（信裡要印的時間地點）。查不到的場次直接略過，不讓整封信失敗。 */
async function loadSessionBriefs(ids: string[]): Promise<Map<string, SessionBrief>> {
  const out = new Map<string, SessionBrief>();
  for (const id of ids) {
    try {
      const s = await getEventSessionById(id);
      if (s) {
        out.set(id, {
          title: s.title,
          location: s.location,
          startsAt: s.starts_at,
          endsAt: s.ends_at,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[notify] 讀場次失敗 session=${id} ${message}`);
    }
  }
  return out;
}

/**
 * 付款確認之後觸發通知，且**保證不會拖垮呼叫端**。
 *
 * 理由與 invoice-issuer.ts:413-440 逐字相同：webhook 的職責是「盡快告訴金流商我
 * 收到了」。這裡除了排信還會順手沖一次 outbox（>90% 的客人因此是秒收到的），而
 * 沖 outbox 要往返 Resend —— 那是一個外部服務，它慢的時候不能讓 PayUni 收到逾時
 * 或 5xx，因為那換來的是無止盡的重送。
 *
 * 超時就當作沒做完，交給 /api/tasks/notify 的排程；claim 會在 p_stale_after 之後
 * 被接手，而已經排進 outbox 的信本來就在等下一輪 flush。
 */
export async function triggerNotifyAfterPayment(
  orderId: string,
  timeoutMs = 8_000,
): Promise<NotifyOutcome> {
  const timeout = new Promise<NotifyOutcome>((resolve) =>
    setTimeout(() => resolve({ ok: false, reason: "notify_timeout" }), timeoutMs).unref?.(),
  );
  try {
    const work = (async (): Promise<NotifyOutcome> => {
      const outcome = await queueOrderNotifications(orderId);
      // 排完就立刻試寄一次。失敗不影響上面的結果 —— 信已經在 outbox 裡了。
      await flushEmailOutbox(EMAIL_FLUSH_BATCH);
      return outcome;
    })();
    const outcome = await Promise.race([work, timeout]);
    if (!outcome.ok && outcome.reason === "notify_timeout") {
      console.error(`[notify] 通知逾時 order=${orderId} —— 已交給排程，webhook 照常回 200`);
    }
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] triggerNotifyAfterPayment 例外 ${message}`);
    return { ok: false, reason: "unexpected_error" };
  }
}

// -----------------------------------------------------------------------------
// 把 outbox 沖出去
// -----------------------------------------------------------------------------

export type FlushResult = {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  givenUp: number;
};

/**
 * 拿一批待寄信，逐封送出去。**永不 throw。**
 *
 * 序列跑，不並行：同時打 Resend 好幾封並沒有比較快（瓶頸不在我們這邊），但併發
 * 會讓錯誤變得難以歸因（同 invoice-issuer.ts 的 runInvoiceBacklog）。
 *
 * ⚠️ claimEmailBatch() 已經在資料庫那一側把 attempts +1 並把 next_attempt_at 推到
 *    未來了，所以就算這個行程在下面任何一行死掉，那幾封信只是晚幾分鐘再試 ——
 *    不會卡住，也不會被別的 flush 同時拿走（for update skip locked）。
 */
export async function flushEmailOutbox(limit = EMAIL_FLUSH_BATCH): Promise<FlushResult> {
  const tally: FlushResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, givenUp: 0 };

  try {
    const batch = await claimEmailBatch(limit);
    tally.claimed = batch.length;
    if (batch.length === 0) return tally;

    if (!emailConfigured()) {
      // 一次講清楚，而不是每封信各印一行。
      console.warn(
        `[notify] 沒有 RESEND_API_KEY / MAIL_FROM —— 這 ${batch.length} 封走 dry run 並標記 skipped`,
      );
    }

    for (const mail of batch) {
      const result = await sendEmail({
        to: mail.toEmail,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });

      if (result.outcome === "failed") {
        const status = await failEmail(mail.id, result.error ?? "unknown");
        tally.failed += 1;
        if (status === "failed") {
          tally.givenUp += 1;
          console.error(
            `[notify] 放棄重試 key=${mail.dedupeKey} to=${maskEmail(mail.toEmail)} attempts=${mail.attempts}`,
          );
        }
        continue;
      }

      // dry run 標 skipped 不是 sent —— 見 src/server/email.ts 檔頭。
      const isDryRun = result.outcome === "dry_run";
      await finishEmail({ id: mail.id, providerId: result.id, skipped: isDryRun });
      if (isDryRun) tally.skipped += 1;
      else tally.sent += 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] flush 例外 ${message}`);
  }

  return tally;
}

// -----------------------------------------------------------------------------
// 補跑：付了錢卻沒排信的訂單
// -----------------------------------------------------------------------------

export type BacklogResult = {
  scanned: number;
  queued: number;
  adopted: number;
  failed: number;
  details: { orderNo: string; outcome: string }[];
};

/**
 * 掃過待通知清單，逐張補排。**永不 throw。**
 *
 * webhook 當下失敗的、instance 被回收的、資料庫當時掛掉的，全部從這裡補回來。
 *
 * ⚠️ 0022 §10 已經把「這一期上線之前就付過款的訂單」一次標成完成，所以這支不會
 *    去翻歷史訂單寄信給每一位舊客人。那一段的理由寫在那支 migration 裡。
 */
export async function runNotifyBacklog(limit = 20): Promise<BacklogResult> {
  const out: BacklogResult = { scanned: 0, queued: 0, adopted: 0, failed: 0, details: [] };

  try {
    const rows = await notifyBacklog(limit);
    out.scanned = rows.length;

    for (const row of rows) {
      const outcome = await queueOrderNotifications(row.orderId);
      if (outcome.ok) {
        if (outcome.adopted) out.adopted += 1;
        else out.queued += outcome.queued;
        out.details.push({ orderNo: row.orderNo, outcome: `ok queued=${outcome.queued}` });
      } else {
        out.failed += 1;
        out.details.push({ orderNo: row.orderNo, outcome: `fail ${outcome.reason}` });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] backlog 例外 ${message}`);
  }

  return out;
}

// -----------------------------------------------------------------------------
// 活動前 24 小時的提醒
// -----------------------------------------------------------------------------

export type ReminderResult = {
  sessions: number;
  queued: number;
};

/**
 * 掃出 24 小時內要開始的場次，替每一位在簽到表上的參加者排一封提醒信。
 * **永不 throw。**
 *
 * ⚠️ **沒有「這一場提醒過了沒有」的旗標。** 冪等來自 dedupe_key
 *    （`session_reminder:<session_id>:<registration_id>`）：排程每 10 分鐘掃一次，
 *    第二次之後全部撞 unique 變成 no-op。多一個旗標就多一個會與真實狀態對不上的
 *    地方 —— 例如「旗標設了但信其實沒排進去」。
 *
 * ⚠️ **寄給誰用 loadPaidRoster()**，不是自己寫一次條件。那正是快樂手
 *    queries.ts:117-125 那段紅字在防的事（「有人收到提醒卻不在簽到表上」）。
 *
 * 語言用**下單時的語言**（orders.locale），不是店家的預設語言：一個用日文結帳的
 * 客人收到中文提醒信，等於沒收到。
 */
export async function runSessionReminders(
  lead = REMINDER_LEAD,
  limit = 50,
): Promise<ReminderResult> {
  const out: ReminderResult = { sessions: 0, queued: 0 };

  try {
    const due = await sessionsDueForReminder(lead, limit);
    out.sessions = due.length;
    if (due.length === 0) return out;

    const copy = await loadEmailCopy();

    for (const session of due) {
      try {
        const roster = await loadPaidRoster(session.sessionId);
        const withEmail = roster.filter((r) => r.has_email);
        if (withEmail.length === 0) continue;

        const locales = await loadOrderLocales([...new Set(withEmail.map((r) => r.order_id))]);
        const brief: SessionBrief = {
          title: session.title,
          location: session.location,
          startsAt: session.startsAt,
          endsAt: session.endsAt,
        };

        const mails: RegistrationMailItem[] = withEmail.map((row) => {
          const lang: Lang = locales.get(row.order_id) ?? "zh";
          const mail = renderSessionReminderEmail(
            {
              participantName: row.name,
              seatNo: row.seat_no,
              orderNo: row.order_no,
              session: brief,
            },
            copy,
            lang,
          );
          return {
            registrationId: row.registration_id,
            dedupeKey: dedupeKeys.sessionReminder(session.sessionId, row.registration_id),
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
          };
        });

        const added = await enqueueRegistrationEmails(mails);
        out.queued += added;
        if (added > 0) {
          console.info(`[notify] 場次提醒已排入 session=${session.sessionId} queued=${added}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[notify] 場次提醒失敗 session=${session.sessionId} ${message}`);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[notify] 提醒信例外 ${message}`);
  }

  return out;
}

/** 寄出 30 天後清掉信件內文（0022 §6）。**永不 throw**，冪等。 */
export async function purgeEmailBodies(): Promise<number> {
  return purgeSentEmailBodies();
}

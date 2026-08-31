/**
 * 交易信的排版 —— **純函式，三語，不 import 任何 server-only 模組。**
 *
 * ── 為什麼這個檔案不能碰伺服器的東西 ──────────────────────────────────────
 * 排版是這一期最容易寫錯、也最容易看不出寫錯的部分：一個少填的變數、一個沒跳脫
 * 的 `<`、一個時區算錯的日期，寄出去之前沒有人會發現。所以它必須能被自檢**直接
 * import 起來跑**（scripts/notify-selftest.mjs 用 Node 的原生 TypeScript
 * type stripping 載入這一支），而那要求它不依賴 bundler、不依賴 tsconfig paths、
 * 也不能碰到 `@tanstack/react-start/server-only`。
 *
 * 同一個理由讓 src/server/amego.ts 與 src/server/payuni.ts 只依賴 node:crypto：
 * 驗一份複製品等於沒驗。
 *
 * ── 文案從哪裡來 ──────────────────────────────────────────────────────────
 * 三語文案存在 `public.email_copy`（0022 §2，形狀同 ui_strings），由
 * src/server/repos/email-outbox.ts 讀進來，以 `EmailCopy` 傳給這裡的函式。
 * 這個檔案內建一份 `DEFAULT_EMAIL_COPY` 當 fallback，關係與 src/lib/cms.ts 對
 * src/i18n/strings.ts 一樣：DB 有值就用 DB 的，缺的 key 用內建值補。
 *
 * ⚠️ **內建的文案全部是佔位**，正式文案 user 還沒給。每一段都以「（待補：…）」
 *    開頭，所以在信裡、在後台、在測試輸出裡都一眼看得出來還沒填。0022 §2 種進
 *    資料庫的是同樣的字串。
 *
 * ── 一封信的三個部分 ──────────────────────────────────────────────────────
 * subject / text / html。三個都要有：
 *   * 只給 html 的信在純文字客戶端（以及大部分垃圾信評分器）那邊是空的。
 *   * 只給 text 的信在手機上很難讀。
 * Resend 兩個欄位都收，所以兩份都產。
 *
 * ── 時區 ──────────────────────────────────────────────────────────────────
 * 一律 Asia/Taipei。這是一間台北的書店，活動時間寫錯一小時的後果是有人白跑一趟。
 * 不用 toLocaleString 的預設時區 —— Vercel 的機器是 UTC，那會讓「晚上 7 點的活動」
 * 在信裡變成「上午 11 點」。
 */
import type { Lang, Localized } from "@/i18n/types";

// -----------------------------------------------------------------------------
// 型別
// -----------------------------------------------------------------------------

/** 一封排好版的信。 */
export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

/**
 * 文案查表：`${template_key}.${string_key}` → Localized。
 *
 * 扁平的字串鍵而不是巢狀物件，是為了跟 `public.email_copy` 的
 * (template_key, string_key) 主鍵一對一 —— 少一層轉換就少一個對不上的地方。
 */
export type EmailCopy = Record<string, Localized>;

export type SessionBrief = {
  title: Localized;
  location: Localized;
  /** ISO 字串。 */
  startsAt: string;
  endsAt: string | null;
};

export type OrderPaidInput = {
  orderNo: string;
  customerName: string;
  total: number;
  items: { name: Localized; quantity: number; subtotal: number }[];
  /** 這張訂單買到的場次（可能 0 個 —— 只買書的訂單就是空陣列）。 */
  sessions: SessionBrief[];
};

export type RegistrationEmailInput = {
  /** 這一位參加者的姓名（0021 §0.1：姓名不遮罩）。 */
  participantName: string;
  /** 第幾個位子（1..quantity）。 */
  seatNo: number;
  orderNo: string;
  session: SessionBrief;
};

// -----------------------------------------------------------------------------
// 佔位文案（fallback）
// -----------------------------------------------------------------------------

/**
 * ⚠️ 全部是佔位。與 0022 §2 種進 `public.email_copy` 的字串**逐字相同** ——
 *    兩邊不同步的話，一個沒有那張表的環境（例如本機測試庫）會寄出跟正式環境
 *    不一樣的信，而那種差異沒有任何地方看得出來。
 *
 * scripts/notify-selftest.mjs 會把這裡的每一把 key 拿去 0022 的 SQL 裡對，
 * 少一把或多一把都紅。
 */
export const DEFAULT_EMAIL_COPY: EmailCopy = {
  "common.signature": {
    zh: "（待補：信末署名）小時光書店",
    en: "（待補：信末署名）小時光書店",
    ja: "（待補：信末署名）小時光書店",
  },
  "common.footerNote": {
    zh: "（待補：頁尾說明，例如「本信件由系統自動發送，回信將寄至小時光團隊」）",
    en: "（待補：頁尾說明）",
    ja: "（待補：頁尾說明）",
  },

  "order_paid.subject": {
    zh: "（待補：付款成功信主旨）訂單 {orderNo} 付款完成",
    en: "（待補：付款成功信主旨）Order {orderNo} paid",
    ja: "（待補：付款成功信主旨）ご注文 {orderNo} のお支払い完了",
  },
  "order_paid.heading": {
    zh: "（待補：付款成功信標題）我們收到您的付款了",
    en: "（待補：付款成功信標題）We have received your payment",
    ja: "（待補：付款成功信標題）お支払いを確認しました",
  },
  "order_paid.intro": {
    zh: "（待補：付款成功信開頭段落）",
    en: "（待補：付款成功信開頭段落）",
    ja: "（待補：付款成功信開頭段落）",
  },
  "order_paid.outro": {
    zh: "（待補：付款成功信結尾段落，例如出貨與取件說明）",
    en: "（待補：付款成功信結尾段落）",
    ja: "（待補：付款成功信結尾段落）",
  },

  "registration_ticket.subject": {
    zh: "（待補：報名成功信主旨）報名完成：{sessionTitle}",
    en: "（待補：報名成功信主旨）Registered: {sessionTitle}",
    ja: "（待補：報名成功信主旨）お申し込み完了：{sessionTitle}",
  },
  "registration_ticket.heading": {
    zh: "（待補：報名成功信標題）您的報名已完成",
    en: "（待補：報名成功信標題）Your registration is confirmed",
    ja: "（待補：報名成功信標題）お申し込みが完了しました",
  },
  "registration_ticket.intro": {
    zh: "（待補：報名成功信開頭段落）",
    en: "（待補：報名成功信開頭段落）",
    ja: "（待補：報名成功信開頭段落）",
  },
  "registration_ticket.outro": {
    zh: "（待補：報名成功信結尾段落，例如當天報到方式與注意事項）",
    en: "（待補：報名成功信結尾段落）",
    ja: "（待補：報名成功信結尾段落）",
  },

  "session_reminder.subject": {
    zh: "（待補：活動提醒信主旨）明天見：{sessionTitle}",
    en: "（待補：活動提醒信主旨）See you tomorrow: {sessionTitle}",
    ja: "（待補：活動提醒信主旨）明日開催：{sessionTitle}",
  },
  "session_reminder.heading": {
    zh: "（待補：活動提醒信標題）活動就在明天",
    en: "（待補：活動提醒信標題）Your event is tomorrow",
    ja: "（待補：活動提醒信標題）イベントは明日です",
  },
  "session_reminder.intro": {
    zh: "（待補：活動提醒信開頭段落）",
    en: "（待補：活動提醒信開頭段落）",
    ja: "（待補：活動提醒信開頭段落）",
  },
  "session_reminder.outro": {
    zh: "（待補：活動提醒信結尾段落，例如交通與聯絡方式）",
    en: "（待補：活動提醒信結尾段落）",
    ja: "（待補：活動提醒信結尾段落）",
  },
};

/**
 * 欄位標籤。**刻意不進 CMS。**
 *
 * 「訂單編號」「時間」「地點」這幾個字改動的機率趨近於零，而每多一列可編輯的
 * 文案就多一個可以被改成空字串的地方 —— 一封標籤全空的信比一封標籤寫得不夠好的
 * 信糟得多。CMS 管的是句子（開頭段落、結尾段落、署名），標籤留在程式碼裡。
 */
const LABELS: Record<string, Localized> = {
  orderNo: { zh: "訂單編號", en: "Order number", ja: "ご注文番号" },
  total: { zh: "應付金額", en: "Total", ja: "お支払い金額" },
  items: { zh: "訂單內容", en: "Items", ja: "ご注文内容" },
  sessionTitle: { zh: "活動場次", en: "Session", ja: "イベント" },
  startsAt: { zh: "時間", en: "When", ja: "日時" },
  location: { zh: "地點", en: "Where", ja: "場所" },
  attendee: { zh: "參加者", en: "Attendee", ja: "参加者" },
  seatNo: { zh: "座位序號", en: "Seat", ja: "座席番号" },
};

// -----------------------------------------------------------------------------
// 小工具
// -----------------------------------------------------------------------------

/**
 * 遮罩 Email，給 log 用。
 *
 * ⚠️ **log 裡不准出現裸的收件地址。** src/server/email.ts 與
 *    src/server/notify.ts 的每一行 console.* 都走這一支，靜態測試守著。
 *
 * 它放在這個「排版」檔案裡而不是 server 側，理由只有一個：這樣自檢 import 得到，
 * 遮罩規則才驗得到。它是純字串處理，沒有伺服器相依。
 *
 * 星號數量固定，不跟著原本的長度走 —— 長度本身也是一點資訊。
 */
export function maskEmail(email: string | null | undefined): string {
  const v = (email ?? "").trim();
  const at = v.indexOf("@");
  if (at <= 0) return "***";
  const name = v.slice(0, at);
  const domain = v.slice(at);
  const head = name.slice(0, name.length > 1 ? 2 : 1);
  return `${head}***${domain}`;
}

/** 取一個語言的字串，缺了就退回中文（zh 是這個站的主語言）。 */
export function pick(value: Localized | undefined, lang: Lang): string {
  if (!value) return "";
  return (value[lang] || value.zh || value.en || value.ja || "").trim();
}

/**
 * 查一段文案：DB 給的優先，缺了用內建的佔位補。
 *
 * 「缺了」包含 key 不存在**與 值是空字串**兩種。後者是真的會發生的：後台把某一段
 * 清空存檔，`is_localized()` 只檢查三個 key 在不在，不檢查非空。
 */
export function copyText(copy: EmailCopy | undefined, key: string, lang: Lang): string {
  const fromDb = pick(copy?.[key], lang);
  if (fromDb) return fromDb;
  return pick(DEFAULT_EMAIL_COPY[key], lang);
}

/** `{orderNo}` 這種佔位換成實際值。找不到的變數原樣留著（比印出 undefined 好）。 */
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  );
}

/**
 * HTML 跳脫。
 *
 * 姓名、活動名稱、地點全部是使用者或店員輸入的。少了這一步，一個叫做
 * `<script>` 的活動名稱就會讓信件在某些客戶端裡變成一個奇怪的東西 —— 而且
 * 那封信已經寄出去了，改不回來。
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 台幣整數。與站上其他地方一致（0005 起金額全是 TWD 整數元）。 */
export function formatMoney(amount: number): string {
  return `NT$${Math.round(amount).toLocaleString("en-US")}`;
}

const TIME_ZONE = "Asia/Taipei";

/**
 * 場次時間，一律台北時區。
 *
 * ⚠️ 不用 `toLocaleString()` 的預設時區。Vercel 的機器跑在 UTC，那會讓一場
 *    晚上 7 點的活動在信裡變成上午 11 點 —— 而收信的人會照著信上的時間出門。
 *
 * 壞掉的 ISO 字串回原字串而不是 "Invalid Date"：信裡出現一個看得懂的原始值，
 * 遠好過出現一個所有人都看不懂的錯誤字。
 */
export function formatDateTime(iso: string, lang: Lang): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const locale = lang === "ja" ? "ja-JP" : lang === "en" ? "en-US" : "zh-TW";
  return new Intl.DateTimeFormat(locale, {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** 開始～結束。沒有結束時間就只印開始（0020：ends_at 是選填的）。 */
function formatRange(session: SessionBrief, lang: Lang): string {
  const start = formatDateTime(session.startsAt, lang);
  if (!session.endsAt) return start;
  return `${start} – ${formatDateTime(session.endsAt, lang)}`;
}

// -----------------------------------------------------------------------------
// 版型
// -----------------------------------------------------------------------------

type Row = { label: string; value: string };

/**
 * 一封信的骨架。三封信共用，所以版型只有一份。
 *
 * HTML 刻意樸素：沒有外部 CSS、沒有圖片、沒有 web font。信件客戶端對 CSS 的支援
 * 差異極大，而一封在 Outlook 裡整個散掉的漂亮信，比一封到處都長一樣的樸素信糟。
 * 全部用 inline style。
 */
function layout(input: {
  heading: string;
  intro: string;
  rows: Row[];
  blocks: { title: string; rows: Row[] }[];
  outro: string;
  signature: string;
  footerNote: string;
}): { text: string; html: string } {
  const textLines: string[] = [input.heading, ""];
  if (input.intro) textLines.push(input.intro, "");
  for (const r of input.rows) textLines.push(`${r.label}：${r.value}`);
  for (const b of input.blocks) {
    textLines.push("", b.title);
    for (const r of b.rows) textLines.push(`  ${r.label}：${r.value}`);
  }
  if (input.outro) textLines.push("", input.outro);
  textLines.push("", input.signature, "", input.footerNote);

  const row = (r: Row) =>
    `<tr>` +
    `<td style="padding:4px 12px 4px 0;color:#6b6257;white-space:nowrap;vertical-align:top">${escapeHtml(r.label)}</td>` +
    `<td style="padding:4px 0;color:#2b2621">${escapeHtml(r.value)}</td>` +
    `</tr>`;

  const table = (rows: Row[]) =>
    rows.length === 0
      ? ""
      : `<table style="border-collapse:collapse;font-size:14px;line-height:1.7">${rows.map(row).join("")}</table>`;

  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans TC',sans-serif;` +
    `max-width:560px;margin:0 auto;padding:24px;color:#2b2621;background:#ffffff">` +
    `<h1 style="font-size:20px;line-height:1.5;margin:0 0 16px">${escapeHtml(input.heading)}</h1>` +
    (input.intro
      ? `<p style="font-size:14px;line-height:1.8;margin:0 0 16px">${escapeHtml(input.intro)}</p>`
      : "") +
    table(input.rows) +
    input.blocks
      .map(
        (b) =>
          `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e7e1d8">` +
          `<p style="font-size:14px;font-weight:600;margin:0 0 6px">${escapeHtml(b.title)}</p>` +
          table(b.rows) +
          `</div>`,
      )
      .join("") +
    (input.outro
      ? `<p style="font-size:14px;line-height:1.8;margin:20px 0 0">${escapeHtml(input.outro)}</p>`
      : "") +
    `<p style="font-size:14px;line-height:1.8;margin:20px 0 0">${escapeHtml(input.signature)}</p>` +
    `<p style="font-size:12px;line-height:1.7;color:#8a8175;margin:24px 0 0;` +
    `padding-top:12px;border-top:1px solid #e7e1d8">${escapeHtml(input.footerNote)}</p>` +
    `</div>`;

  return { text: textLines.join("\n"), html };
}

function sessionRows(session: SessionBrief, lang: Lang): Row[] {
  return [
    { label: pick(LABELS.sessionTitle, lang), value: pick(session.title, lang) },
    { label: pick(LABELS.startsAt, lang), value: formatRange(session, lang) },
    { label: pick(LABELS.location, lang), value: pick(session.location, lang) },
  ];
}

// -----------------------------------------------------------------------------
// 三封信
// -----------------------------------------------------------------------------

/**
 * 付款成功（寄給訂購人）。dedupe_key = `order_paid:<order_id>`。
 *
 * ⚠️ **不含發票號碼**，理由見 0022 檔頭 §0.3：發票有 8 秒逾時保護，等它就等於
 *    讓 Amego 慢的時候信也不寄。
 */
export function renderOrderPaidEmail(
  input: OrderPaidInput,
  copy: EmailCopy | undefined,
  lang: Lang,
): RenderedEmail {
  const subject = fill(copyText(copy, "order_paid.subject", lang), {
    orderNo: input.orderNo,
    customerName: input.customerName,
  });

  const itemLines = input.items
    .map((it) => `${pick(it.name, lang)} × ${it.quantity}　${formatMoney(it.subtotal)}`)
    .join("\n");

  const rows: Row[] = [
    { label: pick(LABELS.orderNo, lang), value: input.orderNo },
    { label: pick(LABELS.total, lang), value: formatMoney(input.total) },
  ];
  if (itemLines) rows.push({ label: pick(LABELS.items, lang), value: itemLines });

  const { text, html } = layout({
    heading: fill(copyText(copy, "order_paid.heading", lang), {
      customerName: input.customerName,
    }),
    intro: fill(copyText(copy, "order_paid.intro", lang), { customerName: input.customerName }),
    rows,
    blocks: input.sessions.map((s) => ({
      title: pick(LABELS.sessionTitle, lang),
      rows: sessionRows(s, lang),
    })),
    outro: copyText(copy, "order_paid.outro", lang),
    signature: copyText(copy, "common.signature", lang),
    footerNote: copyText(copy, "common.footerNote", lang),
  });

  return { subject, text, html };
}

/**
 * 報名成功（寄給**每一位**參加者，不是訂購人）。
 * dedupe_key = `registration_ticket:<registration_id>`。
 */
export function renderRegistrationTicketEmail(
  input: RegistrationEmailInput,
  copy: EmailCopy | undefined,
  lang: Lang,
): RenderedEmail {
  const vars = {
    sessionTitle: pick(input.session.title, lang),
    participantName: input.participantName,
    orderNo: input.orderNo,
  };

  const { text, html } = layout({
    heading: fill(copyText(copy, "registration_ticket.heading", lang), vars),
    intro: fill(copyText(copy, "registration_ticket.intro", lang), vars),
    rows: [
      { label: pick(LABELS.attendee, lang), value: input.participantName },
      { label: pick(LABELS.seatNo, lang), value: String(input.seatNo) },
      { label: pick(LABELS.orderNo, lang), value: input.orderNo },
    ],
    blocks: [{ title: pick(LABELS.sessionTitle, lang), rows: sessionRows(input.session, lang) }],
    outro: copyText(copy, "registration_ticket.outro", lang),
    signature: copyText(copy, "common.signature", lang),
    footerNote: copyText(copy, "common.footerNote", lang),
  });

  return {
    subject: fill(copyText(copy, "registration_ticket.subject", lang), vars),
    text,
    html,
  };
}

/**
 * 活動前 24 小時的提醒（寄給每一位參加者）。
 * dedupe_key = `session_reminder:<session_id>:<registration_id>`。
 */
export function renderSessionReminderEmail(
  input: RegistrationEmailInput,
  copy: EmailCopy | undefined,
  lang: Lang,
): RenderedEmail {
  const vars = {
    sessionTitle: pick(input.session.title, lang),
    participantName: input.participantName,
    orderNo: input.orderNo,
  };

  const { text, html } = layout({
    heading: fill(copyText(copy, "session_reminder.heading", lang), vars),
    intro: fill(copyText(copy, "session_reminder.intro", lang), vars),
    rows: [
      { label: pick(LABELS.attendee, lang), value: input.participantName },
      { label: pick(LABELS.seatNo, lang), value: String(input.seatNo) },
      { label: pick(LABELS.orderNo, lang), value: input.orderNo },
    ],
    blocks: [{ title: pick(LABELS.sessionTitle, lang), rows: sessionRows(input.session, lang) }],
    outro: copyText(copy, "session_reminder.outro", lang),
    signature: copyText(copy, "common.signature", lang),
    footerNote: copyText(copy, "common.footerNote", lang),
  });

  return {
    subject: fill(copyText(copy, "session_reminder.subject", lang), vars),
    text,
    html,
  };
}

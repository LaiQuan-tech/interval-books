/**
 * Sends the browser to the payment gateway.
 *
 * 兩種交接方式，**不是同一件事的兩種寫法**（見 src/lib/checkout.ts 的 PaymentHandoff）：
 *
 *   redirect  黑貓 PAY（統一客樂得 COCS）—— 這家店實際在跑的那條。訂單在伺服器端
 *             就建好了，回來一個線上刷卡網址，直接導過去。
 *   form      PayUni 直連 UPP —— 交易在瀏覽器 POST 的那一刻才產生，所以沒有網址
 *             可以導，只能組表單送出。
 *
 * WHY THE PAYUNI PATH IS A FORM AND NOT `location.href = …`
 * ---------------------------------------------------------
 * PayUni's integrated payment page (UPP) has no server-side "create the trade,
 * get back a redirect URL" step. The trade comes into existence when the
 * *browser* POSTs MerID / Version / EncryptInfo / HashInfo to their endpoint.
 * There is therefore no URL to navigate to — the form submission IS the
 * hand-off. Every attempt to "simplify" this into a redirect ends with a
 * shopper looking at a PayUni error page.
 *
 * The form is built in the DOM rather than rendered by React on purpose:
 * submitting it navigates the page away, so it must not be part of a tree that
 * React may re-render or unmount underneath the submit call.
 *
 * Nothing secret passes through here. EncryptInfo is AES-256-GCM ciphertext and
 * HashInfo is a digest; the HashKey and HashIV that produced them never leave
 * the server (see src/server/payuni.ts).
 */
import type { PaymentHandoff } from "@/lib/checkout";

export function submitPaymentForm(handoff: PaymentHandoff): void {
  if (typeof document === "undefined") return;

  // 黑貓：伺服器端已經建好單，只要把人送過去。
  // 用 assign 而不是 replace，是為了讓「上一頁」還能回到結帳頁 —— 客人在刷卡頁
  // 反悔時，訂單還在、庫存也還保留著，回得去才付得成。
  if (handoff.kind === "redirect") {
    window.location.assign(handoff.url);
    return;
  }

  const form = document.createElement("form");
  form.method = "POST";
  form.action = handoff.action;
  // Not _blank: a popup blocker would silently swallow the whole checkout.
  form.style.display = "none";

  for (const [name, value] of Object.entries(handoff.fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}

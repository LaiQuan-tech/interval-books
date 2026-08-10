/**
 * Sends the browser to PayUni.
 *
 * WHY THIS IS A FORM AND NOT `location.href = …`
 * ---------------------------------------------
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

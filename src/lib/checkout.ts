/**
 * Checkout rules shared by the browser and the server.
 *
 * Everything in here is pure: no Supabase client, no server-only import, no
 * React. That is what lets the same shipping formula price the summary the
 * shopper is looking at and the order that actually gets written, instead of
 * two implementations drifting apart — which is precisely how the Realreal
 * storefront ended up with four different shipping tables (see the comment on
 * SHIPPING_RULES).
 *
 * The one thing this module deliberately cannot do is *decide* what anything
 * costs. computeShippingFee() takes a subtotal; it does not compute one. Line
 * prices come from public.products inside src/server/repos/orders.ts and
 * nowhere else, so a tampered request can change what is bought but never what
 * it costs.
 */
import { z } from "zod";
import type { Lang, Localized } from "@/i18n/types";

/** Mirrors orders.shipping_method's CHECK in 0005_commerce_orders.sql. */
export type ShippingMethod = "home" | "cvs" | "pickup" | "none";

/** Mirrors order_items.product_type's CHECK in 0005_commerce_orders.sql. */
export type ProductTypeForOrder = "goods" | "book" | "event" | "journey";

// -----------------------------------------------------------------------------
// Shipping
// -----------------------------------------------------------------------------

/**
 * TWD whole dollars. `freeThreshold: 0` means "this method has no free-shipping
 * tier" — not "everything is free" — which is the same convention Realreal uses
 * (apps/api/src/lib/shipping.ts).
 *
 * WHY THESE NUMBERS ARE CONSTANTS AND NOT A SETTINGS TABLE
 * --------------------------------------------------------
 * Realreal keeps its rates in an encrypted app_settings table with a 30-second
 * cache and a code-level fallback. That indirection is why it now has FOUR
 * disagreeing sources of truth — the DB seed says 100/60, the code defaults say
 * 150/80, the hard fallback says 80/80 with a free threshold of *zero*, and a
 * dead client-side copy says 100/80. Its own 0029 migration exists to explain
 * an outage where the encrypted read failed and free shipping silently
 * switched off site-wide for everyone.
 *
 * A two-method shop with one rate each does not need any of that. These are the
 * rates from Realreal's own seed migration (0027_shipping_settings.sql), stated
 * once, in the open, where a code review can see them change.
 *
 * `cvs` is priced but not offered: convenience-store pickup needs ECPay's store
 * picker to produce a store id, and there is nowhere to put one yet. The rate
 * is here so that turning it on later is a UI change, not a pricing decision.
 */
export const SHIPPING_RULES: Record<ShippingMethod, { fee: number; freeThreshold: number }> = {
  home: { fee: 100, freeThreshold: 999 },
  cvs: { fee: 60, freeThreshold: 499 },
  pickup: { fee: 0, freeThreshold: 0 },
  none: { fee: 0, freeThreshold: 0 },
};

/** What the checkout form actually shows. See the `cvs` note on SHIPPING_RULES. */
export const OFFERED_SHIPPING_METHODS = ["home", "pickup"] as const;
export type OfferedShippingMethod = (typeof OFFERED_SHIPPING_METHODS)[number];

/**
 * Freight for one cart.
 *
 * `needsShipping` comes from the products, never from the form: a cart holding
 * only event or journey bookings (products.requires_shipping = false) has
 * nothing to post, so it pays nothing and is never asked for an address.
 * Realreal has no equivalent — it has no per-product shipping flag at all and
 * charges one cart-wide rate regardless — so this is the one place the model
 * here is deliberately larger than the one it was copied from.
 */
export function computeShippingFee({
  needsShipping,
  method,
  subtotal,
}: {
  needsShipping: boolean;
  method: ShippingMethod;
  subtotal: number;
}): number {
  if (!needsShipping) return 0;
  const rule = SHIPPING_RULES[method] ?? SHIPPING_RULES.home;
  if (rule.freeThreshold > 0 && subtotal >= rule.freeThreshold) return 0;
  return rule.fee;
}

/** How much more is needed to reach free shipping, or null when it does not apply. */
export function amountToFreeShipping({
  needsShipping,
  method,
  subtotal,
}: {
  needsShipping: boolean;
  method: ShippingMethod;
  subtotal: number;
}): number | null {
  if (!needsShipping) return null;
  const rule = SHIPPING_RULES[method] ?? SHIPPING_RULES.home;
  if (rule.freeThreshold <= 0) return null;
  const gap = rule.freeThreshold - subtotal;
  return gap > 0 ? gap : null;
}

// -----------------------------------------------------------------------------
// Failures
// -----------------------------------------------------------------------------

/**
 * A checkout failure the shopper is allowed to see, as a stable token rather
 * than a sentence. The server has no business choosing between zh, en and ja —
 * the browser knows which one is on screen, so it does the rendering.
 */
export type CheckoutErrorCode =
  | "cart_empty"
  | "product_unavailable"
  | "insufficient_stock"
  | "no_seats_left"
  | "shipping_address_required"
  | "order_failed";

export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode;
  constructor(code: CheckoutErrorCode) {
    super(code);
    this.name = "CheckoutError";
    this.code = code;
  }
}

export const CHECKOUT_ERROR_COPY: Record<CheckoutErrorCode, Localized> = {
  cart_empty: {
    zh: "購物車是空的。",
    en: "Your cart is empty.",
    ja: "カートが空です。",
  },
  product_unavailable: {
    zh: "購物車中有商品已經下架，請回到購物車移除後再結帳。",
    en: "Something in your cart is no longer available. Please remove it in the cart and try again.",
    ja: "カート内に取り扱いを終了した商品があります。カートで削除してからお進みください。",
  },
  insufficient_stock: {
    zh: "庫存不足，訂單沒有成立。請回到購物車調整數量。",
    en: "There is not enough stock, so no order was created. Please adjust the quantity in your cart.",
    ja: "在庫が足りないため、ご注文は成立していません。カートで数量をご調整ください。",
  },
  no_seats_left: {
    zh: "名額已滿，訂單沒有成立。請回到購物車調整數量。",
    en: "There are no places left, so no order was created. Please adjust the quantity in your cart.",
    ja: "空き枠がないため、ご注文は成立していません。カートで数量をご調整ください。",
  },
  shipping_address_required: {
    zh: "這筆訂單需要寄送地址。",
    en: "This order needs a delivery address.",
    ja: "このご注文にはお届け先の住所が必要です。",
  },
  order_failed: {
    zh: "訂單建立失敗，請稍後再試。若持續發生，歡迎來信告訴我們。",
    en: "We could not create the order. Please try again shortly, or write to us if it keeps happening.",
    ja: "ご注文を作成できませんでした。しばらくしてからお試しいただくか、解決しない場合はご連絡ください。",
  },
};

const KNOWN_CODES = new Set(Object.keys(CHECKOUT_ERROR_COPY));

/**
 * Turns whatever came back from the server function into copy in the current
 * language. Accepts a bare code (the normal path — placeOrder *returns*
 * failures rather than throwing them) or a thrown Error (the path that only
 * fires when the transport itself broke).
 *
 * Anything unrecognized is reported as a generic failure rather than printed.
 * Server-side exception text is written for a log, not for a shopper, and tends
 * to say more about the system than it should.
 */
export function checkoutErrorText(codeOrError: unknown, lang: Lang): string {
  const raw =
    typeof codeOrError === "string"
      ? codeOrError
      : codeOrError instanceof Error
        ? codeOrError.message
        : "";
  const code = (KNOWN_CODES.has(raw) ? raw : "order_failed") as CheckoutErrorCode;
  return CHECKOUT_ERROR_COPY[code][lang] || CHECKOUT_ERROR_COPY[code].zh;
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/**
 * Taiwan mobile numbers, copied verbatim from Realreal's checkout
 * (apps/web/src/app/checkout/page.tsx). Its API later relaxed the same field to
 * `min(1)` to accommodate overseas numbers; this shop posts domestically only,
 * so the strict form is kept on both sides rather than validated in the browser
 * and waved through on the server.
 */
const TW_MOBILE = /^09\d{8}$/;

type Translate = (value: Localized) => string;

const MSG = {
  name: { zh: "請輸入姓名", en: "Please enter a name", ja: "お名前をご入力ください" },
  nameLong: { zh: "姓名過長", en: "That name is too long", ja: "お名前が長すぎます" },
  email: { zh: "請輸入電子信箱", en: "Please enter an email address", ja: "メールアドレスをご入力ください" },
  emailFormat: {
    zh: "電子信箱格式不正確",
    en: "That email address does not look right",
    ja: "メールアドレスの形式が正しくありません",
  },
  phone: {
    zh: "請輸入手機號碼（09 開頭共 10 碼）",
    en: "Please enter a mobile number (10 digits starting 09)",
    ja: "携帯番号をご入力ください（09 で始まる 10 桁）",
  },
  recipient: { zh: "請輸入收件人姓名", en: "Please enter a recipient", ja: "お届け先のお名前をご入力ください" },
  city: { zh: "請輸入縣市", en: "Please enter a city", ja: "市・県をご入力ください" },
  street: { zh: "請輸入詳細地址", en: "Please enter a street address", ja: "住所をご入力ください" },
  tooLong: { zh: "內容過長", en: "That is too long", ja: "内容が長すぎます" },
  noteLong: { zh: "備註最多 500 字", en: "Notes are limited to 500 characters", ja: "備考は 500 文字までです" },
} satisfies Record<string, Localized>;

/**
 * One schema definition, rendered in whichever language is asked for.
 *
 * The browser passes the live translator so a Japanese shopper gets Japanese
 * validation errors; the server function passes the zh reader, because its
 * messages are never displayed — by the time the server rejects something, the
 * browser has already validated it, so a server-side failure means the payload
 * was edited in transit and the shopper sees the generic failure instead.
 */
export function checkoutFormSchema({
  t,
  requireAddress,
}: {
  t: Translate;
  requireAddress: boolean;
}) {
  const strictAddress = z.object({
    recipient: z.string().trim().min(1, t(MSG.recipient)).max(60, t(MSG.nameLong)),
    phone: z.string().trim().regex(TW_MOBILE, t(MSG.phone)),
    postalCode: z.string().trim().max(10, t(MSG.tooLong)).optional().nullable(),
    city: z.string().trim().min(1, t(MSG.city)).max(40, t(MSG.tooLong)),
    district: z.string().trim().max(40, t(MSG.tooLong)).optional().nullable(),
    street: z.string().trim().min(1, t(MSG.street)).max(200, t(MSG.tooLong)),
  });

  /**
   * Same fields, no rules — deliberately NOT `strictAddress.partial()`.
   *
   * `.partial()` only makes a key allowed to be absent; a key that is present
   * and empty still runs its rule. The form keeps `address` mounted with empty
   * defaults so that switching delivery method does not lose what was typed,
   * so under `.partial()` an empty `phone: ""` failed the 09-prefix regex on a
   * field the shopper could not see and had no reason to fill — and
   * handleSubmit then refused to submit, silently, with nothing on screen to
   * explain why. Keeping the length caps but dropping the format rules is what
   * makes "this address is not needed" mean it.
   */
  const looseAddress = z.object({
    recipient: z.string().trim().max(60, t(MSG.nameLong)).optional().nullable(),
    phone: z.string().trim().max(30, t(MSG.tooLong)).optional().nullable(),
    postalCode: z.string().trim().max(10, t(MSG.tooLong)).optional().nullable(),
    city: z.string().trim().max(40, t(MSG.tooLong)).optional().nullable(),
    district: z.string().trim().max(40, t(MSG.tooLong)).optional().nullable(),
    street: z.string().trim().max(200, t(MSG.tooLong)).optional().nullable(),
  });

  return z.object({
    customerName: z.string().trim().min(1, t(MSG.name)).max(60, t(MSG.nameLong)),
    customerEmail: z
      .string()
      .trim()
      .min(1, t(MSG.email))
      .email(t(MSG.emailFormat))
      .max(120, t(MSG.tooLong)),
    customerPhone: z.string().trim().regex(TW_MOBILE, t(MSG.phone)),
    shippingMethod: z.enum(["home", "cvs", "pickup", "none"]),
    // Whether an address is required is a fact about the cart, and the cart is
    // not in this object. The form passes requireAddress; the server re-derives
    // the same answer from products.requires_shipping and enforces it itself,
    // so a request that skips the browser cannot skip the address.
    address: (requireAddress ? strictAddress : looseAddress).optional().nullable(),
    note: z.string().trim().max(500, t(MSG.noteLong)).optional().nullable(),
  });
}

/**
 * Written out rather than inferred: checkoutFormSchema returns one of two
 * shapes, and react-hook-form needs a single stable value type to bind the
 * inputs to. This is the looser of the two, which is the one every field can
 * satisfy.
 */
export type CheckoutFormValues = {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  shippingMethod: ShippingMethod;
  address?: {
    recipient?: string | null;
    phone?: string | null;
    postalCode?: string | null;
    city?: string | null;
    district?: string | null;
    street?: string | null;
  } | null;
  note?: string | null;
};

/** One cart line as the browser is permitted to describe it: what, and how many. */
export const checkoutItemSchema = z.object({
  productId: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(99),
});

/**
 * The full server-function input.
 *
 * Note what is absent: no price, no subtotal, no total, no shipping fee, no
 * product name, no stock figure. There is no field here a shopper could edit to
 * change what they are charged, because none of those numbers make the trip —
 * they are all read out of the database on the server side.
 */
export const checkoutPayloadSchema = checkoutFormSchema({
  t: (m) => m.zh,
  requireAddress: false,
}).extend({
  items: z.array(checkoutItemSchema).min(1).max(50),
  locale: z.enum(["zh", "en", "ja"]),
  /** Per-attempt UUID; orders.idempotency_key is unique, so a double-submit replays. */
  idempotencyKey: z.string().uuid(),
});

export type CheckoutPayload = z.infer<typeof checkoutPayloadSchema>;

/** What the confirmation page is allowed to know. No PII, and never the token. */
export type OrderConfirmation = {
  orderNo: string;
  status: string;
  paymentStatus: string;
  subtotal: number;
  shippingFee: number;
  discount: number;
  total: number;
  shippingMethod: ShippingMethod;
  createdAt: string;
  items: {
    name: Localized;
    unitPrice: number;
    quantity: number;
    subtotal: number;
    productType: ProductTypeForOrder;
  }[];
};

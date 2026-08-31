/**
 * /checkout — collect who this is going to, create the order, hand off to PayUni.
 *
 * The totals rendered here are advisory. Every number is recomputed on the
 * server from public.products before anything is written, so what this panel
 * shows and what the order says can only differ if the catalogue changed
 * mid-checkout — in which case the server's answer is the correct one. The same
 * goes for the amount PayUni is asked for: it is the server's `total`, never
 * the one on screen.
 *
 * WHAT HAPPENS ON SUBMIT
 * ----------------------
 * placeOrder() returns either a `payment` form or null.
 *   * form → build it in the DOM and submit it. PayUni's integrated payment
 *     page only exists as the result of a browser POST; there is no URL to
 *     redirect to (see src/lib/payment-redirect.ts).
 *   * null → the pre-gateway behaviour: the order stands and we contact the
 *     shopper about payment. This is what an unconfigured PAYUNI_* environment
 *     falls back to, so a missing key degrades to "order held", never to
 *     "checkout broken".
 *
 * The cart is NOT cleared here and NOT cleared on arrival at the confirmation
 * page — only once payment is actually settled. See checkout.complete.tsx.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { PageShell, PageHeader } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useLang, useT } from "@/i18n/LanguageContext";
import { useDocumentMeta } from "@/i18n/useDocumentMeta";
import { keyOfLine, useCart, useCartHydrated, type CartLine } from "@/lib/cart";
import {
  amountToFreeShipping,
  checkoutErrorText,
  checkoutFormSchemaWithParticipants,
  computeShippingFee,
  SHIPPING_RULES,
  type CheckoutFormValues,
  type OfferedShippingMethod,
} from "@/lib/checkout";
import { fetchPaymentOptions, placeOrder } from "@/lib/checkout-fns";
import { ParticipantFields } from "@/components/shop/ParticipantFields";
import { submitPaymentForm } from "@/lib/payment-redirect";
import { fetchActiveProducts, formatPrice } from "@/lib/shop";
import { useSiteContent } from "@/lib/site-content";

const PAGE = {
  metaTitle: {
    zh: "結帳 Checkout｜小時光書店 Interval Books",
    en: "Checkout｜Interval Books",
    ja: "ご購入手続き｜小時光書店 Interval Books",
  },
  metaDescription: {
    zh: "填寫收件資料，完成小時光書店的訂單。付款方式將於下一階段開放。",
    en: "Enter your delivery details to complete your Interval Books order. Payment opens in the next phase.",
    ja: "お届け先をご入力いただき、小時光書店のご注文を確定します。お支払いは次の段階で開放されます。",
  },
  eyebrowSuffix: { zh: "結帳", en: "Checkout", ja: "ご購入手続き" },
  title: { zh: "留下收件資料", en: "Where should this go", ja: "お届け先のご入力" },
  intro: {
    zh: "確認品項與金額後填寫收件資料。送出後訂單就會成立，我們會與你聯繫付款方式。",
    en: "Check the items and the total, then tell us where to send them. Your order is created on submit and we will follow up about payment.",
    ja: "商品と金額をご確認のうえ、お届け先をご入力ください。送信後にご注文が成立し、お支払い方法についてご連絡いたします。",
  },
  empty: {
    zh: "購物車是空的，還沒有可以結帳的品項。",
    en: "Your cart is empty — there is nothing to check out yet.",
    ja: "カートが空のため、お手続きに進めません。",
  },
  contactSection: { zh: "聯絡資料", en: "Your details", ja: "ご連絡先" },
  participantsSection: { zh: "參加者資料", en: "Who is coming", ja: "参加者情報" },
  participantsIntro: {
    zh: "活動報名需要每一位參加者的姓名與聯絡方式，現場才點得到名。",
    en: "Bookings need a name and a way to reach each attendee, so we can check everyone in on the day.",
    ja: "当日の受付のため、参加者お一人ずつのお名前とご連絡先をご入力ください。",
  },
  shippingSection: { zh: "寄送方式", en: "Delivery", ja: "お届け方法" },
  addressSection: { zh: "收件地址", en: "Delivery address", ja: "お届け先住所" },
  noteSection: { zh: "備註", en: "Notes", ja: "備考" },
  name: { zh: "姓名", en: "Name", ja: "お名前" },
  email: { zh: "電子信箱", en: "Email", ja: "メールアドレス" },
  phone: { zh: "手機號碼", en: "Mobile number", ja: "携帯番号" },
  recipient: { zh: "收件人姓名", en: "Recipient", ja: "お届け先のお名前" },
  recipientPhone: { zh: "收件人電話", en: "Recipient phone", ja: "お届け先電話番号" },
  postalCode: { zh: "郵遞區號（選填）", en: "Postal code (optional)", ja: "郵便番号（任意）" },
  city: { zh: "縣市", en: "City", ja: "市・県" },
  district: { zh: "鄉鎮市區（選填）", en: "District (optional)", ja: "区・町（任意）" },
  street: { zh: "詳細地址", en: "Street address", ja: "番地・建物名" },
  note: {
    zh: "想讓我們知道的事（選填）",
    en: "Anything we should know (optional)",
    ja: "ご要望など（任意）",
  },
  methodHome: { zh: "宅配到府", en: "Home delivery", ja: "自宅へお届け" },
  methodPickup: { zh: "到店自取", en: "Pick up in store", ja: "店頭でお受け取り" },
  methodFree: { zh: "免運費", en: "Free", ja: "送料無料" },
  noShippingNeeded: {
    zh: "這筆訂單只有活動與策旅名額，不需要寄送，也不收運費。",
    en: "This order is bookings only — nothing to post, and no shipping to pay.",
    ja: "このご注文はお申し込みのみのため、配送も送料もございません。",
  },
  pickupNote: {
    zh: "到店自取免運費。我們會在備妥後與你聯繫取件時間。",
    en: "Store pickup is free. We will be in touch once your order is ready to collect.",
    ja: "店頭でのお受け取りは送料無料です。ご用意ができ次第ご連絡いたします。",
  },
  freeShippingGap: { zh: "再買", en: "Spend", ja: "あと" },
  freeShippingGapTail: { zh: "即可免運", en: "more for free shipping", ja: "で送料無料" },
  summary: { zh: "訂單明細", en: "Order summary", ja: "ご注文内容" },
  subtotal: { zh: "小計", en: "Subtotal", ja: "小計" },
  shipping: { zh: "運費", en: "Shipping", ja: "送料" },
  total: { zh: "應付總額", en: "Total", ja: "合計" },
  submit: { zh: "送出訂單", en: "Place order", ja: "注文を確定する" },
  submitPay: { zh: "前往付款", en: "Continue to payment", ja: "お支払いへ進む" },
  submitting: { zh: "訂單建立中…", en: "Creating your order…", ja: "ご注文を作成中…" },
  redirecting: {
    zh: "正在前往付款頁，請不要關閉或重新整理…",
    en: "Taking you to the payment page — please do not close or refresh…",
    ja: "決済ページへ移動しています。閉じたり更新したりしないでください…",
  },
  paymentSection: { zh: "付款方式", en: "Payment", ja: "お支払い方法" },
  payCard: { zh: "信用卡線上付款", en: "Pay by card", ja: "クレジットカード決済" },
  payCardNote: {
    zh: "送出後會前往統一金流 PayUni 的付款頁完成刷卡。付款成功才會扣除購物車。",
    en: "You will be taken to PayUni's secure page to pay by card. Your cart is only emptied once payment succeeds.",
    ja: "送信後、PayUni の決済ページでお支払いいただきます。カートはお支払い完了後に空になります。",
  },
  payOffline: {
    zh: "由我們與你聯繫付款",
    en: "Arrange payment with us",
    ja: "個別にお支払いをご案内",
  },
  payOfflineNote: {
    zh: "訂單會先成立並保留品項，我們會以電子信箱與你聯繫付款方式。",
    en: "Your order is created and the items are held; we will email you about payment.",
    ja: "ご注文を確定し商品をお取り置きしたうえで、お支払い方法をメールでご案内します。",
  },
  paymentUnavailable: {
    zh: "線上付款目前未開放，訂單成立後我們會直接與你聯繫付款方式。",
    en: "Online payment is not open yet — we will contact you about payment once the order is placed.",
    ja: "オンライン決済は現在ご利用いただけません。ご注文後にお支払い方法をご連絡いたします。",
  },
  invoiceSection: { zh: "電子發票", en: "Invoice", ja: "電子インボイス" },
  invoiceIntro: {
    zh: "付款完成後會自動開立電子發票，並以電子信箱通知。統編與載具送出後就不能改，請先確認。",
    en: "An e-invoice is issued automatically once payment clears, and emailed to you. A business number or carrier cannot be changed after submitting, so please check it now.",
    ja: "お支払い完了後に電子インボイスを自動発行し、メールでお知らせします。統一番号・キャリアは送信後に変更できませんのでご確認ください。",
  },
  invoicePersonal: { zh: "個人（含載具）", en: "Personal", ja: "個人（キャリア対応）" },
  invoiceCompany: {
    zh: "公司（統一編號）",
    en: "Company (business number)",
    ja: "法人（統一番号）",
  },
  invoiceDonate: { zh: "捐贈發票", en: "Donate the invoice", ja: "インボイスを寄付" },
  invoicePersonalNote: {
    zh: "不指定載具時，發票會由我們保管並以電子信箱寄送通知。",
    en: "With no carrier chosen, we hold the invoice for you and send the details by email.",
    ja: "キャリアを指定しない場合、インボイスは当店で保管し、内容をメールでお送りします。",
  },
  invoiceCompanyNote: {
    zh: "開立統編發票後就不會再有載具，這張發票會直接寄到你的電子信箱。",
    en: "A business-number invoice carries no mobile carrier; we email it to you directly.",
    ja: "統一番号ありのインボイスにキャリアは付きません。メールで直接お送りします。",
  },
  invoiceDonateNote: {
    zh: "捐贈之後這張發票就不屬於你了，無法再兌獎或折讓退回。",
    en: "Once donated, the invoice is no longer yours — it cannot be redeemed or returned.",
    ja: "寄付後のインボイスはお客様のものではなくなり、換金や返却はできません。",
  },
  carrierLabel: { zh: "載具類型", en: "Carrier", ja: "キャリアの種類" },
  carrierNone: {
    zh: "不指定（寄送電子信箱）",
    en: "None — email it to me",
    ja: "指定しない（メール送付）",
  },
  carrierMobile: { zh: "手機條碼", en: "Mobile barcode", ja: "携帯バーコード" },
  carrierNpc: { zh: "自然人憑證", en: "Citizen digital certificate", ja: "自然人証明書" },
  carrierNumber: { zh: "載具號碼", en: "Carrier number", ja: "キャリア番号" },
  taxId: { zh: "統一編號", en: "Business number", ja: "統一番号" },
  companyTitle: { zh: "公司抬頭（選填）", en: "Company name (optional)", ja: "会社名（任意）" },
  loveCode: { zh: "愛心碼", en: "Donation code", ja: "愛心コード" },
  loveCodeNote: {
    zh: "常見的愛心碼例如 25885（家扶基金會）、8585（伊甸社會福利基金會）。",
    en: "Common codes include 25885 (TFCF) and 8585 (Eden Social Welfare Foundation).",
    ja: "よく使われるコード：25885（家扶基金会）、8585（伊甸社会福祉基金会）。",
  },
  unavailableWarning: {
    zh: "購物車中有無法購買的品項，請先回到購物車移除。",
    en: "Your cart holds something that can no longer be bought. Please remove it in the cart first.",
    ja: "カートにご購入いただけない商品があります。カートで削除してからお進みください。",
  },
  backToCart: { zh: "回到購物車", en: "Back to cart", ja: "カートへ戻る" },
  catalogueDown: {
    zh: "商品資料暫時無法載入，請稍後再試。",
    en: "The catalogue is temporarily unavailable. Please try again shortly.",
    ja: "商品情報を読み込めませんでした。しばらくしてからお試しください。",
  },
};

const NO_ITEMS: CartLine[] = [];

export const Route = createFileRoute("/checkout/")({
  // Same read as /cart: the catalogue decides prices, purchase limits and —
  // uniquely here — whether anything in the cart needs posting at all.
  // paymentOptions is a single boolean read at request time, so adding the
  // PayUni keys to the deployment turns the card option on without a rebuild.
  loader: async () => ({
    catalogue: await fetchActiveProducts(),
    paymentOptions: await fetchPaymentOptions(),
  }),
  head: () => ({
    meta: [
      { title: PAGE.metaTitle.zh },
      { name: "description", content: PAGE.metaDescription.zh },
      { property: "og:title", content: PAGE.title.zh },
      { property: "og:description", content: PAGE.metaDescription.zh },
      // Carries a half-filled form and a live cart; never a search result.
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Checkout,
});

function Checkout() {
  const t = useT();
  const { lang } = useLang();
  const navigate = useNavigate();
  const { catalogue, paymentOptions } = Route.useLoaderData();
  const { ui } = useSiteContent();

  useDocumentMeta({
    title: PAGE.metaTitle,
    description: PAGE.metaDescription,
    ogTitle: PAGE.title,
  });

  const hydrated = useCartHydrated();
  const storedItems = useCart((s) => s.items);
  const syncFromCatalogue = useCart((s) => s.syncFromCatalogue);
  const items = hydrated ? storedItems : NO_ITEMS;

  const [submitting, setSubmitting] = useState(false);
  const [method, setMethod] = useState<OfferedShippingMethod>("home");

  // Card when it is available, otherwise the pre-gateway flow. Held outside
  // react-hook-form because it is not a validated field — it steers where the
  // browser goes next and has no bearing on what the order costs.
  const cardAvailable = paymentOptions.cardAvailable;
  const [payWith, setPayWith] = useState<"card" | "offline">(
    paymentOptions.cardAvailable ? "card" : "offline",
  );
  /**
   * Set once the PayUni form has been submitted; the page is navigating away.
   * Mirrored in a ref because the `finally` block runs in the same tick as the
   * setState and would otherwise still read the old value.
   */
  const [redirecting, setRedirecting] = useState(false);
  const redirectingRef = useRef(false);

  // One key per visit to this page. orders.idempotency_key is unique, so a
  // double-clicked submit (or a retried request) replays the first order
  // instead of reserving the stock a second time.
  const [idempotencyKey] = useState(() =>
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : "00000000-0000-4000-8000-000000000000",
  );

  useEffect(() => {
    if (!hydrated || catalogue.unavailable) return;
    syncFromCatalogue(catalogue.products);
  }, [hydrated, catalogue, syncFromCatalogue]);

  const buyable = useMemo(() => items.filter((i) => !i.unavailable), [items]);
  const hasUnavailable = items.length > buyable.length;

  /**
   * Whether anything in the cart has to be posted. Read from the live
   * catalogue rather than the cart line, because CartLine is a snapshot taken
   * at add-to-cart time and carries no requires_shipping field — and because
   * this has to agree with what the server independently decides from the same
   * column. A product that has vanished from the catalogue is treated as
   * shippable, which errs towards collecting an address we might not need
   * rather than silently waiving freight.
   */
  const needsShipping = useMemo(() => {
    const byId = new Map(catalogue.products.map((p) => [p.id, p]));
    return buyable.some((line) => byId.get(line.productId)?.requiresShipping ?? true);
  }, [buyable, catalogue.products]);

  const subtotal = useMemo(() => buyable.reduce((sum, l) => sum + l.price * l.qty, 0), [buyable]);
  const effectiveMethod = needsShipping ? method : "none";
  const shippingFee = computeShippingFee({ needsShipping, method: effectiveMethod, subtotal });
  const total = subtotal + shippingFee;
  const freeGap = amountToFreeShipping({ needsShipping, method: effectiveMethod, subtotal });

  const requireAddress = needsShipping && method === "home";

  /**
   * 每一行 booking 展開成 qty 個位子，攤平成一個有順序的清單。
   *
   * 這個順序就是表單欄位 `participants.<index>` 的順序，也是送出時分組回
   * items[].participants 的依據 —— 兩邊都從這一個陣列推導，所以不可能對不上。
   *
   * 排序固定成購物車的順序（buyable 本身的順序），不要換成 Map 迭代或 sort：
   * 順序一變，已經填好的欄位就會跳到別位參加者身上。
   */
  const participantSlots = useMemo(
    () =>
      buyable
        .filter((l) => l.productType === "event" || l.productType === "journey")
        .map((l) => ({ line: l, lineKey: keyOfLine(l), count: l.qty })),
    [buyable],
  );
  const totalParticipants = useMemo(
    () => participantSlots.reduce((sum, s) => sum + s.count, 0),
    [participantSlots],
  );

  const schema = useMemo(
    () =>
      checkoutFormSchemaWithParticipants({
        t,
        requireAddress,
        participantSlots: participantSlots.map((s) => ({ lineKey: s.lineKey, count: s.count })),
      }),
    [t, requireAddress, participantSlots],
  );

  const form = useForm<CheckoutFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      customerName: "",
      customerEmail: "",
      customerPhone: "",
      shippingMethod: "home",
      address: {
        recipient: "",
        phone: "",
        postalCode: "",
        city: "",
        district: "",
        street: "",
      },
      note: "",
      // 參加者由下面的 useEffect 依購物車補齊。這裡給空陣列而不是 undefined，
      // 因為 react-hook-form 要有一個穩定的初始形狀才綁得住 participants.N.*。
      participants: [],
      // 預設個人、無載具 —— 這是絕大多數客人的情況，也是不做任何選擇時最不會出錯的
      // 一種（發票開得出來、寄得到信箱、之後還能補登載具）。
      invoice: {
        type: "personal",
        taxId: "",
        companyTitle: "",
        carrierType: "",
        carrierNumber: "",
        loveCode: "",
      },
    },
  });

  /**
   * 讓 participants 陣列的長度與購物車一致。
   *
   * 購物車在這一頁是會變的（syncFromCatalogue 會把賣完的行 clamp 成 0），所以
   * 欄位數不能只在 mount 時算一次。已經填好的值**逐格保留** —— 用同一個
   * (lineKey, offset) 去對舊值，所以「某一行少了一個位子」不會把後面每一位的
   * 資料往前推一格。
   *
   * 只有在真的不一樣時才 setValue，否則這個 effect 會自己觸發自己。
   */
  useEffect(() => {
    const current = form.getValues("participants") ?? [];
    const byKey = new Map<string, CheckoutFormValues["participants"]>();
    for (const p of current) {
      const list = byKey.get(p.lineKey) ?? [];
      list.push(p);
      byKey.set(p.lineKey, list);
    }
    const next: NonNullable<CheckoutFormValues["participants"]> = [];
    for (const slot of participantSlots) {
      const old = byKey.get(slot.lineKey) ?? [];
      for (let i = 0; i < slot.count; i++) {
        next.push(
          old[i] ?? { lineKey: slot.lineKey, name: "", email: "", phone: "", noticeAck: false },
        );
      }
    }
    const same =
      next.length === current.length &&
      next.every((p, i) => p === current[i] || p.lineKey === current[i]?.lineKey);
    if (!same) form.setValue("participants", next, { shouldValidate: false });
  }, [participantSlots, form]);

  /**
   * 切換發票類型時，把另外兩種的欄位清空。
   *
   * 不清空的話，一個先填了統編、又改選捐贈的客人，會把統編一起送上來。伺服器端的
   * normalizeInvoiceChoice() 本來就會丟掉不屬於該類型的欄位，所以那不會開錯發票 ——
   * 但那些值仍然會離開瀏覽器，而「使用者已經在畫面上取消的輸入不應該被送出」是一條
   * 值得自己遵守的規矩，尤其這裡是統一編號。
   */
  const invoiceType = form.watch("invoice.type") ?? "personal";
  function selectInvoiceType(next: "personal" | "company" | "donate") {
    form.setValue("invoice.type", next, { shouldValidate: false });
    if (next !== "company") {
      form.setValue("invoice.taxId", "");
      form.setValue("invoice.companyTitle", "");
    }
    if (next !== "personal") {
      form.setValue("invoice.carrierType", "");
      form.setValue("invoice.carrierNumber", "");
    }
    if (next !== "donate") form.setValue("invoice.loveCode", "");
    form.clearErrors("invoice");
  }

  async function onSubmit(values: CheckoutFormValues) {
    if (buyable.length === 0) return;
    if (hasUnavailable) {
      toast.error(t(PAGE.unavailableWarning));
      return;
    }

    setSubmitting(true);
    try {
      const result = await placeOrder({
        data: {
          ...values,
          shippingMethod: effectiveMethod,
          // Only what, which sitting, how many, and who is coming. Prices,
          // names and totals are still the server's to decide — see
          // src/lib/checkout-fns.ts.
          //
          // 參加者從攤平的表單陣列依 lineKey 分組回每一行。分組的來源與
          // participantSlots 是同一個 keyOfLine()，所以不會有「填在 A 行、送到
          // B 行」的可能。伺服器仍然自己驗一次筆數，最後由
          // reserve_session_seat() 的第 ① 步在同一個交易裡拍板。
          items: buyable.map((l) => {
            const key = keyOfLine(l);
            const people = (values.participants ?? []).filter((p) => p.lineKey === key);
            return {
              productId: l.productId,
              quantity: l.qty,
              sessionId: l.sessionId,
              participants:
                l.productType === "event" || l.productType === "journey"
                  ? people.map((p) => ({
                      name: p.name,
                      email: p.email ?? null,
                      phone: p.phone ?? null,
                      noticeAck: p.noticeAck === true,
                    }))
                  : undefined,
            };
          }),
          address: requireAddress ? values.address : null,
          locale: lang,
          idempotencyKey,
          // Steers the next hop only. The amount PayUni is asked for is
          // recomputed server-side from public.products; nothing in this
          // payload can change it.
          paymentMethod: cardAvailable ? payWith : "offline",
        },
      });

      if (!result.ok) {
        toast.error(checkoutErrorText(result.code, lang));
        return;
      }

      // The cart is NOT cleared here, and not on arrival at the confirmation
      // page either — only once payment is settled. Clearing it now would send
      // anyone whose card is declined back to an empty cart with an unpaid
      // order they cannot retry, which is the exact bug Realreal shipped.
      if (result.payment) {
        // Navigating away: keep the button disabled and say what is happening,
        // because the browser will sit on this page for a beat before PayUni's
        // page paints. Deliberately no `finally` reset — see below.
        redirectingRef.current = true;
        setRedirecting(true);
        submitPaymentForm(result.payment);
        return;
      }

      await navigate({ to: "/checkout/complete", search: { token: result.publicToken } });
    } catch (err) {
      toast.error(checkoutErrorText(err, lang));
    } finally {
      // Leaves `submitting` true on the PayUni path on purpose: the form has
      // been submitted and the page is on its way out, so re-enabling the
      // button would only invite a second order.
      if (!redirectingRef.current) setSubmitting(false);
    }
  }

  if (hydrated && buyable.length === 0) {
    return (
      <PageShell>
        <PageHeader eyebrow={`Checkout  ／  ${t(PAGE.eyebrowSuffix)}`} title={t(PAGE.title)} />
        <section className="container-editorial pb-32">
          <div className="border border-border p-10">
            <p className="text-sm text-muted-foreground">{t(PAGE.empty)}</p>
            <Link
              to="/shop"
              className="mt-8 inline-block border border-foreground px-5 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
            >
              {t(ui.buttons.continueShopping)}
            </Link>
          </div>
        </section>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        eyebrow={`Checkout  ／  ${t(PAGE.eyebrowSuffix)}`}
        title={t(PAGE.title)}
        intro={t(PAGE.intro)}
      />

      <section className="container-editorial pb-32 grid gap-12 lg:grid-cols-3 lg:gap-16">
        <div className="lg:col-span-2">
          {catalogue.unavailable && (
            <p className="mb-8 border border-clay p-5 text-sm text-clay">{t(PAGE.catalogueDown)}</p>
          )}
          {hasUnavailable && (
            <p className="mb-8 border border-clay p-5 text-sm text-clay">
              {t(PAGE.unavailableWarning)}{" "}
              <Link to="/cart" className="underline underline-offset-4">
                {t(PAGE.backToCart)}
              </Link>
            </p>
          )}

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-12">
              <fieldset className="space-y-5">
                <legend className="eyebrow text-xl">{t(PAGE.contactSection)}</legend>
                <FormField
                  control={form.control}
                  name="customerName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t(PAGE.name)}</FormLabel>
                      <FormControl>
                        <Input autoComplete="name" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="customerEmail"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t(PAGE.email)}</FormLabel>
                      <FormControl>
                        <Input type="email" inputMode="email" autoComplete="email" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="customerPhone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t(PAGE.phone)}</FormLabel>
                      <FormControl>
                        <Input
                          inputMode="tel"
                          autoComplete="tel"
                          placeholder="09xxxxxxxx"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </fieldset>

              {/* 參加者放在聯絡資料之後、寄送之前：填的順序與客人腦中的順序一致
                  （先是「我是誰」，再是「誰要來」，最後才是「寄到哪」）。
                  全是書的購物車不會渲染這一段，連標題都不會出現。 */}
              {participantSlots.length > 0 ? (
                <fieldset className="space-y-5">
                  <legend className="eyebrow text-xl">{t(PAGE.participantsSection)}</legend>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {t(PAGE.participantsIntro)}
                  </p>
                  {participantSlots.map((slot, idx) => (
                    <ParticipantFields
                      key={slot.lineKey}
                      lineTitle={slot.line.title}
                      sessionTitle={slot.line.sessionTitle}
                      startIndex={participantSlots
                        .slice(0, idx)
                        .reduce((sum, s) => sum + s.count, 0)}
                      count={slot.count}
                    />
                  ))}
                </fieldset>
              ) : null}

              {needsShipping ? (
                <>
                  <fieldset className="space-y-4">
                    <legend className="eyebrow text-xl">{t(PAGE.shippingSection)}</legend>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(["home", "pickup"] as const).map((m) => {
                        const rule = SHIPPING_RULES[m];
                        const selected = method === m;
                        return (
                          <label
                            key={m}
                            className={`flex cursor-pointer items-baseline justify-between gap-4 border p-4 transition-colors ${
                              selected
                                ? "border-foreground"
                                : "border-border hover:border-foreground/40"
                            }`}
                          >
                            <span className="flex items-baseline gap-3">
                              <input
                                type="radio"
                                name="shippingMethod"
                                value={m}
                                checked={selected}
                                onChange={() => setMethod(m)}
                                className="accent-current"
                              />
                              <span className="text-sm">
                                {m === "home" ? t(PAGE.methodHome) : t(PAGE.methodPickup)}
                              </span>
                            </span>
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {rule.fee === 0 ? t(PAGE.methodFree) : formatPrice(rule.fee)}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {method === "pickup" && (
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {t(PAGE.pickupNote)}
                      </p>
                    )}
                  </fieldset>

                  {requireAddress && (
                    <fieldset className="space-y-5">
                      <legend className="eyebrow text-xl">{t(PAGE.addressSection)}</legend>
                      <div className="grid gap-5 sm:grid-cols-2">
                        <FormField
                          control={form.control}
                          name="address.recipient"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t(PAGE.recipient)}</FormLabel>
                              <FormControl>
                                <Input
                                  autoComplete="shipping name"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="address.phone"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t(PAGE.recipientPhone)}</FormLabel>
                              <FormControl>
                                <Input
                                  inputMode="tel"
                                  autoComplete="shipping tel"
                                  placeholder="09xxxxxxxx"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="address.postalCode"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t(PAGE.postalCode)}</FormLabel>
                              <FormControl>
                                <Input
                                  inputMode="numeric"
                                  autoComplete="shipping postal-code"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="address.city"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t(PAGE.city)}</FormLabel>
                              <FormControl>
                                <Input
                                  autoComplete="shipping address-level1"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="address.district"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>{t(PAGE.district)}</FormLabel>
                              <FormControl>
                                <Input
                                  autoComplete="shipping address-level2"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="address.street"
                          render={({ field }) => (
                            <FormItem className="sm:col-span-2">
                              <FormLabel>{t(PAGE.street)}</FormLabel>
                              <FormControl>
                                <Input
                                  autoComplete="shipping street-address"
                                  {...field}
                                  value={field.value ?? ""}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </fieldset>
                  )}
                </>
              ) : (
                <p className="border border-border p-5 text-sm leading-relaxed text-muted-foreground">
                  {t(PAGE.noShippingNeeded)}
                </p>
              )}

              <fieldset className="space-y-4">
                <legend className="eyebrow text-xl">{t(PAGE.paymentSection)}</legend>
                {cardAvailable ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(["card", "offline"] as const).map((p) => {
                      const selected = payWith === p;
                      return (
                        <label
                          key={p}
                          className={`flex cursor-pointer items-baseline gap-3 border p-4 transition-colors ${
                            selected
                              ? "border-foreground"
                              : "border-border hover:border-foreground/40"
                          }`}
                        >
                          <input
                            type="radio"
                            name="paymentMethod"
                            value={p}
                            checked={selected}
                            onChange={() => setPayWith(p)}
                            className="accent-current"
                          />
                          <span className="text-sm">
                            {p === "card" ? t(PAGE.payCard) : t(PAGE.payOffline)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : (
                  <p className="border border-border p-5 text-sm leading-relaxed text-muted-foreground">
                    {t(PAGE.paymentUnavailable)}
                  </p>
                )}
                {cardAvailable && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {payWith === "card" ? t(PAGE.payCardNote) : t(PAGE.payOfflineNote)}
                  </p>
                )}
              </fieldset>

              {/*
                電子發票。三選一，預設個人。
                ⚠️ 這一整段不影響訂單金額：送出的欄位只有開法、統編、載具與愛心碼，
                金額由伺服器從 public.products 重算（見 src/lib/checkout.ts）。
              */}
              <fieldset className="space-y-4">
                <legend className="eyebrow text-xl">{t(PAGE.invoiceSection)}</legend>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {t(PAGE.invoiceIntro)}
                </p>
                <div className="grid gap-3 sm:grid-cols-3">
                  {(["personal", "company", "donate"] as const).map((kind) => {
                    const selected = invoiceType === kind;
                    return (
                      <label
                        key={kind}
                        className={`flex cursor-pointer items-baseline gap-3 border p-4 transition-colors ${
                          selected
                            ? "border-foreground"
                            : "border-border hover:border-foreground/40"
                        }`}
                      >
                        <input
                          type="radio"
                          name="invoiceType"
                          value={kind}
                          checked={selected}
                          onChange={() => selectInvoiceType(kind)}
                          className="accent-current"
                        />
                        <span className="text-sm">
                          {kind === "personal"
                            ? t(PAGE.invoicePersonal)
                            : kind === "company"
                              ? t(PAGE.invoiceCompany)
                              : t(PAGE.invoiceDonate)}
                        </span>
                      </label>
                    );
                  })}
                </div>

                {invoiceType === "personal" && (
                  <div className="grid gap-5 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="invoice.carrierType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t(PAGE.carrierLabel)}</FormLabel>
                          <FormControl>
                            <select
                              {...field}
                              value={field.value ?? ""}
                              onChange={(e) => {
                                field.onChange(e);
                                // 換載具類型時舊號碼一定不合新格式，留著只會讓客人看到
                                // 一則指著他沒改過的欄位的錯誤。
                                form.setValue("invoice.carrierNumber", "");
                                form.clearErrors("invoice.carrierNumber");
                              }}
                              className="h-9 w-full border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none md:text-sm"
                            >
                              <option value="">{t(PAGE.carrierNone)}</option>
                              <option value="3J0002">{t(PAGE.carrierMobile)}</option>
                              <option value="CQ0001">{t(PAGE.carrierNpc)}</option>
                            </select>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {(form.watch("invoice.carrierType") ?? "") !== "" && (
                      <FormField
                        control={form.control}
                        name="invoice.carrierNumber"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t(PAGE.carrierNumber)}</FormLabel>
                            <FormControl>
                              <Input
                                autoComplete="off"
                                placeholder={
                                  form.watch("invoice.carrierType") === "3J0002"
                                    ? "/ABC+123"
                                    : "AB12345678901234"
                                }
                                {...field}
                                value={field.value ?? ""}
                                onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}
                    <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">
                      {t(PAGE.invoicePersonalNote)}
                    </p>
                  </div>
                )}

                {invoiceType === "company" && (
                  <div className="grid gap-5 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="invoice.taxId"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t(PAGE.taxId)}</FormLabel>
                          <FormControl>
                            <Input
                              inputMode="numeric"
                              autoComplete="off"
                              maxLength={8}
                              placeholder="12345675"
                              {...field}
                              value={field.value ?? ""}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="invoice.companyTitle"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t(PAGE.companyTitle)}</FormLabel>
                          <FormControl>
                            <Input
                              autoComplete="organization"
                              {...field}
                              value={field.value ?? ""}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">
                      {t(PAGE.invoiceCompanyNote)}
                    </p>
                  </div>
                )}

                {invoiceType === "donate" && (
                  <div className="grid gap-5 sm:grid-cols-2">
                    <FormField
                      control={form.control}
                      name="invoice.loveCode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>{t(PAGE.loveCode)}</FormLabel>
                          <FormControl>
                            <Input
                              inputMode="numeric"
                              autoComplete="off"
                              maxLength={7}
                              placeholder="25885"
                              {...field}
                              value={field.value ?? ""}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-2">
                      {t(PAGE.loveCodeNote)} {t(PAGE.invoiceDonateNote)}
                    </p>
                  </div>
                )}
              </fieldset>

              <fieldset className="space-y-5">
                <legend className="eyebrow text-xl">{t(PAGE.noteSection)}</legend>
                <FormField
                  control={form.control}
                  name="note"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t(PAGE.note)}</FormLabel>
                      <FormControl>
                        <Textarea rows={4} maxLength={500} {...field} value={field.value ?? ""} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </fieldset>

              <div className="space-y-3">
                <Button
                  type="submit"
                  className="w-full sm:w-auto"
                  disabled={submitting || redirecting || hasUnavailable || buyable.length === 0}
                >
                  {redirecting
                    ? t(PAGE.redirecting)
                    : submitting
                      ? t(PAGE.submitting)
                      : cardAvailable && payWith === "card"
                        ? t(PAGE.submitPay)
                        : t(PAGE.submit)}
                </Button>
                {redirecting && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t(PAGE.redirecting)}
                  </p>
                )}
              </div>
            </form>
          </Form>
        </div>

        <aside className="lg:col-span-1">
          <div className="border border-border p-7 md:p-8 lg:sticky lg:top-28">
            <p className="eyebrow text-xl">{t(PAGE.summary)}</p>

            <ul className="mt-6 space-y-4 border-b border-border pb-6">
              {buyable.map((line) => (
                <li key={keyOfLine(line)} className="flex justify-between gap-4 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{t(line.title)}</span>
                    {line.sessionTitle ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {t(line.sessionTitle)}
                      </span>
                    ) : null}
                    <span className="text-xs text-muted-foreground">× {line.qty}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatPrice(line.price * line.qty)}
                  </span>
                </li>
              ))}
            </ul>

            <dl className="mt-6 space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t(PAGE.subtotal)}</dt>
                <dd className="tabular-nums">{formatPrice(subtotal)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{t(PAGE.shipping)}</dt>
                <dd className="tabular-nums">
                  {shippingFee === 0 ? t(PAGE.methodFree) : formatPrice(shippingFee)}
                </dd>
              </div>
            </dl>

            {freeGap !== null && (
              <p className="mt-4 text-xs text-muted-foreground">
                {t(PAGE.freeShippingGap)} {formatPrice(freeGap)} {t(PAGE.freeShippingGapTail)}
              </p>
            )}

            <div className="rule my-6" />

            <div className="flex items-baseline justify-between gap-4">
              <span className="eyebrow text-xl">{t(PAGE.total)}</span>
              <span className="font-serif text-2xl tabular-nums">{formatPrice(total)}</span>
            </div>

            <Link
              to="/cart"
              className="mt-7 inline-block border border-foreground px-5 py-3 text-xs tracking-widest transition-colors hover:bg-foreground hover:text-primary-foreground"
            >
              {t(PAGE.backToCart)}
            </Link>
          </div>
        </aside>
      </section>
    </PageShell>
  );
}

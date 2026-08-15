/**
 * /admin/pos —— 櫃檯結帳
 *
 * ── 這一頁是「門市 × 網站扣同一個數字」真的被人用到的地方 ──────────────────
 * 0011 讓網站下單走 public.stock_reservations 保留、付款成功寫一列
 * inv.sales(channel='online')。這一頁做的是同一件事的另一半：櫃檯賣一本，寫一列
 * inv.sales(channel='pos')，扣的是同一個 inv.products.stock_quantity。
 *
 * 兩條路徑的交會點在 inv.update_stock_on_sale() 那個 trigger 上，不在這個檔案裡。
 * 這一頁只負責把店員的意圖翻成一次 pos_checkout() 呼叫。
 *
 * ── 為什麼拆成四個元件而不是一個巨檔 ──────────────────────────────────────
 * 來源的 QuickSaleScanner.tsx 是 2,135 行、一個檔案裡有 30 個 useState。搬進
 * TanStack Router 之後沒有人維護得動，而且那個檔案的四塊職責（掃碼、清單、結帳、
 * 搜尋）彼此其實只透過「購物車」這一個狀態溝通。所以購物車留在這裡，四塊各自
 * 出去 —— components/pos/ 底下每一個檔案都在 250 行以內。
 *
 * ── 沒有搬過來的東西（Phase 4 交接）──────────────────────────────────────
 * · AI 拍照辨識（來源 QuickSaleScanner 的 recognize-book edge function）——
 *   這個專案沒有那支 edge function，硬搬會是一顆永遠 500 的按鈕。
 * · 套餐（combo_sets）與二手書入帳 —— inv.sales 的欄位都在（combo_set_id /
 *   combo_sale_group / is_secondhand），pos_checkout() 也留得下擴充空間，
 *   但它們各自有一套定價規則，這一期先把單品這條路走通。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { CheckCircle2, ScanLine, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CartPanel, type CartLine } from "@/components/pos/CartPanel";
import { CheckoutPanel } from "@/components/pos/CheckoutPanel";
import { ProductLookup } from "@/components/pos/ProductLookup";
import { ScannerInput } from "@/components/pos/ScannerInput";
import type { PosProduct } from "@/server/repos/inv-sales";

export const Route = createFileRoute("/admin/_shell/pos")({
  loader: async () => {
    const { listPosProducts, listPosPaymentMethods } = await import("@/lib/admin/fns/pos");
    // 兩支都是 staffFnMiddleware 守的。店員進得來、customer 進不來，而且擋人的
    // 是 middleware 重讀 profiles 那一下，不是側欄。
    const [products, paymentMethods] = await Promise.all([
      listPosProducts(),
      listPosPaymentMethods(),
    ]);
    return { products, paymentMethods };
  },
  head: () => ({ meta: [{ title: "櫃檯結帳｜小時光書店後台" }] }),
  component: PosPage,
});

function todayInTaipei() {
  // 門市的「今天」是台北的今天，不是伺服器的今天。sale_date 是 date 不是
  // timestamptz，所以這裡不能用 toISOString()（那是 UTC，晚上 8 點後會差一天）。
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

function PosPage() {
  const { products, paymentMethods } = Route.useLoaderData();
  const router = useRouter();

  const [lines, setLines] = useState<CartLine[]>([]);
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(
    paymentMethods.find((m) => m.is_default)?.payment_method_id ??
      paymentMethods[0]?.payment_method_id ??
      null,
  );
  const [notes, setNotes] = useState("");
  const [override, setOverride] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [lastReceipt, setLastReceipt] = useState<{
    amount: number;
    count: number;
    oversold: { product_name: string; shortfall: number }[];
  } | null>(null);

  /** 條碼 → 商品。993 筆建一次 Map，掃碼就是 O(1)，不用每次掃描都線性找。 */
  const byBarcode = useMemo(() => {
    const map = new Map<string, PosProduct>();
    for (const p of products) if (p.barcode) map.set(p.barcode.trim(), p);
    return map;
  }, [products]);

  const inCart = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of lines) counts[l.product.inv_product_id] = l.quantity;
    return counts;
  }, [lines]);

  const addProduct = useCallback((product: PosProduct) => {
    setNotFound(null);
    setLines((current) => {
      const existing = current.find((l) => l.product.inv_product_id === product.inv_product_id);
      if (existing) {
        return current.map((l) =>
          l.product.inv_product_id === product.inv_product_id
            ? { ...l, quantity: l.quantity + 1 }
            : l,
        );
      }
      return [
        ...current,
        { product, quantity: 1, unitPrice: Number(product.selling_price ?? 0) },
      ];
    });
  }, []);

  // 掃碼查詢中的 in-flight guard：掃描槍會連發，不要讓同一個條碼打出兩次請求。
  const lookupRef = useRef(false);

  const handleBarcode = useCallback(
    async (barcode: string) => {
      const code = barcode.trim();
      const hit = byBarcode.get(code);
      if (hit) {
        addProduct(hit);
        return;
      }

      // 快取裡沒有 → 可能是剛在進銷存那邊建的新品項。去伺服器問一次，不要叫
      // 店員重整頁面。
      if (lookupRef.current) return;
      lookupRef.current = true;
      try {
        const { findPosProductByBarcode } = await import("@/lib/admin/fns/pos");
        const found = await findPosProductByBarcode({ data: { barcode: code } });
        if (found) {
          addProduct(found as PosProduct);
        } else {
          setNotFound(`條碼「${code}」找不到對應商品。請用下面的搜尋框找，或先去進銷存建立品項。`);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "條碼查詢失敗");
      } finally {
        lookupRef.current = false;
      }
    },
    [addProduct, byBarcode],
  );

  function changeQuantity(id: string, quantity: number) {
    if (quantity < 1) return;
    setLines((current) =>
      current.map((l) => (l.product.inv_product_id === id ? { ...l, quantity } : l)),
    );
  }

  function changePrice(id: string, unitPrice: number) {
    if (unitPrice < 0 || !Number.isFinite(unitPrice)) return;
    setLines((current) =>
      current.map((l) => (l.product.inv_product_id === id ? { ...l, unitPrice } : l)),
    );
  }

  function removeLine(id: string) {
    setLines((current) => current.filter((l) => l.product.inv_product_id !== id));
  }

  function clearCart() {
    setLines([]);
    setOverride(false);
    setNotes("");
    setNotFound(null);
  }

  async function handleCheckout() {
    setSubmitting(true);
    try {
      const { posCheckout } = await import("@/lib/admin/fns/pos");
      const result = await posCheckout({
        data: {
          items: lines.map((l) => ({
            inv_product_id: l.product.inv_product_id,
            quantity: l.quantity,
            unit_price: l.unitPrice,
          })),
          payment_method_id: paymentMethodId,
          sale_date: todayInTaipei(),
          notes: notes.trim() || null,
          override_reservation: override,
        },
      });

      setLastReceipt({
        amount: Number(result.total_amount),
        count: lines.reduce((n, l) => n + l.quantity, 0),
        oversold: result.oversold ?? [],
      });

      if ((result.oversold ?? []).length > 0) {
        toast.warning("已結帳，但這一筆賣超了 —— 已記進賣超告警");
      } else {
        toast.success("已結帳");
      }

      clearCart();
      // 這個 repo 沒有 react-query。重新載入 loader 就是「重新抓一次庫存」，
      // 所以下一位客人看到的可售量是剛剛扣完的數字。
      await router.invalidate();
    } catch (err) {
      // 庫存不足的訊息是 pos_checkout() 寫給店員看的整句中文，原樣顯示。
      toast.error(err instanceof Error ? err.message : "結帳失敗，請再試一次");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <ScanLine className="h-5 w-5" aria-hidden="true" />
          櫃檯結帳
        </h1>
        <Badge variant="secondary" className="font-normal">
          門市銷售會寫進 inv.sales（channel=pos），與網站扣同一份庫存
        </Badge>
      </div>

      {lastReceipt ? (
        <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
          <p className="flex items-center gap-1.5 font-medium">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
            上一筆：{lastReceipt.count} 件，NT$ {lastReceipt.amount.toLocaleString("zh-TW")}
          </p>
          {lastReceipt.oversold.length > 0 ? (
            <p className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>
                強制放行：
                {lastReceipt.oversold
                  .map((o) => `「${o.product_name}」差 ${o.shortfall} 件`)
                  .join("、")}
                。已記進「賣超告警」，請找時間盤點。
              </span>
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">加入商品</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ScannerInput onBarcode={handleBarcode} notFound={notFound} disabled={submitting} />
              <Separator />
              <ProductLookup products={products} onPick={addProduct} inCart={inCart} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">
                銷售清單{lines.length > 0 ? `（${lines.length} 項）` : ""}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <CartPanel
                lines={lines}
                onQuantityChange={changeQuantity}
                onPriceChange={changePrice}
                onRemove={removeLine}
                disabled={submitting}
              />
            </CardContent>
          </Card>
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          <CheckoutPanel
            lines={lines}
            paymentMethods={paymentMethods}
            paymentMethodId={paymentMethodId}
            onPaymentMethodChange={setPaymentMethodId}
            notes={notes}
            onNotesChange={setNotes}
            override={override}
            onOverrideChange={setOverride}
            onSubmit={handleCheckout}
            submitting={submitting}
            onClear={clearCart}
          />
        </div>
      </div>
    </div>
  );
}

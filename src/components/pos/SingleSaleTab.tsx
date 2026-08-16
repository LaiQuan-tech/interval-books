/**
 * 單品結帳 —— 掃碼／搜尋 → 購物車 → 結帳。
 *
 * ── 為什麼從 _shell.pos.tsx 搬出來 ────────────────────────────────────────
 * 櫃檯現在有三條結帳路徑（單品／套餐／二手書），每一條都有自己的一整包狀態。
 * 三包擠在同一個 function 裡就是來源 QuickSaleScanner.tsx 那 2,135 行的第一步。
 * 購物車這一包只有這條路徑用得到，所以跟著這條路徑走。
 *
 * 這個檔案裡沒有任何金額或庫存的判斷會影響資料庫寫入 —— unit_price 是店員在
 * 購物車上改的成交價，其餘（amount、cost_price）全部由 pos_checkout() 與
 * FIFO trigger 在資料庫算。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { CartPanel, type CartLine } from "@/components/pos/CartPanel";
import { CheckoutPanel } from "@/components/pos/CheckoutPanel";
import { ProductLookup } from "@/components/pos/ProductLookup";
import { ScannerInput } from "@/components/pos/ScannerInput";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import type { PosPaymentMethod, PosProduct } from "@/server/repos/inv-sales";

type Props = {
  products: PosProduct[];
  paymentMethods: PosPaymentMethod[];
  /** 預設付款方式。由 _shell.pos.tsx 算好，三條路徑共用同一個預設值。 */
  defaultPaymentMethodId: string | null;
};

export function SingleSaleTab({ products, paymentMethods, defaultPaymentMethodId }: Props) {
  const router = useRouter();

  const [lines, setLines] = useState<CartLine[]>([]);
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(defaultPaymentMethodId);
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
      return [...current, { product, quantity: 1, unitPrice: Number(product.selling_price ?? 0) }];
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
    <div className="space-y-4">
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

/**
 * 套餐結帳 —— 選一組、選幾份、結帳，然後把分攤結果攤開給人看。
 *
 * ── 這一頁不算錢 ──────────────────────────────────────────────────────────
 * 組合價怎麼分攤到組成品項，整段在 inv.allocate_combo_amounts()／
 * inv_combo_checkout() 裡。來源系統是在瀏覽器裡算的（`isFirstItem ? price : 0`），
 * 所以改一個 request body 就能決定哪一件商品拿到全部營收 —— 那正是寄賣廠商的
 * 拆帳基礎。見 0018 檔頭問題一。
 *
 * ── 為什麼還要在前端篩一次「上架 + 已審核」 ──────────────────────────────
 * 不是為了安全（inv_combo_checkout() 會擋停用、未審核、沒有組成品項、組成品項
 * 停用的套餐，而且擋的是資料庫不是這裡）。是為了不要在櫃檯畫一顆按下去必定
 * 跳錯誤的按鈕。
 */
import { useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { PackageOpen } from "lucide-react";
import { toast } from "sonner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ComboCard } from "@/components/pos/ComboCard";
import { ComboCheckoutPanel } from "@/components/pos/ComboCheckoutPanel";
import { ComboResultPanel } from "@/components/pos/ComboResultPanel";
import { todayInTaipei } from "@/lib/admin/inv-product-utils";
import { comboCheckoutSchema } from "@/lib/admin/schemas";
import type { PosPaymentMethod } from "@/server/repos/inv-sales";
import type {
  AdminComboItemRow,
  AdminComboSetRow,
  ComboCheckoutResult,
} from "@/server/repos/inv-combos";

type Props = {
  comboSets: AdminComboSetRow[];
  comboItems: AdminComboItemRow[];
  paymentMethods: PosPaymentMethod[];
  defaultPaymentMethodId: string | null;
};

export function ComboCheckoutTab({
  comboSets,
  comboItems,
  paymentMethods,
  defaultPaymentMethodId,
}: Props) {
  const router = useRouter();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sets, setSets] = useState(1);
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(defaultPaymentMethodId);
  const [notes, setNotes] = useState("");
  const [override, setOverride] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ComboCheckoutResult | null>(null);

  /** 只留賣得動的。停用或未審核的套餐在櫃檯根本不該出現。 */
  const sellable = useMemo(
    () => comboSets.filter((s) => s.is_active && s.approval_status === "approved"),
    [comboSets],
  );

  /** combo_set_id → 組成品項。一次建好，不要每張卡都掃一次整包 items。 */
  const itemsBySet = useMemo(() => {
    const map = new Map<string, AdminComboItemRow[]>();
    for (const item of comboItems) {
      const list = map.get(item.combo_set_id);
      if (list) list.push(item);
      else map.set(item.combo_set_id, [item]);
    }
    return map;
  }, [comboItems]);

  const selected = sellable.find((s) => s.combo_set_id === selectedId) ?? null;

  function pick(id: string) {
    setSelectedId(id);
    setSets(1);
    setOverride(false);
  }

  async function handleCheckout() {
    if (!selected) return;

    // ⚠️ payload 裡**沒有** amount、unit_price、cost_price、approval_status。
    //    分攤金額、FIFO 成本、審核狀態全部是資料庫算的；從瀏覽器送進來等於讓
    //    櫃檯自己決定寄賣廠商拿多少。
    const parsed = comboCheckoutSchema.safeParse({
      combo_set_id: selected.combo_set_id,
      quantity: sets,
      // 門市的「今天」是台北的今天，不是伺服器的今天。
      sale_date: todayInTaipei(),
      payment_method_id: paymentMethodId,
      notes: notes.trim() === "" ? null : notes,
      override_reservation: override,
    });
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "請檢查填寫的內容");
      return;
    }

    setSubmitting(true);
    try {
      const { comboCheckout } = await import("@/lib/admin/fns/inv-combos");
      const outcome = await comboCheckout({ data: parsed.data });
      setResult(outcome as ComboCheckoutResult);

      if (override) {
        toast.warning("已結帳，但這一單賣超了 —— 已記進賣超告警");
      } else {
        toast.success(`已賣出「${outcome.combo_name}」${outcome.sets} 份`);
      }

      setSets(1);
      setOverride(false);
      setNotes("");
      // 這個 repo 沒有 react-query。重跑 loader 就是重新抓一次庫存，所以下一位
      // 客人看到的「還能組幾份」是剛剛扣完的數字。
      await router.invalidate();
    } catch (err) {
      // inv_combo_checkout() 丟的是寫給店員看的整句中文，原樣顯示。
      toast.error(err instanceof Error ? err.message : "套餐結帳失敗，請再試一次");
    } finally {
      setSubmitting(false);
    }
  }

  if (sellable.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border">
        <PackageOpen className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">目前沒有可販售的套餐</p>
        <p className="text-xs text-muted-foreground">套餐要「上架」而且「已審核」才會出現在櫃檯</p>
      </div>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <ScrollArea className="h-[34rem] rounded-md border border-border">
        <ul className="space-y-2 p-2">
          {sellable.map((set) => (
            <ComboCard
              key={set.combo_set_id}
              set={set}
              items={itemsBySet.get(set.combo_set_id) ?? []}
              selected={set.combo_set_id === selectedId}
              onSelect={() => pick(set.combo_set_id)}
              disabled={submitting}
            />
          ))}
        </ul>
      </ScrollArea>

      <div className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <ComboCheckoutPanel
          set={selected}
          sets={sets}
          onSetsChange={setSets}
          paymentMethods={paymentMethods}
          paymentMethodId={paymentMethodId}
          onPaymentMethodChange={setPaymentMethodId}
          notes={notes}
          onNotesChange={setNotes}
          override={override}
          onOverrideChange={setOverride}
          onSubmit={handleCheckout}
          submitting={submitting}
        />

        {result ? (
          <ComboResultPanel result={result} items={itemsBySet.get(result.combo_set_id) ?? []} />
        ) : null}
      </div>
    </div>
  );
}

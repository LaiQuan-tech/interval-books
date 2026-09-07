/**
 * 方案（票種）選擇器：一個場次底下的多個價格方案，額滿或不在販售期間的那幾張
 * 不能點（0036）。
 *
 * 從 SessionPicker.tsx 照抄的形狀，理由也一樣：events.$slug.tsx 的「我要報名」
 * 與 shop.$slug.tsx 的「加入購物車」都要用同一個選擇器——這是後者上線之後才發現
 * 的第二個入口（見 direct-checkout.ts 檔頭），如果各自畫一份，「同一個方案在
 * 商品頁與活動頁顯示不同的剩餘」這個 bug 遲早會發生。
 *
 * 這裡**不持有選中的是哪一個方案**，跟 SessionPicker 同一個理由：選中的方案同時
 * 決定了數量上限（呼叫端要用 directSeatLimit()／cartInputFor() 重新問一次），
 * 藏進元件裡外面就得再想辦法問回來。
 *
 * 「還剩幾單位」「還在不在販售期間」一律走 src/lib/shop.ts 的
 * remainingForPlan() / planInSaleWindow()，不在這裡自己算——理由與
 * SessionPicker 對 remainingForSession() 的態度相同。
 *
 * showSeatsRemaining 沿用場次層級的同一個旗標（不是方案自己的一個新開關）——
 * 這是核准的設計就講明的：不要為方案另開一個顯示開關，跟場次共用一份決定。
 */
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { isPlanAvailable, planInSaleWindow, remainingForPlan, type ShopPlan } from "@/lib/shop";
import { PriceTag } from "@/components/shop/ShopBits";
import { SEATS_LEFT_LABEL } from "@/components/shop/labels";

const COPY: Record<"choosePlan" | "planFull" | "planNotYet" | "planEnded" | "perUnit", Localized> =
  {
    choosePlan: { zh: "選擇方案", en: "Choose a plan", ja: "プランを選ぶ" },
    planFull: { zh: "已額滿", en: "Full", ja: "満席" },
    planNotYet: { zh: "尚未開賣", en: "Not on sale yet", ja: "販売開始前" },
    planEnded: { zh: "已截止", en: "Sales ended", ja: "販売終了" },
    perUnit: { zh: "每單位", en: "per unit", ja: "1単位あたり" },
  };

export function PlanPicker({
  plans,
  selectedId,
  onSelect,
  showSeatsRemaining,
}: {
  plans: ShopPlan[];
  /** 目前選中的方案 id，還沒選就是 null。 */
  selectedId: string | null;
  onSelect: (planId: string) => void;
  /**
   * 這場活動要不要印「尚餘 N」（沿用 products.show_seats_remaining，同
   * SessionPicker）。**必填、沒有預設值**——理由見 SessionPicker 檔頭。
   */
  showSeatsRemaining: boolean;
}) {
  const t = useT();

  if (plans.length === 0) return null;

  return (
    <fieldset className="mb-8 space-y-3">
      <legend className="eyebrow text-xl">{t(COPY.choosePlan)}</legend>
      {plans.map((plan) => {
        const left = remainingForPlan(plan);
        const full = left <= 0;
        const inWindow = planInSaleWindow(plan);
        const available = isPlanAvailable(plan);
        const selected = plan.id === selectedId;
        // 額滿優先，接著是販售期間，旗標只管「還剩幾單位」那一句——跟
        // SessionPicker 同一個順序：越不可逆的狀態越先講。
        const status = full
          ? t(COPY.planFull)
          : !inWindow
            ? Date.now() < (plan.saleStartsAt ? Date.parse(plan.saleStartsAt) : 0)
              ? t(COPY.planNotYet)
              : t(COPY.planEnded)
            : showSeatsRemaining
              ? `${t(SEATS_LEFT_LABEL)} ${left}`
              : null;
        return (
          <button
            key={plan.id}
            type="button"
            disabled={!available}
            aria-pressed={selected}
            onClick={() => onSelect(plan.id)}
            className={`block w-full border p-4 text-left transition-colors ${
              selected ? "border-foreground" : "border-border hover:border-foreground/50"
            } ${!available ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <span className="text-sm">{t(plan.title)}</span>
              <PriceTag price={plan.price} compareAtPrice={null} />
            </div>
            <span className="mt-1 block text-xs text-muted-foreground">
              {plan.seatsPerUnit > 1 ? `${t(COPY.perUnit)} ${plan.seatsPerUnit}` : null}
              {plan.seatsPerUnit > 1 && status ? " ・ " : ""}
              {status}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}

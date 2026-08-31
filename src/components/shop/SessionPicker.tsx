/**
 * 場次選擇器：一組場次卡片，額滿的那幾張不能點。
 *
 * 從 src/routes/shop.$slug.tsx 原樣搬出來的 —— 之後的活動詳情頁要用同一個選擇器，
 * 而「一邊抽元件一邊寫新頁」出問題時分不清是哪一邊壞的。所以先單獨抽、讓現有的
 * 商品頁換上去、確認畫面與行為完全沒變，新頁才敢接。
 *
 * 這裡**不持有選中的是哪一場**。選中的場次同時決定了數量上限（見 shop.$slug.tsx
 * 對 remainingForSession 的用法），把它藏進元件裡的話，外面就得再想辦法問回來 ——
 * 所以 selectedId 由呼叫端持有，元件只負責畫與回報點了哪一張。
 *
 * 「還剩幾位」一律走 src/lib/shop.ts 的 remainingForSession()，不在這裡自己算。
 * 那個數字同時是購物車行的上限與伺服器端預檢的依據，多一份實作就是多一個會跟
 * 它們慢慢長歪的地方。
 */
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import { remainingForSession, type ShopSession } from "@/lib/shop";
import { SEATS_LEFT_LABEL } from "@/components/shop/labels";

const COPY: Record<"chooseSession" | "sessionFull" | "noSessions", Localized> = {
  chooseSession: { zh: "選擇場次", en: "Choose a sitting", ja: "回を選ぶ" },
  sessionFull: { zh: "已額滿", en: "Full", ja: "満席" },
  noSessions: {
    zh: "目前沒有開放報名的場次。歡迎來信詢問下一次的時間。",
    en: "No sittings are open for booking right now. Write to us and we will let you know the next one.",
    ja: "現在お申し込みいただける回はありません。次回の日程についてはお問い合わせください。",
  },
};

export function SessionPicker({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: ShopSession[];
  /** 目前選中的場次 id，還沒選就是 null。 */
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  const t = useT();

  if (sessions.length === 0) {
    return (
      <p className="mb-8 text-sm leading-relaxed text-muted-foreground">{t(COPY.noSessions)}</p>
    );
  }

  return (
    <fieldset className="mb-8 space-y-3">
      <legend className="eyebrow text-xl">{t(COPY.chooseSession)}</legend>
      {sessions.map((session) => {
        const left = remainingForSession(session);
        const full = left <= 0;
        const selected = session.id === selectedId;
        return (
          <button
            key={session.id}
            type="button"
            disabled={full}
            aria-pressed={selected}
            onClick={() => onSelect(session.id)}
            className={`block w-full border p-4 text-left transition-colors ${
              selected ? "border-foreground" : "border-border hover:border-foreground/50"
            } ${full ? "cursor-not-allowed opacity-50" : ""}`}
          >
            <span className="block text-sm">{t(session.title)}</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              {formatSessionWhen(session.startsAt)}
              {" ・ "}
              {t(session.location)}
            </span>
            <span className="mt-2 block text-xs text-muted-foreground">
              {full ? t(COPY.sessionFull) : `${t(SEATS_LEFT_LABEL)} ${left}`}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}

/**
 * 場次時間。用瀏覽器的時區與語系無關的固定格式：這個頁面是三語的，而
 * `toLocaleString` 會在三種語系之間給出三種長度差很多的字串，把卡片撐歪。
 */
function formatSessionWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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

const COPY: Record<
  "chooseSession" | "sessionFull" | "noSessions" | "sessionsHeading" | "noPublicSessions",
  Localized
> = {
  chooseSession: { zh: "選擇場次", en: "Choose a sitting", ja: "回を選ぶ" },
  sessionFull: { zh: "已額滿", en: "Full", ja: "満席" },
  noSessions: {
    zh: "目前沒有開放報名的場次。歡迎來信詢問下一次的時間。",
    en: "No sittings are open for booking right now. Write to us and we will let you know the next one.",
    ja: "現在お申し込みいただける回はありません。次回の日程についてはお問い合わせください。",
  },
  sessionsHeading: { zh: "場次", en: "Sittings", ja: "開催回" },
  noPublicSessions: {
    zh: "這場活動目前沒有公開的場次時間。確定之後會公布在這裡。",
    en: "No sitting times have been published for this event yet. They will appear here once they are set.",
    ja: "この催しの日程はまだ公開されていません。決まり次第こちらに掲載します。",
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
 * 唯讀的場次清單，給 /events/$slug 用。
 *
 * ── 為什麼不是直接用上面那個 SessionPicker ──────────────────────────────────
 * 活動詳情頁**不結帳**。它的報名按鈕是導到 /shop/<slug>（見 src/routes/events.$slug.tsx
 * 對 fetchActiveProductForEventSlug 的用法），數量上限、佔位、金流全都發生在那一頁。
 * 在這裡放一個選得動的選擇器，等於讓客人選了一場、按下去卻發現什麼都沒帶過去 ——
 * 那個選擇是假的。所以這裡畫的是同一組資訊、但不能點。
 *
 * ── 為什麼住在這個檔案裡而不是活動頁自己畫 ──────────────────────────────────
 * 它跟 SessionPicker 共用 formatSessionWhen() 與 remainingForSession()。這兩樣
 * 各自只能有一份：前者複製一份就是兩種日期格式，後者複製一份就是「商品頁與活動頁
 * 對同一場活動顯示不同的剩餘名額」——  scripts/event-registration-selftest.mjs 上一期
 * 就是為了這件事才把選擇器抽出來的。
 *
 * 空清單一律渲染一句話，不是 return null：活動頁沒有任何場次資訊等於斷頭，而
 * 「還沒公布」與「這一塊壞了」在畫面上必須長得不一樣。
 */
export function SessionList({ sessions }: { sessions: ShopSession[] }) {
  const t = useT();

  return (
    <div>
      <p className="eyebrow text-2xl">{t(COPY.sessionsHeading)}</p>
      {sessions.length === 0 ? (
        <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
          {t(COPY.noPublicSessions)}
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {sessions.map((session) => {
            const left = remainingForSession(session);
            return (
              <li key={session.id} className="border border-border p-4">
                <span className="block text-sm">{t(session.title)}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {formatSessionWhen(session.startsAt)}
                  {" ・ "}
                  {t(session.location)}
                </span>
                <span className="mt-2 block text-xs text-muted-foreground">
                  {left <= 0 ? t(COPY.sessionFull) : `${t(SEATS_LEFT_LABEL)} ${left}`}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
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

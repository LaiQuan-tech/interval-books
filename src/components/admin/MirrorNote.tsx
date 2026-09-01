/**
 * 「這一塊的真相不在這一頁」的說明卡。
 *
 * ── 為什麼組裝器需要這種東西 ────────────────────────────────────────────────
 * 活動頁組裝器是一頁由上到下的表單，看起來每一段都是「在這裡編輯」。但這一頁上
 * 有五塊資料的真相住在別的地方：講者（public.artists）、活動分類
 * （public.event_categories）、報名名單（public.event_registrations）、活動地點
 * （public.event_sessions 的 location）、以及這場活動的商品（public.products）。
 *
 * 一頁表單裡混著「改這裡有用」與「改這裡沒用」的欄位，而且長得一模一樣，是後台
 * 最貴的一種誤會 —— 店家會在錯的地方改，然後以為自己改過了。所以這一塊刻意長得
 * **不像輸入框**：邊框、底色、一句「真相在哪裡」、一個過去的連結。
 *
 * ── 兩個方向，不是同一件事 ──────────────────────────────────────────────────
 *   · direction="mirror"（預設）—— **這裡只是鏡子**。值是從別的地方讀來的，在這一頁
 *     改不動；要改就去 `to`。講者、分類、報名名單、活動地點四塊都是這一種。
 *   · direction="source"  —— **方向相反**：這一頁會**產生**那邊的資料。商品那一塊是
 *     這一種 —— 儲存這一頁會經由 admin_upsert_event_with_session() 寫 public.products
 *     的文案欄位，所以跑去商品頁手動改標題／說明，下一次存活動就會被蓋回去。
 *     這句話必須寫在畫面上，不能只寫在 SQL 的註解裡。
 */
import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { ArrowUpRight, Info, TriangleAlert } from "lucide-react";

export type MirrorNoteDirection = "mirror" | "source";

type MirrorNoteProps = {
  /** 這塊資料叫什麼，例如「講者」。 */
  label: string;
  /** 真相住在哪張表／哪一頁，用店家看得懂的話寫，例如「講者」頁。 */
  source: string;
  /** 現在的值。唯讀顯示用；沒有值就傳 null，卡片會說「尚未設定」。 */
  children?: ReactNode;
  /** 去那一頁的連結。沒有可去的地方（例如地點跟著場次走）就不傳。 */
  to?: LinkProps["to"];
  /** 連結上的字。 */
  linkLabel?: string;
  direction?: MirrorNoteDirection;
  /** 補一句這一塊特有的話。 */
  hint?: string;
};

export function MirrorNote({
  label,
  source,
  children,
  to,
  linkLabel,
  direction = "mirror",
  hint,
}: MirrorNoteProps) {
  const isSource = direction === "source";
  const Icon = isSource ? TriangleAlert : Info;

  return (
    <div
      className={
        isSource
          ? "rounded-md border border-destructive/40 bg-destructive/5 p-3"
          : "rounded-md border border-border bg-muted/40 p-3"
      }
      data-mirror-note={direction}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${isSource ? "text-destructive" : "text-muted-foreground"}`}
        />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">{label}</p>
          <div className="text-sm text-muted-foreground">
            {children ?? <span className="italic">尚未設定</span>}
          </div>
          <p className={`text-xs ${isSource ? "text-destructive" : "text-muted-foreground"}`}>
            {isSource
              ? `⚠️ 這一頁會產生「${source}」的資料。儲存這頁會覆蓋那邊的文案欄位 —— 到那一頁手動改，下次存這一頁就會被蓋回去，兩邊會不一致。`
              : `這一欄在這裡改不動：真相在「${source}」，要改請到那一頁。這裡顯示的是目前的值。`}
          </p>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
          {to ? (
            <Link
              to={to}
              className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4"
            >
              {linkLabel ?? `前往${source}`}
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

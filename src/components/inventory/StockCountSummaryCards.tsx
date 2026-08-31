/**
 * 盤點頁頂端的四張統計卡。
 *
 * 從 _shell.inventory-count.tsx 抽出來：那個檔案原本是「路由 ＋ 統計卡 ＋ 篩選列 ＋
 * 清單 ＋ 兩個對話框」擠在一起，長到剛好卡在自檢的 300 行上限，連 prettier 都套不
 * 上去（折行會讓它超過）。卡片長什麼樣與「這一頁怎麼抓資料」是兩種各自會變動的
 * 東西，混在一個檔案裡改一個就要重讀另一個。
 *
 * ⚠️ 數字來自 getAdjustmentSummary，它只算 status = 'confirmed' 的那些。草稿與待審
 *    的還沒生效，算進去會讓「調整成本」比實際大。
 */
import { ClipboardCheck, ClipboardList, History, Package } from "lucide-react";

type StatProps = { label: string; value: string; hint?: string; icon: typeof Package };

function StatCard({ label, value, hint, icon: Icon }: StatProps) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-border p-4">
      <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-medium tabular-nums">{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

type Props = {
  total: number;
  summary: Record<string, { count: number; quantity: number; cost: number }>;
};

export function StockCountSummaryCards({ total, summary }: Props) {
  const adj = summary.ADJ ?? { count: 0, quantity: 0, cost: 0 };
  const adjCost = `NT$ ${Math.round(adj.cost).toLocaleString("zh-TW")}`;

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard label="商品總數" value={total.toLocaleString("zh-TW")} icon={Package} />
      <StatCard label="盤點紀錄" value={`${adj.count} 筆`} hint="已確認的才算" icon={History} />
      <StatCard
        label="調整件數"
        value={`${adj.quantity} 件`}
        hint="盤虧＋盤盈"
        icon={ClipboardCheck}
      />
      <StatCard label="調整成本" value={adjCost} icon={ClipboardList} />
    </div>
  );
}

/**
 * /admin/orders —— 訂單列表、詳情、標記已收款。
 *
 * 站上剛上線「匯款」這個付款方式（0034）：客人下單後自己匯款到店家固定帳戶，
 * 匯完回報末五碼，店家對帳之後手動標成已收款。在這一頁存在之前，後台完全沒有
 * 任何地方看得到訂單 —— 匯款訂單會在 3 天後被 expire_unpaid_orders() 自動取消
 * （0034 §4），錢收了卻沒有人能把單子結掉。這一頁的預設分頁（「待收款的匯款
 * 訂單」）就是為了讓這件事有地方做。
 *
 * 🔴 個資：這一頁比商品頁敏感得多，姿態抄 0021 對報名名單的處置 —— 但**做不到
 * 同一個結構**（明文有一個會寫稽核紀錄的出口）。完整理由見
 * src/server/repos/orders-admin.ts 檔頭：inv schema 的遮罩函式打不到、
 * pii_access_log 的白名單 CHECK 沒有 'public.orders'，兩者都需要新 migration 才
 * 補得上。這一期的選擇是**只給遮罩，不給明文**：
 *
 *   · 姓名（客戶／收件人）—— 不遮罩。核對匯款需要看得出「是不是銀行對帳單上那個
 *     人」，遮了就對不了帳。
 *   · 信箱／電話 —— 只有遮罩值，一路到瀏覽器都是（src/lib/admin/pii-mask.ts）。
 *   · 門牌（街路門牌號碼）—— 完全不顯示、伺服器也不查詢。這一頁的任務是核對錢
 *     有沒有入帳，不是出貨；縣市／區已經夠核對用。
 *
 * 沒有「顯示完整聯絡方式」這顆按鈕 —— 結構上沒有一個會留下稽核紀錄的出口可以接
 * （見上），與其做一個不留痕的明文出口，不如先不給。
 *
 * ── 為什麼是「列表 + 點列開詳情 Dialog」，不是 /admin/orders/$id 子路由 ────────
 * 形狀照 _shell.sales.tsx（銷售紀錄）：詳情不需要自己的網址，訂單量對一間書店
 * 而言不到需要深連結分享的規模，Dialog 換頁面少一次 loader round trip。
 */
import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Landmark, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
// ⚠️ type-only：編譯後整行消失，不會把 server-only 的 repo 模組拉進瀏覽器
// bundle（同 _shell.sales.tsx 對 src/server/repos/inv-sales.ts 的做法）。
import type { AdminOrderDetail, AdminOrderListRow } from "@/server/repos/orders-admin";

type Scope = "transfer_pending" | "all";

/**
 * 這一頁不是報表，單次讀取有上限 —— 必須與
 * src/server/repos/orders-admin.ts 的 LIST_LIMIT 保持一致（那裡是查詢的
 * `.limit()`，這裡只是「是不是可能被截斷了」的畫面提示，兩處各自維護，改動機率
 * 趨近於零，見該檔案檔頭關於「值域固定」的同一個判斷）。
 */
const LIST_LIMIT_HINT = 300;

/**
 * 付款方式／配送方式的中文對照。**刻意與 src/lib/email-templates.ts 的
 * PAYMENT_METHOD_LABEL_ZH／SHIPPING_METHOD_LABEL_ZH 各自維護一份**，不是共用
 * import：那個檔案是給寄信用的，861 行都是信件樣板字串，只為了兩個對照表把它整包
 * 拉進後台的瀏覽器 bundle 不划算。值域鎖在資料庫的 CHECK 裡，改動機率趨近於零，
 * 兩份保持同樣的中文字即可。
 */
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  card: "信用卡",
  atm: "ATM 轉帳",
  cvs_cod: "超商代收",
  test_paid: "測試付款",
  free: "免費（無需付款）",
  // 0034。與 'atm' 刻意用不同的字：'atm' 是金流商動態虛擬帳號、自動核帳；
  // 'transfer' 是客人匯到店家固定帳戶、人工對帳。
  transfer: "匯款（人工對帳）",
};
function paymentMethodLabel(code: string | null): string {
  if (!code) return "由店家聯繫付款";
  return PAYMENT_METHOD_LABEL[code] ?? code;
}

const SHIPPING_METHOD_LABEL: Record<string, string> = {
  home: "宅配到府",
  cvs: "超商取貨",
  pickup: "門市自取",
  none: "無需配送",
};
function shippingMethodLabel(code: string): string {
  return SHIPPING_METHOD_LABEL[code] ?? code;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "待處理",
  processing: "處理中",
  shipped: "已出貨",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失敗",
};

const PAYMENT_STATUS_LABEL: Record<string, string> = {
  pending: "待付款",
  paid: "已付款",
  failed: "付款失敗",
  refunded: "已退款",
};

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

function statusBadgeVariant(status: string): BadgeVariant {
  if (status === "cancelled" || status === "failed") return "destructive";
  if (status === "processing" || status === "shipped" || status === "completed") return "default";
  return "secondary";
}

function paymentStatusBadgeVariant(status: string): BadgeVariant {
  if (status === "paid") return "default";
  if (status === "failed" || status === "refunded") return "destructive";
  return "secondary";
}

function money(n: number): string {
  return `NT$ ${n.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const Route = createFileRoute("/admin/_shell/orders")({
  loader: async () => {
    const { listAdminOrders } = await import("@/lib/admin/fns/orders");
    // 預設分頁就是「待收款的匯款訂單」——這一頁存在的理由，見檔頭。
    const orders = await listAdminOrders({ data: { scope: "transfer_pending" } });
    return { orders };
  },
  head: () => ({ meta: [{ title: "訂單｜小時光書店後台" }] }),
  component: AdminOrdersPage,
});

function AdminOrdersPage() {
  const { orders: initial } = Route.useLoaderData();

  const [scope, setScope] = useState<Scope>("transfer_pending");
  const [orders, setOrders] = useState<AdminOrderListRow[]>(initial);
  const [loading, setLoading] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [note, setNote] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [marking, setMarking] = useState(false);

  const load = useCallback(async (next: Scope) => {
    setLoading(true);
    try {
      const { listAdminOrders } = await import("@/lib/admin/fns/orders");
      setOrders(await listAdminOrders({ data: { scope: next } }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "訂單列表讀取失敗");
    } finally {
      setLoading(false);
    }
  }, []);

  // 第一次不重打：loader 已經用預設 scope 抓過了（同 _shell.sales.tsx 的做法）。
  const isInitial = scope === "transfer_pending" && orders === initial;
  useEffect(() => {
    if (isInitial) return;
    void load(scope);
  }, [scope, isInitial, load]);

  async function openDetail(id: string) {
    setSelectedId(id);
    setDetail(null);
    setNote("");
    setDetailLoading(true);
    try {
      const { getAdminOrderDetail } = await import("@/lib/admin/fns/orders");
      const d = await getAdminOrderDetail({ data: { orderId: id } });
      if (!d) {
        toast.error("找不到這張訂單，可能已被刪除");
        setSelectedId(null);
        return;
      }
      setDetail(d);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "訂單詳情讀取失敗");
      setSelectedId(null);
    } finally {
      setDetailLoading(false);
    }
  }

  function closeDetail(open: boolean) {
    if (open) return;
    setSelectedId(null);
    setDetail(null);
    setNote("");
    setConfirmOpen(false);
  }

  /**
   * 呼叫 admin_mark_order_paid()，四種 reason 各自對應一句清楚的話 —— 不是只有
   * 成功／失敗兩種（見任務驗收條件）。already_paid 用 toast.info 而不是
   * toast.error：那是冪等成功（同一張單被標記了兩次），不是一次失敗，
   * 同 _shell.stock-alerts.tsx 對「這一筆已經有人處理過了」的處置。
   */
  async function submitMarkPaid() {
    if (!detail) return;
    setMarking(true);
    try {
      const { markOrderPaidAdmin } = await import("@/lib/admin/fns/orders");
      const result = await markOrderPaidAdmin({
        data: { orderId: detail.id, note: note.trim() || null },
      });

      if (result.reason === "marked") {
        toast.success(`已標記為已收款（訂單 ${result.order_no}）`);
      } else if (result.reason === "already_paid") {
        toast.info(`訂單 ${result.order_no} 已經是已收款狀態，沒有重複處理`);
      } else if (result.reason === "order_not_pending") {
        toast.error(
          `訂單 ${result.order_no ?? ""} 目前不是待處理狀態（可能已出貨、取消或付款失敗），` +
            "無法標記為已收款",
        );
      } else {
        toast.error("找不到這張訂單，可能已被刪除或編號有誤");
      }

      setConfirmOpen(false);
      setNote("");

      // 兩件事都要重讀：這張訂單的詳情（畫面要看得到新狀態），以及列表
      // （scope='transfer_pending' 時，剛標成已付款的這一筆該從清單上消失）。
      const { getAdminOrderDetail } = await import("@/lib/admin/fns/orders");
      const fresh = await getAdminOrderDetail({ data: { orderId: detail.id } });
      if (fresh) setDetail(fresh);
      await load(scope);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "標記失敗，請稍後再試");
    } finally {
      setMarking(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-medium">
          <Landmark className="h-5 w-5" aria-hidden="true" />
          訂單
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          客人匯款後要有人核對入帳、手動標成已收款——逾期未標記的匯款訂單會在 3
          天後被自動取消。姓名以外的聯絡方式只顯示遮罩值，門牌不顯示。
        </p>
      </div>

      <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)}>
        <TabsList>
          <TabsTrigger value="transfer_pending">待收款的匯款訂單</TabsTrigger>
          <TabsTrigger value="all">全部訂單</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>訂單編號</TableHead>
              <TableHead>客戶</TableHead>
              <TableHead>日期</TableHead>
              <TableHead className="text-right">金額</TableHead>
              <TableHead>付款方式</TableHead>
              <TableHead>付款狀態</TableHead>
              <TableHead>末五碼</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                </TableCell>
              </TableRow>
            ) : orders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-sm text-muted-foreground">
                  {scope === "transfer_pending" ? "目前沒有待收款的匯款訂單" : "目前沒有訂單"}
                </TableCell>
              </TableRow>
            ) : (
              orders.map((o) => (
                <TableRow
                  key={o.id}
                  onClick={() => void openDetail(o.id)}
                  className="cursor-pointer"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void openDetail(o.id);
                    }
                  }}
                >
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {o.order_no}
                  </TableCell>
                  <TableCell className="max-w-[10rem] truncate">{o.customer_name}</TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {formatDateTime(o.created_at)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(o.total)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {paymentMethodLabel(o.payment_method)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={paymentStatusBadgeVariant(o.payment_status)}
                      className="font-normal"
                    >
                      {PAYMENT_STATUS_LABEL[o.payment_status] ?? o.payment_status}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{o.remittance_last5 ?? "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {!loading && orders.length >= LIST_LIMIT_HINT ? (
        <p className="text-xs text-muted-foreground">
          已達到單次讀取上限（{LIST_LIMIT_HINT} 筆），可能還有更早的訂單沒有顯示。
        </p>
      ) : null}

      <Dialog open={selectedId !== null} onOpenChange={closeDetail}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detail ? detail.order_no : "訂單詳情"}</DialogTitle>
            <DialogDescription>
              信箱與電話只顯示遮罩值，門牌完全不顯示——這一頁沒有查看明文的入口。
            </DialogDescription>
          </DialogHeader>

          {detailLoading || !detail ? (
            <p className="py-8 text-center text-sm text-muted-foreground">讀取中…</p>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={statusBadgeVariant(detail.status)}>
                  {STATUS_LABEL[detail.status] ?? detail.status}
                </Badge>
                <Badge variant={paymentStatusBadgeVariant(detail.payment_status)}>
                  {PAYMENT_STATUS_LABEL[detail.payment_status] ?? detail.payment_status}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  下單於 {formatDateTime(detail.created_at)}
                  {detail.paid_at ? `・付款於 ${formatDateTime(detail.paid_at)}` : ""}
                </span>
              </div>

              <section className="space-y-1.5">
                <h3 className="text-sm font-medium">付款</h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">付款方式</dt>
                  <dd>{paymentMethodLabel(detail.payment_method)}</dd>
                  {detail.payment_method === "transfer" ? (
                    <>
                      <dt className="text-muted-foreground">回報末五碼</dt>
                      <dd className="font-mono">{detail.remittance_last5 ?? "（尚未回報）"}</dd>
                      <dt className="text-muted-foreground">回報時間</dt>
                      <dd>{formatDateTime(detail.remittance_reported_at)}</dd>
                    </>
                  ) : null}
                </dl>
              </section>

              <section className="space-y-1.5">
                <h3 className="text-sm font-medium">金額</h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
                  <dt className="text-muted-foreground">小計</dt>
                  <dd className="text-right">{money(detail.subtotal)}</dd>
                  <dt className="text-muted-foreground">運費</dt>
                  <dd className="text-right">{money(detail.shipping_fee)}</dd>
                  <dt className="text-muted-foreground">折扣</dt>
                  <dd className="text-right">−{money(detail.discount)}</dd>
                  <dt className="font-medium">總計</dt>
                  <dd className="text-right font-medium">{money(detail.total)}</dd>
                </dl>
              </section>

              <section className="space-y-1.5">
                <h3 className="text-sm font-medium">品項</h3>
                <div className="overflow-x-auto rounded-md border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>品項</TableHead>
                        <TableHead className="w-16 text-right">數量</TableHead>
                        <TableHead className="w-24 text-right">單價</TableHead>
                        <TableHead className="w-24 text-right">小計</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell>
                            <span>{item.name.zh}</span>
                            {item.session_title ? (
                              <span className="block text-xs text-muted-foreground">
                                場次：{item.session_title.zh}
                                {item.session_starts_at
                                  ? `・${formatDateTime(item.session_starts_at)}`
                                  : ""}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {money(item.unit_price)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {money(item.subtotal)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </section>

              <section className="space-y-1.5">
                <h3 className="text-sm font-medium">收件方式</h3>
                <p className="text-sm">{shippingMethodLabel(detail.shipping_method)}</p>
                {detail.addresses.map((a) => (
                  <div key={a.type} className="rounded-md border border-border p-3 text-sm">
                    <p>
                      {a.recipient}
                      <span className="ml-2 text-muted-foreground">{a.phone_masked ?? "—"}</span>
                    </p>
                    {a.city || a.district || a.postal_code ? (
                      <p className="text-muted-foreground">
                        {[a.postal_code, a.city, a.district].filter(Boolean).join(" ")}
                        <span className="ml-1">（門牌基於隱私保護不顯示）</span>
                      </p>
                    ) : null}
                    {a.cvs_store_name ? (
                      <p className="text-muted-foreground">
                        {a.cvs_store_name}
                        {a.cvs_address ? `・${a.cvs_address}` : ""}
                      </p>
                    ) : null}
                  </div>
                ))}
              </section>

              <section className="space-y-1.5">
                <h3 className="text-sm font-medium">聯絡資訊</h3>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">姓名</dt>
                  <dd>{detail.customer_name}</dd>
                  <dt className="text-muted-foreground">信箱（遮罩）</dt>
                  <dd>{detail.customer_email_masked ?? "—"}</dd>
                  <dt className="text-muted-foreground">電話（遮罩）</dt>
                  <dd>{detail.customer_phone_masked ?? "—"}</dd>
                </dl>
              </section>

              {detail.payment_status !== "paid" ? (
                <section className="space-y-2 rounded-md border border-border p-3">
                  <h3 className="text-sm font-medium">標記已收款</h3>
                  <p className="text-xs text-muted-foreground">
                    對過銀行對帳單、確認這筆款項真的入帳之後才按下面這顆按鈕。
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="mark-paid-note">備註（選填）</Label>
                    <Textarea
                      id="mark-paid-note"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="例如：對到 9/3 01:15 那筆"
                      rows={2}
                    />
                  </div>
                  <Button onClick={() => setConfirmOpen(true)} disabled={marking}>
                    標記已收款
                  </Button>
                </section>
              ) : (
                <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
                  這張訂單已經是已收款狀態。
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確定要標記已收款？</AlertDialogTitle>
            <AlertDialogDescription>
              {detail
                ? `訂單 ${detail.order_no}，金額 ${money(detail.total)}` +
                  (detail.remittance_last5 ? `，客人回報末五碼 ${detail.remittance_last5}` : "") +
                  "。請先確認銀行對帳單上真的有這一筆——這個動作無法在這一頁復原。"
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={marking}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={marking}
              onClick={(e) => {
                e.preventDefault();
                void submitMarkPaid();
              }}
            >
              {marking ? "標記中…" : "確定標記已收款"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

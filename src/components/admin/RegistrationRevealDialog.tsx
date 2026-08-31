/**
 * 查看某一位參加者的完整聯絡方式 —— 名單頁唯一看得到明文的地方。
 *
 * ── 這個對話框在解什麼問題 ────────────────────────────────────────────────
 * 名單頁上的每一列拿到的都是 `*_masked`：0021 §3 的 view 根本沒有把明文送到瀏覽器。
 * 真的要打電話給某一位的時候（臨時取消、場地改了、東西掉在現場）走這一扇門，
 * 而這扇門會記下「誰、什麼時候、看了哪一位」。
 *
 * ⚠️ **呼叫成功就一定留下一筆 pii_access_log。** 那不是副作用，是它一半的工作：
 *    0021 §5 的函式在同一個交易裡先寫紀錄再組值，所以「拿到值但沒留下紀錄」在結構
 *    上不可能發生。使用者看得到這句話，是因為知道會被記錄本身就是這個設計的一部分
 *    —— 偷偷記錄只能事後追究，講明白才會讓人在按下去之前想一秒。
 *
 * ── 與 VendorSensitiveDialog 刻意不同的一件事：沒有事由下拉選單 ────────────
 * 廠商那一側有五種事由（對帳／匯款／報稅／來電查詢／自助入口），因為那五件事真的
 * 會發生，而且分得出來。名單只有兩種看法 —— 看某一位（這裡）與帶走整場（CSV）——
 * 而它們**由動作決定**，不由使用者挑。給一個永遠只有一個正確答案的下拉選單，
 * 得到的不是資訊而是雜訊，而雜訊會讓真正在讀稽核軌跡的人失去判斷力。
 *
 * 所以事由是**顯示**的，不是選的：使用者仍然看得到這次會以什麼名義留下紀錄。
 * reason 寫死在 src/server/repos/event-registrations.ts，前端連送都送不進來。
 *
 * ⚠️ 沒有「一次看整場」的按鈕。要整場就走 CSV 匯出，而那會留下一筆長得完全不一樣
 *    的紀錄（subject 是場次）。這兩件事在稽核畫面上必須分得出來（0021 §0.1）。
 *
 * ⚠️ 沒有 `event.roster.read` 的人：送出鈕是 disabled。**disabled 不是授權** ——
 *    真正擋住直接 POST /_serverFn/… 的是 fns/event-registrations.ts 裡那一次
 *    requireRosterRead()，而它是從 staff_permissions 重讀出來的，不看前端送什麼。
 *
 * ⚠️ 讀回來的值只活在這個對話框的 state 裡：關掉就清掉，不寫進表單、不塞進
 *    localStorage、也不放進網址。要再看一次就再查一次，而那會是新的一筆紀錄 ——
 *    這正是想要的形狀。
 */
import { useEffect, useState } from "react";
import { Eye, Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ROSTER_ACCESS_REASON_LABELS } from "@/lib/admin/schemas";
import type {
  RegistrationContact,
  RegistrationRosterRow,
} from "@/server/repos/event-registrations";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = 沒有選中任何一列，對話框不畫。 */
  registration: RegistrationRosterRow | null;
  canReadRoster: boolean;
};

export function RegistrationRevealDialog({
  open,
  onOpenChange,
  registration,
  canReadRoster,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RegistrationContact | null>(null);

  // 每次開啟都從零開始。上一位的電話留在畫面上是這一頁最不該發生的事。
  useEffect(() => {
    if (open) return;
    setResult(null);
    setLoading(false);
  }, [open]);

  async function read() {
    if (!registration) return;
    setLoading(true);
    try {
      const { revealRegistrationContact } = await import("@/lib/admin/fns/event-registrations");
      setResult(
        await revealRegistrationContact({
          data: { registrationId: registration.registration_id },
        }),
      );
    } catch (err) {
      // 沒有權限的人（或直接打 API 的人）在這裡拿到 NotAuthorizedError。
      toast.error(err instanceof Error ? err.message : "聯絡方式讀取失敗");
    } finally {
      setLoading(false);
    }
  }

  if (!registration) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => !loading && onOpenChange(o)}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">查看「{registration.name}」的完整聯絡方式</DialogTitle>
          <DialogDescription>
            座位 {registration.seat_no}・訂單 {registration.order_no}
            ・平常畫面上顯示的都是遮罩，完整號碼只有這裡看得到。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <span>
            <strong>這次查閱會留下紀錄</strong>
            ：你的帳號、查閱時間、以及事由「{ROSTER_ACCESS_REASON_LABELS.attendee_contact}
            」都會寫進稽核軌跡，而且刪不掉。參加者是客人，不是可以隨手翻的資料。
          </span>
        </div>

        <dl className="space-y-1.5">
          <MaskedRow
            label="信箱"
            masked={registration.email_masked}
            has={registration.has_email}
            plain={result?.email}
          />
          <MaskedRow
            label="電話"
            masked={registration.phone_masked}
            has={registration.has_phone}
            plain={result?.phone}
          />
        </dl>

        {result ? (
          <>
            <Separator />
            <p className="text-xs text-muted-foreground">
              紀錄編號 {result.log_id}
              ・關掉這個視窗，上面的號碼就從畫面上消失（沒有存在任何地方）。
            </p>
          </>
        ) : null}

        <DialogFooter>
          <Button variant="outline" disabled={loading} onClick={() => onOpenChange(false)}>
            關閉
          </Button>
          <Button
            className="gap-1.5"
            // ⚠️ disabled 只是畫面。擋住直接呼叫的是 server fn 那一次 requireRosterRead()。
            // `result !== null` 那一半是另一件事：查過一次之後就不能再按，免得手滑
            // 連點兩下留下兩筆內容一模一樣的紀錄。要再查一次就關掉重開 —— 那時候
            // state 已經清空，而且會是新的一筆紀錄，那正是想要的形狀。
            disabled={loading || !canReadRoster || result !== null}
            title={canReadRoster ? undefined : "需要「查看活動報名名單」權限"}
            onClick={() => void read()}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
            查看並留下紀錄
          </Button>
        </DialogFooter>

        {!canReadRoster ? (
          <p className="text-xs text-muted-foreground">
            你沒有「查看活動報名名單」（event.roster.read）權限。請找管理員授權 —— 這個權限與各種
            approve_*
            是不同維度的東西：一個管收貨的店員有理由簽核進貨，沒有理由看到活動參加者的電話。
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * 一列聯絡方式。查閱之前顯示遮罩值，查閱之後換成明文。
 *
 * 「沒填」與「填了但你看不到」長得不一樣：前者是「（未填）」，後者是遮罩值。
 * 這就是 view 為什麼要送 has_email / has_phone —— 遮罩值本身分不出這兩件事
 * （沒填的話遮罩結果是 null，看起來跟「查不到」一樣）。
 */
function MaskedRow({
  label,
  masked,
  has,
  plain,
}: {
  label: string;
  masked: string | null;
  has: boolean;
  plain?: string | null;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 rounded-md border border-border p-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-sm tabular-nums">
        {plain !== undefined && plain !== null ? plain : has ? (masked ?? "—") : "（未填）"}
      </dd>
    </div>
  );
}

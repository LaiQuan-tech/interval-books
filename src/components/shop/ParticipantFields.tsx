/**
 * 逐位參加者的欄位組，掛在 /checkout 的表單裡。
 *
 * 為什麼是「逐位」而不是「一組聯絡人 × N」
 * ----------------------------------------
 * 快樂手（~/.gemini/File/happyhand）只收一組聯絡人，qty=3 在名單上就是一列寫著
 * 「3 人」。到了現場，另外兩位是誰沒有人知道 —— 點名點不出來，保險名冊填不出來，
 * 臨時要通知也只找得到訂購人。這裡把它做成 N 份欄位，代價是表單長一點，換到的是
 * 一份真的能用的簽到表。
 *
 * ⚠️ 這些值**不進購物車**。
 * ------------------------
 * 最順手的做法是把它們掛在 CartLine 上，而 CartLine 會被 persist() 寫進
 * localStorage —— 那等於把第三人的姓名與電話留在瀏覽器裡，沒有到期時間，也沒有
 * 任何一頁告訴使用者它在那裡。所以它們只活在這張表單的狀態裡，送出之後就交給
 * 伺服器。src/lib/cart.ts 的檔頭有同一條註記。
 *
 * 欄位路徑是攤平的 `participants.<index>.<field>`，不是
 * `participants["<productId>:<sessionId>"][n].name`。react-hook-form 把 `.` 當成
 * 層級分隔，而 lineKey 裡有冒號與 uuid，巢狀路徑它解析不了 —— 錯誤訊息會印不回
 * 正確的輸入框（也就是「送出沒反應，畫面上什麼都沒有」）。攤平之後每一格都對得
 * 回去，代價只是每一筆自己帶一個 lineKey。
 *
 * 同意欄位存的是**時間**不是 boolean：資料庫欄位是
 * event_registrations.notice_ack_at，由 reserve_session_seat() 在寫入的當下取
 * now()。所以這個 checkbox 是必填的 —— 一個永遠沒人勾的同意欄位就是一個死欄位，
 * 而這個 repo 已經有兩個那樣的欄位了（events.registration_type 與
 * payment_enabled，五期沒人讀）。
 */
import { useFormContext } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useT } from "@/i18n/LanguageContext";
import type { Localized } from "@/i18n/types";
import type { CheckoutFormValues } from "@/lib/checkout";

const COPY = {
  /**
   * ⚠️ 一整句，不是「前綴 + 數字 + 後綴」三段拼起來。
   *
   * useT() 是 `entry[lang] || entry.zh` —— **空字串會退回中文**。所以把英文的後綴
   * 留空（英文不需要量詞）會讓畫面印出 `Attendee 1 位參加者`。這是真的發生過的，
   * 打開頁面才看得到。三語各自寫完整的一句，用 {n} 佔位。
   */
  seatLabel: { zh: "第 {n} 位參加者", en: "Attendee {n}", ja: "参加者 {n} 人目" },
  name: { zh: "姓名", en: "Name", ja: "お名前" },
  email: { zh: "電子信箱", en: "Email", ja: "メールアドレス" },
  phone: { zh: "手機號碼", en: "Mobile", ja: "携帯番号" },
  contactHint: {
    zh: "信箱與手機至少填一項，活動有異動時我們才聯絡得到這位參加者。",
    en: "Please give at least an email or a mobile number, so we can reach this attendee if anything changes.",
    ja: "変更が生じた際にご連絡できるよう、メールアドレスか携帯番号のいずれかをご入力ください。",
  },
  /**
   * ⚠️ 佔位文案。正式的三語「活動注意事項」尚未提供，之後會搬到 CMS
   * （src/lib/site-content.tsx 那一套）由後台維護。在那之前這裡是寫死的，而且
   * 刻意寫得保守 —— 一段假裝具體的佔位條款比一段明說自己是概括的更糟。
   */
  notice: {
    zh: "我已閱讀並同意活動注意事項（報名後如需取消或改期，請於活動前來信聯繫）。",
    en: "I have read and accept the activity notes (to cancel or reschedule, please write to us before the event).",
    ja: "ご参加にあたっての注意事項を確認し、同意します（キャンセル・日程変更をご希望の場合は開催前にご連絡ください）。",
  },
};

type ParticipantFieldsProps = {
  /** 這一組欄位屬於購物車的哪一行（cartLineKey）。只用來顯示，值由 index 決定。 */
  lineTitle: Localized;
  /** 場次名稱，讓客人看得出這幾位是報名哪一梯次。 */
  sessionTitle: Localized | null;
  /**
   * 這一行在攤平陣列裡的起始 index 與人數。由 /checkout 算出來，因為只有它看得到
   * 整個購物車 —— 這個元件刻意不知道別行的存在。
   */
  startIndex: number;
  count: number;
};

export function ParticipantFields({
  lineTitle,
  sessionTitle,
  startIndex,
  count,
}: ParticipantFieldsProps) {
  const t = useT();
  const { control } = useFormContext<CheckoutFormValues>();

  return (
    <div className="space-y-6 border border-border p-5">
      <div>
        <p className="text-sm font-medium">{t(lineTitle)}</p>
        {sessionTitle ? (
          <p className="mt-1 text-xs text-muted-foreground">{t(sessionTitle)}</p>
        ) : null}
      </div>

      {Array.from({ length: count }, (_, offset) => {
        const i = startIndex + offset;
        return (
          <div
            key={i}
            className="space-y-4 border-t border-border pt-5 first:border-t-0 first:pt-0"
          >
            <p className="eyebrow text-xs text-muted-foreground">
              {t(COPY.seatLabel).replace("{n}", String(offset + 1))}
            </p>

            <FormField
              control={control}
              name={`participants.${i}.name` as const}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t(COPY.name)}</FormLabel>
                  <FormControl>
                    <Input {...field} value={field.value ?? ""} autoComplete="off" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={control}
                name={`participants.${i}.email` as const}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t(COPY.email)}</FormLabel>
                    <FormControl>
                      <Input type="email" {...field} value={field.value ?? ""} autoComplete="off" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name={`participants.${i}.phone` as const}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t(COPY.phone)}</FormLabel>
                    <FormControl>
                      <Input
                        type="tel"
                        inputMode="numeric"
                        {...field}
                        value={field.value ?? ""}
                        autoComplete="off"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {/* ⚠️ 一般的 <p>，不是 <FormDescription>。後者呼叫 useFormField()，而那個
                hook 需要 <FormField> 與 <FormItem> 兩層 context —— 掛在這裡（兩個
                欄位共用的說明，不屬於任何單一欄位）會在 render 時丟出
                「useFormField should be used within <FormField>」，整個 /checkout
                換成錯誤畫面。這是實際打開頁面才看得到的，型別檢查與 build 都是綠的。 */}
            <p className="text-sm text-muted-foreground">{t(COPY.contactHint)}</p>

            <FormField
              control={control}
              name={`participants.${i}.noticeAck` as const}
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-start gap-3">
                    <FormControl>
                      <Checkbox
                        checked={field.value === true}
                        onCheckedChange={(v) => field.onChange(v === true)}
                      />
                    </FormControl>
                    <FormLabel className="text-sm font-normal leading-relaxed">
                      {t(COPY.notice)}
                    </FormLabel>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        );
      })}
    </div>
  );
}

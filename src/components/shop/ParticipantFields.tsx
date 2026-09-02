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
 * 同一條規矩也管「同購買人」那個勾選框：它的**狀態**由 /checkout 用 useState 持有、
 * 它**帶入的值**寫進 react-hook-form 的表單狀態，兩者都不會經過 cart 或 localStorage。
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
import { useEffect, useId } from "react";
import { useFormContext, useWatch } from "react-hook-form";
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
  /**
   * 「同購買人」——只有全表單的第一位會看到。
   *
   * ⚠️ 不要把它寫成「與第 1 位相同」之類的相對說法：第二位以後根本沒有這個框，
   *    而唯一有框的那一位，它的參照對象是上面那一段「聯絡資料」，不是別的參加者。
   */
  sameAsBuyer: {
    zh: "同購買人（帶入上方聯絡資料）",
    en: "Same as the person booking (use the contact details above)",
    ja: "お申し込み者と同じ（上のご連絡先を使う）",
  },
  /**
   * 勾起來之後才出現。它解釋的是「為什麼這三格打不了字」——沒有這一句，客人會在
   * 唯讀的欄位裡打字、發現沒反應，然後以為是頁面壞了。
   */
  sameAsBuyerHint: {
    zh: "這三格會跟著上方的聯絡資料自動更新。要分開填的話，取消勾選即可（已帶入的內容會留著）。",
    en: "These three fields follow the contact details above. Untick to edit them separately — what has been filled in stays.",
    ja: "この3つの項目は上のご連絡先に自動で追従します。個別に入力する場合はチェックを外してください（入力済みの内容は残ります）。",
  },
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
  /**
   * 「同購買人」的勾選狀態。**只有全表單的第一位**（startIndex + offset === 0）
   * 看得到這個框 —— 第二位以後是別人，沒有「同購買人」可言。傳 undefined 就完全
   * 不渲染它，所以第二行以後的 ParticipantFields 連知道都不用知道有這件事。
   *
   * ⚠️ 這個布林**不進 CheckoutFormValues**，由 /checkout 用 useState 持有。
   *    放進表單值會讓它跟著 `{...values}` 一起送進 placeOrder() —— 那就是改了送出的
   *    形狀；放進購物車則會被 persist() 寫進 localStorage（見本檔檔頭與 src/lib/cart.ts）。
   *    它只是一個畫面上的開關，不是訂單的一部分。
   */
  sameAsBuyer?: boolean;
  onSameAsBuyerChange?: (next: boolean) => void;
};

export function ParticipantFields({
  lineTitle,
  sessionTitle,
  startIndex,
  count,
  sameAsBuyer,
  onSameAsBuyerChange,
}: ParticipantFieldsProps) {
  const t = useT();
  const { control, setValue } = useFormContext<CheckoutFormValues>();
  const sameAsBuyerId = useId();

  /** 只有第一組的第一位會連動；其餘的 ParticipantFields 這裡永遠是 false。 */
  const linked = startIndex === 0 && sameAsBuyer === true;

  /**
   * 🔴 用 useWatch 訂閱這三格，**不是**在 onCheckedChange 裡複製一次。
   *
   * 使用者的實際順序常常是「先勾起來、再回上面把電話改掉」。只在勾的當下複製一次的
   * 寫法，那個改動會靜默不同步 —— 畫面上第一位參加者還留著舊電話，而客人已經看過
   * 那三格是自動帶入的、不會再檢查一次。useWatch 讓這三個值一變就重新 render，
   * 下面那個 effect 的相依陣列也就跟著變、跟著重跑。
   *
   * ⚠️ 這三個相依（buyerName / buyerEmail / buyerPhone）少掉任何一個，就退化成
   *    「只有勾的當下複製一次」的那個 bug，而畫面上看起來完全正常。
   */
  const buyerName = useWatch({ control, name: "customerName" });
  const buyerEmail = useWatch({ control, name: "customerEmail" });
  const buyerPhone = useWatch({ control, name: "customerPhone" });

  useEffect(() => {
    if (!linked) return;
    const opts = { shouldValidate: false, shouldDirty: true } as const;
    setValue("participants.0.name", buyerName ?? "", opts);
    setValue("participants.0.email", buyerEmail ?? "", opts);
    setValue("participants.0.phone", buyerPhone ?? "", opts);
    /**
     * ⚠️ `participants.0.noticeAck` **不在這裡**，而且不可以加進來。
     *
     * 那是每一位參加者各自對注意事項的同意，購買人沒有立場替人勾 —— 資料庫存的是
     * event_registrations.notice_ack_at（一個時間戳），代表「這個人在那個時刻同意了」。
     * 自動勾起來會讓那個時間戳變成一句謊話。
     *
     * 取消勾選時也刻意**不清空**：這個 effect 在 linked 變成 false 之後就什麼都不做，
     * 已經帶進去的值原封不動留在表單裡讓人繼續編輯。清空會讓「不小心點到」變成
     * 「資料沒了」。
     */
  }, [linked, buyerName, buyerEmail, buyerPhone, setValue]);

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
        // 全表單的第一位。i 是攤平陣列的 index，所以這一條同時涵蓋了「不是第一組」
        // 與「不是這一組的第一位」兩種情況。
        const isFirstOverall = i === 0;
        const linkedHere = isFirstOverall && linked;
        return (
          <div
            key={i}
            className="space-y-4 border-t border-border pt-5 first:border-t-0 first:pt-0"
          >
            <p className="eyebrow text-xs text-muted-foreground">
              {t(COPY.seatLabel).replace("{n}", String(offset + 1))}
            </p>

            {isFirstOverall && onSameAsBuyerChange ? (
              <div className="space-y-2">
                {/* 一般的 <label htmlFor>，不是 <FormLabel> —— 這個開關不是表單欄位，
                    它沒有（也不該有）對應的 CheckoutFormValues 路徑，而 <FormLabel>
                    需要 <FormField> 的 context 才 render 得出來。Radix 的 Checkbox
                    Root 是 <button>，而 button 是可被 label 標示的元素，所以點文字
                    一樣切得動。 */}
                <div className="flex items-start gap-3">
                  <Checkbox
                    id={sameAsBuyerId}
                    checked={sameAsBuyer === true}
                    onCheckedChange={(v) => onSameAsBuyerChange(v === true)}
                  />
                  <label
                    htmlFor={sameAsBuyerId}
                    className="cursor-pointer text-sm font-normal leading-relaxed"
                  >
                    {t(COPY.sameAsBuyer)}
                  </label>
                </div>
                {linkedHere ? (
                  <p className="text-xs text-muted-foreground">{t(COPY.sameAsBuyerHint)}</p>
                ) : null}
              </div>
            ) : null}

            <FormField
              control={control}
              name={`participants.${i}.name` as const}
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t(COPY.name)}</FormLabel>
                  <FormControl>
                    {/* readOnly，不是 disabled：唯讀的輸入框仍然對得到焦點、選得起來、
                        讀得到（disabled 會被拿掉 tab 順序，螢幕閱讀器也常常整格跳過），
                        而且值照樣進表單。視覺上換底色是為了讓「這格是被帶入的」看得
                        出來 —— 否則客人會在裡面打字、發現改不動。 */}
                    <Input
                      {...field}
                      value={field.value ?? ""}
                      readOnly={linkedHere}
                      className={linkedHere ? "bg-muted text-muted-foreground" : undefined}
                      autoComplete="off"
                    />
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
                      <Input
                        type="email"
                        {...field}
                        value={field.value ?? ""}
                        readOnly={linkedHere}
                        className={linkedHere ? "bg-muted text-muted-foreground" : undefined}
                        autoComplete="off"
                      />
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
                        readOnly={linkedHere}
                        className={linkedHere ? "bg-muted text-muted-foreground" : undefined}
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

/**
 * 廠商詳情裡的三張子表清單（聯絡人／匯款帳戶／附件）—— 全部唯讀。
 *
 * 從 VendorDetailDialog 抽出來：那個檔案是「重抓資料 ＋ 主檔欄位 ＋ 三張子表」，
 * 主檔那半邊改的是欄位配置，這半邊改的是子表怎麼列，兩件事各自會變動。
 *
 * ⚠️ 匯款帳號**永遠是遮罩**。view 沒有把完整帳號送出來，這裡也不該有捷徑 ——
 *    完整號碼只有 VendorSensitiveDialog 那一條路，而那一條路會留下 pii_access_log。
 *
 * ⚠️ 附件在這裡只列檔名，不給連結。要開檔案得走「編輯 → 附件／合約」，那裡才會去簽
 *    一組短效網址（bucket 是 private，沒有永久網址這種東西）。
 */
import { Badge } from "@/components/ui/badge";
import type {
  AdminVendorAttachment,
  AdminVendorBankAccount,
  AdminVendorContact,
} from "@/server/repos/inv-vendors";

type Props = {
  contacts: AdminVendorContact[];
  bankAccounts: AdminVendorBankAccount[];
  attachments: AdminVendorAttachment[];
};

/** ⚠️ 回傳 Fragment 不是 <div>：這三塊本來就是詳情那個 space-y-4 容器的直接子元素。 */
export function VendorDetailChildLists({ contacts, bankAccounts, attachments }: Props) {
  return (
    <>
      <div className="space-y-2">
        <p className="text-sm font-medium">聯絡人（{contacts.length}）</p>
        {contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground">沒有聯絡人。</p>
        ) : (
          <ul className="space-y-1">
            {contacts.map((c) => (
              <li key={c.contact_id} className="text-sm">
                {c.name}
                {c.job_title ? `（${c.job_title}）` : ""}
                <span className="text-muted-foreground">
                  {" "}
                  {[c.phone, c.mobile, c.email].filter(Boolean).join("・")}
                </span>
                {c.is_primary ? (
                  <Badge variant="secondary" className="ml-1.5 font-normal">
                    主要
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">匯款帳戶（{bankAccounts.length}）</p>
        {bankAccounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">沒有匯款帳戶。</p>
        ) : (
          <ul className="space-y-1">
            {bankAccounts.map((b) => (
              <li key={b.bank_account_id} className="text-sm">
                {b.account_holder_name}・{b.bank_code} {b.bank_name}
                {/* ⚠️ 遮罩。view 沒有把完整帳號送出來，這裡也不該有捷徑。 */}
                <span className="ml-1.5 font-mono text-xs tabular-nums text-muted-foreground">
                  {b.account_number_masked ?? "—"}
                </span>
                {b.is_default ? (
                  <Badge variant="secondary" className="ml-1.5 font-normal">
                    預設
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">附件（{attachments.length}）</p>
        {attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground">沒有附件。</p>
        ) : (
          <ul className="space-y-1">
            {attachments.map((a) => (
              <li key={a.attachment_id} className="text-sm">
                {a.file_name}
                {a.attachment_type === "contract" ? (
                  <span className="text-muted-foreground">
                    （合約 {a.contract_start_date ?? "—"} ~ {a.contract_end_date ?? "—"}）
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          要開檔案請到「編輯 → 附件／合約」，那裡才會去簽一組短效網址（私有 bucket 沒有永久網址）。
        </p>
      </div>
    </>
  );
}

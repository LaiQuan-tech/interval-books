/**
 * 廠商表單最上面那一塊：標題與那句「儲存之後會怎樣」。
 *
 * 從 VendorFormDialog 抽出來（原檔 2,353 行，元件檔的上限是 300）。
 *
 * ⚠️ 三句描述對應三種情境：編輯（不改審核狀態）、新增且需要審核、新增且不需要審核。
 *    approvalOn 是**站台設定**讀回來的，不是這個人的權限 —— 誰能核准由 server fn 的
 *    requirePermission() 決定，這裡只負責把「存下去會發生什麼」講清楚。
 */
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AdminVendorRow } from "@/server/repos/inv-vendors";

type Props = {
  /** null = 新增。 */
  editing: AdminVendorRow | null;
  approvalOn: boolean;
};

export function VendorFormHeader({ editing, approvalOn }: Props) {
  return (
    <DialogHeader>
      <DialogTitle className="text-base">
        {editing ? `編輯廠商：${editing.name}` : "新增廠商"}
      </DialogTitle>
      <DialogDescription>
        {editing
          ? `${editing.vendor_code ?? "（未編號）"}・編輯不會改變審核狀態。`
          : approvalOn
            ? "廠商目前需要審核：儲存之後會進入待審核，核准後才能開始往來。"
            : "廠商目前不需要審核，儲存後即可開始往來。"}
      </DialogDescription>
    </DialogHeader>
  );
}

/**
 * 三張子表（聯絡人／匯款帳戶／附件）在「還沒有 vendor_id」時顯示的那一塊。
 *
 * ⚠️ 子表要先有廠商才能存 —— 它們都是掛在 vendor_id 底下的獨立 RPC，新增模式下還沒有
 *    id。這比先在前端存一份草稿再一次送出好：草稿送出到一半失敗的話，使用者看不出來
 *    哪幾筆存進去了。
 */
import type { ReactNode } from "react";

export function ChildPlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * 清單分頁。
 *
 * 分頁本身在資料庫端（見 repos/inv-products.ts 的 range()），這裡只負責換頁碼。
 * 來源系統把 993 筆整份載進瀏覽器然後在前端排序，所以它根本沒有分頁 —— 也因此
 * 它每一次寫入都要重抓整張表。
 */
import { Button } from "@/components/ui/button";

type Props = {
  page: number;
  totalPages: number;
  disabled: boolean;
  onPageChange: (page: number) => void;
};

export function ProductPagination({ page, totalPages, disabled, onPageChange }: Props) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">
        第 {page + 1} / {totalPages} 頁
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || page === 0}
          onClick={() => onPageChange(page - 1)}
        >
          上一頁
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || page + 1 >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          下一頁
        </Button>
      </div>
    </div>
  );
}

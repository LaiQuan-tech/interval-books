/**
 * Excel 匯入的第二步：確認欄位對應。
 *
 * 自動對應（lib/admin/excel-import.ts 的 autoMapColumns）猜得再準，也一定要有人
 * 看過才寫進資料庫 —— 猜錯的代價是 1,000 筆商品的售價欄變成了進貨價欄，而那件事
 * 在匯入完成之後看不出來。所以這一步不能跳過，即使九個欄位全部都猜中了。
 */
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FIELD_LABELS, UNMAPPED, type ColumnMapping } from "@/lib/admin/excel-import";

type Props = {
  headers: string[];
  rawRows: unknown[][];
  mapping: ColumnMapping;
  onMappingChange: (next: ColumnMapping) => void;
};

export function ExcelMappingStep({ headers, rawRows, mapping, onMappingChange }: Props) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {(Object.keys(FIELD_LABELS) as (keyof ColumnMapping)[]).map((field) => (
          <div key={field} className="space-y-1.5">
            <Label className="text-xs">{FIELD_LABELS[field]}</Label>
            <Select
              value={mapping[field]}
              onValueChange={(v) => onMappingChange({ ...mapping, [field]: v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNMAPPED}>不匯入</SelectItem>
                {headers.map((h, i) => (
                  <SelectItem key={`${h}-${i}`} value={String(i)}>
                    {h || `欄位 ${i + 1}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {headers.map((h, i) => (
                <TableHead key={`${h}-${i}`} className="whitespace-nowrap text-xs">
                  {h || `欄位 ${i + 1}`}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rawRows.slice(0, 5).map((row, ri) => (
              <TableRow key={ri}>
                {headers.map((_, ci) => (
                  <TableCell key={ci} className="whitespace-nowrap text-xs">
                    {String(row[ci] ?? "")}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">共 {rawRows.length} 列資料（上面是前 5 列）</p>
    </div>
  );
}

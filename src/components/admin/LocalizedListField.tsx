/**
 * 「一行一項」的三語清單欄位 —— 三個 textarea，一行一項，最後存成
 * jsonb {"zh":[…],"en":[…],"ja":[…]}。
 *
 * ── 為什麼是 LocalizedField 的兄弟，不是它多一個 prop ──────────────────────
 * 這個元件與 LocalizedField 長得很像，但它多做三件事，而那三件事 LocalizedField
 * 一件都不需要：
 *   1. 中文框要**即時顯示行數** —— 一行一項的東西，「現在幾項」是編輯時唯一重要的
 *      數字，而單行標題沒有這個概念。
 *   2. 打翻譯 API 之前要**先量長度**。清單一次送的是整篇（40 行 × 200 字），很容易
 *      撞到 2000 字上限；單行標題永遠撞不到。
 *   3. 翻譯回來要**比對行數**。三個陣列是靠索引對齊的，中文 6 行配英文 5 行等於
 *      前台少一項；單行標題沒有「行」可以對不齊。
 *
 * 把這三件事塞成 LocalizedField 的 `list` 開關，等於讓那個元件的每一條路徑都多背
 * 一個它用不到的模式 —— 而 LocalizedField 現在守著全站幾十個欄位。所以：兄弟。
 *
 * ── 失敗行為刻意鏡射 LocalizedField.tsx:64-120 ────────────────────────────
 *   · 翻譯**失敗就什麼都不寫**，不寫一半。空白擋得住儲存，而且看得見。
 *   · 英日只要有一個是空的，下面那個 Collapsible 就拒絕摺疊 —— 摺疊不可以藏住
 *     正在擋住儲存的那件事。
 *
 * ── 這一版多守一條：行數不一致也拒絕摺疊 ─────────────────────────────────
 * 🔴 5 行英文配 6 行中文安安靜靜上線，正是這套程式碼反覆點名的失敗類型。所以行數
 *    對不上的時候：**照樣把翻譯寫進去**（人要看得到模型回了什麼才改得動），但跳
 *    警告、把英日區攤開、而且在對齊之前不准收起來。
 *
 * 必須放在 react-hook-form 的 <Form {...form}>（FormProvider）裡：control /
 * getValues / setValue 都從 context 拿，呼叫端只要給 name。
 */
import { useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { ChevronDown, Copy, Languages, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  LIST_MAX_ITEMS,
  LIST_MAX_ITEM_CHARS,
  TRANSLATE_MAX_CHARS,
  listToLines,
  splitLines,
} from "@/lib/admin/localized-list";

type LocalizedListFieldProps = {
  /** 值是 {zh, en, ja} 三個「一行一項」字串的欄位路徑，例如 "highlights"。 */
  name: string;
  label: string;
  rows?: number;
  /** 提示文字，例如「一行一項，最多 40 項」以外還想補充的東西。 */
  hint?: string;
  /** 三個語言全空是合法的（代表這個活動沒有這一段）。只有填一半才是錯。 */
  optional?: boolean;
};

export function LocalizedListField({
  name,
  label,
  rows = 6,
  hint,
  optional = false,
}: LocalizedListFieldProps) {
  const { control, getValues, setValue } = useFormContext();
  const zh = useWatch({ control, name: `${name}.zh` }) as string | undefined;
  const en = useWatch({ control, name: `${name}.en` }) as string | undefined;
  const ja = useWatch({ control, name: `${name}.ja` }) as string | undefined;

  // splitLines 刻意不會丟錯，所以超過上限的當下畫面顯示得出「你打了 45 行」——
  // 那個數字才是人需要看到的東西。真正的攔截在 linesToList()／zod 那一層。
  const zhLines = splitLines(zh ?? "");
  const enLines = splitLines(en ?? "");
  const jaLines = splitLines(ja ?? "");

  const anyLanguageMissing = enLines.length === 0 || jaLines.length === 0;
  const missing = optional ? zhLines.length > 0 && anyLanguageMissing : anyLanguageMissing;

  // 三個語言都有東西、但行數對不上 —— 索引對齊的三個陣列一旦長度不同，前台就會少
  // 一項或多一項。這個狀態必須是看得見的，不可以被摺疊藏起來。
  const mismatched =
    zhLines.length > 0 &&
    !anyLanguageMissing &&
    (enLines.length !== zhLines.length || jaLines.length !== zhLines.length);

  const [manuallyOpen, setManuallyOpen] = useState(false);
  const [translating, setTranslating] = useState(false);
  const open = missing || mismatched || manuallyOpen;

  const zhChars = listToLines(zhLines).length;
  const overItems = zhLines.length > LIST_MAX_ITEMS;
  const overCharsLine = zhLines.findIndex((line) => line.length > LIST_MAX_ITEM_CHARS);

  function handleCopyToEnJa() {
    const text = listToLines(splitLines((getValues(`${name}.zh`) as string | undefined) ?? ""));
    setValue(`${name}.en`, text, { shouldDirty: true, shouldValidate: true });
    setValue(`${name}.ja`, text, { shouldDirty: true, shouldValidate: true });
    setManuallyOpen(true);
  }

  /**
   * 中文 → Gemini → 英日兩格。
   *
   * ⚠️ 送出去的是**正規化過**的中文（listToLines(splitLines(…))），不是 textarea 的
   *    原始字串。CRLF、行首行尾空白、中間的空行都先清掉 —— 否則模型收到的行數與我們
   *    等一下要拿來比對的行數本來就不一樣，那個比對就沒有意義了。
   *
   * ⚠️ 三道 pre-flight 都在打 API **之前**：行數上限、單行字數上限、整篇 2000 字
   *    上限。三個都是 server fn 那端也會擋的東西（translateSchema），先在這裡量的
   *    理由是省一次來回，而且錯誤訊息說得出「第幾行」。
   */
  async function handleAutoTranslate() {
    const source = splitLines((getValues(`${name}.zh`) as string | undefined) ?? "");
    if (source.length === 0) {
      toast.warning("請先填中文，再按自動翻譯");
      return;
    }
    if (source.length > LIST_MAX_ITEMS) {
      toast.error(
        `${label}：共 ${source.length} 行，超過上限 ${LIST_MAX_ITEMS} 行。請先刪到 ${LIST_MAX_ITEMS} 行以內再翻譯。`,
      );
      return;
    }
    const longLine = source.findIndex((line) => line.length > LIST_MAX_ITEM_CHARS);
    if (longLine >= 0) {
      toast.error(
        `${label}：第 ${longLine + 1} 行（共 ${source.length} 行）有 ${source[longLine].length} 個字，超過單項上限 ${LIST_MAX_ITEM_CHARS} 字。`,
      );
      return;
    }
    const payload = listToLines(source);
    if (payload.length > TRANSLATE_MAX_CHARS) {
      toast.error(
        `${label}：整篇共 ${payload.length} 字，超過一次翻譯的 ${TRANSLATE_MAX_CHARS} 字上限。請分兩次貼、或把句子縮短。`,
      );
      return;
    }

    // 先攤開再送出。翻譯進行中與失敗之後，那兩個框都必須是看得見的。
    setManuallyOpen(true);
    setTranslating(true);
    try {
      const { translateToEnJa } = await import("@/lib/admin/fns/translate");
      const result = await translateToEnJa({ data: { text: payload } });
      // ⚠️ 翻譯失敗**不會 throw**，是一個 ok:false（見 fns/translate.ts 的檔頭）。
      //    這個分支到 return 之間**一個 setValue 都不准有** —— 寫進半套翻譯比留白更糟。
      if (!result.ok) {
        toast.error(result.message);
        return;
      }

      const enResult = splitLines(result.data.en);
      const jaResult = splitLines(result.data.ja);
      setValue(`${name}.en`, listToLines(enResult), { shouldDirty: true, shouldValidate: true });
      setValue(`${name}.ja`, listToLines(jaResult), { shouldDirty: true, shouldValidate: true });

      // 🔴 行數比對。模型很容易把兩個短句合成一行、或把一個分號拆成兩行 —— 寫進去了
      //    但長度不一樣，就是「前台會少一項」。照樣寫（人要看得到才改得動），但一定
      //    要跳警告，而且強制把英日攤開。
      if (enResult.length !== source.length || jaResult.length !== source.length) {
        setManuallyOpen(true);
        toast.warning(
          `${label}：行數對不上 —— 中文 ${source.length} 行，英文 ${enResult.length} 行、日文 ${jaResult.length} 行。已經填進去了，請自己對齊再送出。`,
        );
        return;
      }
      toast.success(`${label}：英日文已填入 ${source.length} 行，送出前請確認`);
    } catch (err) {
      // 走到這裡的是授權被擋或伺服器設定錯誤（例如缺 GEMINI_API_KEY）—— 兩者都不是
      // 「翻譯結果不好」，但都不該變成一個沒有人接的 unhandled rejection。
      const message = err instanceof Error ? err.message : String(err);
      toast.error(message || "自動翻譯失敗，請自己填寫英日文。");
    } finally {
      setTranslating(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <FormField
        control={control}
        name={`${name}.zh`}
        render={({ field }) => (
          <FormItem>
            <FormLabel>{label}（中文）</FormLabel>
            <FormControl>
              <Textarea rows={rows} {...field} />
            </FormControl>
            <FormDescription>
              一行一項，空行會自動忽略；最多 {LIST_MAX_ITEMS} 項，每項最多 {LIST_MAX_ITEM_CHARS}{" "}
              字。
              {hint ? ` ${hint}` : ""}
            </FormDescription>
            <p
              className={
                overItems || overCharsLine >= 0
                  ? "text-xs font-medium text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              目前 {zhLines.length} 行 · {zhChars} 字
              {overItems ? `（超過 ${LIST_MAX_ITEMS} 項上限，請自己刪，系統不會替你截斷）` : ""}
              {overCharsLine >= 0
                ? `（第 ${overCharsLine + 1} 行超過 ${LIST_MAX_ITEM_CHARS} 字）`
                : ""}
            </p>
            <FormMessage />
          </FormItem>
        )}
      />

      <Collapsible
        open={open}
        onOpenChange={(next) => {
          // 少了一個語言、或行數對不上的時候拒絕摺疊 —— 那正是唯一需要被看見的東西。
          if ((missing || mismatched) && !next) return;
          setManuallyOpen(next);
        }}
        className="rounded-md bg-muted/40 px-3 py-2"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto gap-1.5 px-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
              />
              {label}（英文／日文{optional ? "" : " — 必填"}）
            </Button>
          </CollapsibleTrigger>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto gap-1.5 px-2 py-1 text-xs"
              onClick={handleAutoTranslate}
              disabled={translating || zhLines.length === 0}
            >
              {translating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Languages className="h-3.5 w-3.5" />
              )}
              {translating ? "翻譯中…" : "自動翻譯"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-auto gap-1.5 px-2 py-1 text-xs"
              onClick={handleCopyToEnJa}
              disabled={translating}
            >
              <Copy className="h-3.5 w-3.5" />
              複製中文到英日
            </Button>
          </div>
        </div>
        {mismatched ? (
          <p className="mt-2 text-xs font-medium text-destructive">
            行數對不上：中文 {zhLines.length} 行、英文 {enLines.length} 行、日文 {jaLines.length}{" "}
            行。三個語言是靠順序對齊的，對不上的那幾項前台會缺。
          </p>
        ) : null}
        <CollapsibleContent className="mt-3 space-y-3">
          <FormField
            control={control}
            name={`${name}.en`}
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {label}（英文 — {enLines.length} 行）
                </FormLabel>
                <FormControl>
                  <Textarea rows={rows} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={control}
            name={`${name}.ja`}
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {label}（日文 — {jaLines.length} 行）
                </FormLabel>
                <FormControl>
                  <Textarea rows={rows} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

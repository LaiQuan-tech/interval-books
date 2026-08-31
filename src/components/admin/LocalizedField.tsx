/**
 * Three-language input for a jsonb {zh, en, ja} column.
 *
 * The DB's is_localized() CHECK (supabase/migrations/0001_init.sql:56-68)
 * requires all three keys, so this is never "zh required, en/ja optional" —
 * all three are mandatory. English and Japanese are collapsed by default to
 * keep the common case (editing the Chinese copy) uncluttered, but the
 * collapsed header says so explicitly, and the section refuses to stay
 * collapsed while either value is empty — collapsing it must never hide the
 * one thing blocking save.
 *
 * Must be rendered inside a react-hook-form <Form {...form}> (FormProvider):
 * it reads control/getValues/setValue from context rather than taking them
 * as props, so `name` is the only thing callers need to supply.
 *
 * ── 自動翻譯是填空幫手，不是送出管線 ──────────────────────────────────────
 * 「自動翻譯」只是「複製中文到英日」旁邊的第二顆按鈕，架構一個字都沒動。這個決定
 * 把大部分失敗模式直接消掉：
 *   · 翻譯發生在**按按鈕的當下**，不是按送出的當下。送出時才發現翻譯壞掉是最糟的
 *     時機 —— 那時人已經填完整張表準備離開了。
 *   · API 掛了／逾時／回的不是合法 JSON → 跳 toast，兩個框**維持空白而且攤開著**
 *     （英日只要有一個空的，下面那個 Collapsible 本來就拒絕摺疊）。人看得見、可以
 *     自己打、可以按旁邊那顆複製。沒有隱形失敗。
 *   · 翻完照樣能改 —— 那三個框本來就一直在。
 */
import { useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { ChevronDown, Copy, Languages, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";

type LocalizedFieldProps = {
  /** Base field path whose value is a {zh, en, ja} object, e.g. "title". */
  name: string;
  label: string;
  /** Use a <Textarea> instead of <Input> for all three languages. */
  multiline?: boolean;
  rows?: number;
  /**
   * Set for nullable jsonb columns (og_title, header_intro, …), where leaving
   * all three languages blank is valid and means "don't override the default".
   * Only a *partial* fill is an error there, so the header drops the 必填
   * wording and the section only force-opens once Chinese has content.
   */
  optional?: boolean;
};

export function LocalizedField({
  name,
  label,
  multiline = false,
  rows = 3,
  optional = false,
}: LocalizedFieldProps) {
  const { control, getValues, setValue } = useFormContext();
  const zh = useWatch({ control, name: `${name}.zh` }) as string | undefined;
  const en = useWatch({ control, name: `${name}.en` }) as string | undefined;
  const ja = useWatch({ control, name: `${name}.ja` }) as string | undefined;

  const anyLanguageMissing = !en?.trim() || !ja?.trim();
  // An optional field that is entirely blank is fine; it only becomes a problem
  // once Chinese is filled in and the other two are not.
  const missing = optional ? Boolean(zh?.trim()) && anyLanguageMissing : anyLanguageMissing;
  const [manuallyOpen, setManuallyOpen] = useState(false);
  const [translating, setTranslating] = useState(false);
  const open = missing || manuallyOpen;

  function handleCopyToEnJa() {
    const zh = ((getValues(`${name}.zh`) as string | undefined) ?? "").trim();
    setValue(`${name}.en`, zh, { shouldDirty: true, shouldValidate: true });
    setValue(`${name}.ja`, zh, { shouldDirty: true, shouldValidate: true });
    setManuallyOpen(true);
  }

  /**
   * 中文 → Gemini → 英日兩格。
   *
   * ⚠️ 中文是空的就**不打 API**。那不是翻譯失敗，是還沒填中文 —— 花一次額度去問
   *    模型「請翻譯空字串」沒有意義，而且拿回來的東西一定是垃圾。
   *
   * ⚠️ 失敗時**什麼都不寫**。維持空白比寫進半套翻譯好：資料庫的 is_localized()
   *    只檢查三個 key 存不存在，空字串完全過得了 CHECK，然後前台就渲染出一塊
   *    沒有人會收到告警的空白。空著至少擋得住儲存，而且看得見。
   */
  async function handleAutoTranslate() {
    const zh = ((getValues(`${name}.zh`) as string | undefined) ?? "").trim();
    if (!zh) {
      toast.warning("請先填中文，再按自動翻譯");
      return;
    }

    // 先攤開再送出。翻譯進行中與失敗之後，那兩個框都必須是看得見的 —— 使用者要能
    // 直接接手自己打，而不是先去找哪裡可以展開。
    setManuallyOpen(true);
    setTranslating(true);
    try {
      const { translateToEnJa } = await import("@/lib/admin/fns/translate");
      const result = await translateToEnJa({ data: { text: zh } });
      // ⚠️ 翻譯失敗**不會 throw**，是一個 ok:false（見 fns/translate.ts 的檔頭）。
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      setValue(`${name}.en`, result.data.en, { shouldDirty: true, shouldValidate: true });
      setValue(`${name}.ja`, result.data.ja, { shouldDirty: true, shouldValidate: true });
      toast.success(`${label}：英日文已填入，送出前請確認`);
    } catch (err) {
      // 走到這裡的是授權被擋（店員在 staff 頁面按了這顆）或伺服器設定錯誤
      // （例如缺 GEMINI_API_KEY）—— 兩者都不是「翻譯結果不好」，但都不該變成
      // 一個沒有人接的 unhandled rejection。
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
              {multiline ? <Textarea rows={rows} {...field} /> : <Input {...field} />}
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <Collapsible
        open={open}
        onOpenChange={(next) => {
          // Refuse to collapse while a required language is still empty —
          // that would hide the only thing blocking save.
          if (missing && !next) return;
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
              disabled={translating || !zh?.trim()}
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
        <CollapsibleContent className="mt-3 space-y-3">
          <FormField
            control={control}
            name={`${name}.en`}
            render={({ field }) => (
              <FormItem>
                <FormLabel>{label}（英文）</FormLabel>
                <FormControl>
                  {multiline ? <Textarea rows={rows} {...field} /> : <Input {...field} />}
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
                <FormLabel>{label}（日文）</FormLabel>
                <FormControl>
                  {multiline ? <Textarea rows={rows} {...field} /> : <Input {...field} />}
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

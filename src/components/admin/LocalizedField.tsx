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
 */
import { useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { ChevronDown, Copy } from "lucide-react";
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
};

export function LocalizedField({ name, label, multiline = false, rows = 3 }: LocalizedFieldProps) {
  const { control, getValues, setValue } = useFormContext();
  const en = useWatch({ control, name: `${name}.en` }) as string | undefined;
  const ja = useWatch({ control, name: `${name}.ja` }) as string | undefined;

  const missing = !en?.trim() || !ja?.trim();
  const [manuallyOpen, setManuallyOpen] = useState(false);
  const open = missing || manuallyOpen;

  function handleCopyToEnJa() {
    const zh = ((getValues(`${name}.zh`) as string | undefined) ?? "").trim();
    setValue(`${name}.en`, zh, { shouldDirty: true, shouldValidate: true });
    setValue(`${name}.ja`, zh, { shouldDirty: true, shouldValidate: true });
    setManuallyOpen(true);
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
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
              {label}（英文／日文 — 必填）
            </Button>
          </CollapsibleTrigger>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-auto gap-1.5 px-2 py-1 text-xs"
            onClick={handleCopyToEnJa}
          >
            <Copy className="h-3.5 w-3.5" />
            複製中文到英日
          </Button>
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

"use client";
/**
 * 可搜索多选（skill §4：不平铺几十个复选框）：触发按钮（计数）+ Popover 里的 Command 搜索列表 + 已选 chip。
 * 作为 FormField 的子元素时，id / aria-describedby / aria-invalid 落到触发按钮上。
 * 资产选择（/agent/new、/start）与资金币种选择（/plan）共用。
 */
import { useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface MultiOption { value: string; label: string; hint?: string; disabled?: boolean; keywords?: string }

export function MultiSelect({ options, value, onChange, max, copy, disabled, id, "aria-describedby": describedBy, "aria-invalid": invalid, className }: {
  options: MultiOption[];
  value: string[];
  onChange: (next: string[]) => void;
  max?: number;
  copy: { placeholder: string; search: string; none: string; selected: string; remove: string; full?: string };
  disabled?: boolean;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const isOn = (v: string) => value.some((x) => eq(x, v));
  const full = max !== undefined && value.length >= max;
  const labelOf = (v: string) => options.find((o) => eq(o.value, v))?.label ?? null;
  const toggle = (v: string) => {
    if (isOn(v)) onChange(value.filter((x) => !eq(x, v)));
    else if (!full) onChange([...value, v]);
  };
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled} className="w-full justify-between font-normal sm:w-80">
            <span className="truncate text-fg-2">{copy.placeholder}</span>
            <span className="ml-auto flex items-center gap-2 text-xs text-fg-3 tabular-nums">{max !== undefined ? `${value.length} / ${max}` : value.length}<ChevronsUpDown className="size-4" aria-hidden="true" /></span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-72 p-0">
          <Command>
            <CommandInput placeholder={copy.search} aria-label={copy.search} />
            <CommandList>
              <CommandEmpty>{copy.none}</CommandEmpty>
              <CommandGroup>
                {options.map((o) => {
                  const on = isOn(o.value);
                  return (
                    <CommandItem key={o.value} value={`${o.label} ${o.hint ?? ""} ${o.keywords ?? ""} ${o.value}`} disabled={o.disabled || (!on && full)} onSelect={() => toggle(o.value)} aria-selected={on}>
                      <Check className={cn("size-4", on ? "text-brand-400 opacity-100" : "opacity-0")} aria-hidden="true" />
                      <span className="font-medium text-fg-1" translate="no">{o.label}</span>
                      {o.hint ? <span className="ml-auto text-xs text-fg-3" translate="no">{o.hint}</span> : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
            {full && copy.full ? <p className="border-t px-3 py-2 text-xs text-fg-3">{copy.full}</p> : null}
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={copy.selected}>
          {value.map((v) => (
            <li key={v}>
              <span className="inline-flex h-7 items-center gap-1 rounded-sm border border-line-strong bg-surface-2 pr-1 pl-2 text-sm text-fg-1">
                <span translate="no" className={cn(!labelOf(v) && "text-bad")}>{labelOf(v) ?? `…${v.slice(-6)}`}</span>
                <Button type="button" variant="ghost" size="icon-xs" disabled={disabled} onClick={() => toggle(v)} aria-label={`${copy.remove} ${labelOf(v) ?? v.slice(-6)}`}>
                  <X aria-hidden="true" />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

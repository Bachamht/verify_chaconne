"use client";
/**
 * 股票多选（/agent/new、/start）：kit MultiSelect，选项来自资产登记表（显示股票名 + 代码，不露合约地址）。
 * 作为 FormField 的子元素：id / aria-describedby / aria-invalid 透传到触发按钮。
 */
import { MultiSelect } from "@/components/kit/MultiSelect";
import type { AssetEntry } from "@/lib/assets";
import { useI18n } from "@/lib/i18n";
import { tf } from "./copy";
import { MAX_ASSETS } from "./model";

const ticker = (a: AssetEntry) => a.underlyingId?.split(":")[1] ?? "";

export function AssetPicker({ options, value, onChange, disabled, id, "aria-describedby": describedBy, "aria-invalid": invalid }: {
  options: AssetEntry[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const { locale } = useI18n();
  return (
    <MultiSelect
      id={id}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      disabled={disabled}
      max={MAX_ASSETS}
      options={options.map((a) => ({ value: a.assetKey, label: a.displaySymbol, hint: ticker(a) }))}
      value={value}
      onChange={onChange}
      copy={{ placeholder: tf(locale, "assets_pick"), search: tf(locale, "assets_search"), none: tf(locale, "assets_none"), selected: tf(locale, "assets_selected"), remove: tf(locale, "assets_remove"), full: tf(locale, "assets_full") }}
    />
  );
}

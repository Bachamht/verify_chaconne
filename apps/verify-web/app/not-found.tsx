"use client";
/** X-01 / UV-05：深色双语 404，与所有空状态同一版式。 */
import { useI18n } from "@/lib/i18n";
import { EmptyState } from "@/components/ui";
import { NotFoundV8 } from "@/components/features/public/StatusPages";

export default function NotFound() {
  if (process.env.NEXT_PUBLIC_V8_UI === "1") return <NotFoundV8 />;
  return <LegacyNotFound />;
}

function LegacyNotFound() {
  const { t } = useI18n();
  return <EmptyState code="404" title={t("nf_h")} description={t("nf_p")} primary={{ href: "/", label: t("nf_home") }} secondary={{ href: "/me", label: t("nav_me") }} />;
}

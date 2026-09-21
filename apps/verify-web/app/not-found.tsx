"use client";
/** X-01 / UV-05：深色双语 404，与所有空状态同一版式。 */
import { useI18n } from "@/lib/i18n";
import { EmptyState } from "@/components/ui";

export default function NotFound() {
  const { t } = useI18n();
  return <EmptyState code="404" title={t("nf_h")} description={t("nf_p")} primary={{ href: "/", label: t("nf_home") }} secondary={{ href: "/me", label: t("nav_me") }} />;
}

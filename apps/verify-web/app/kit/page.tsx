import { notFound } from "next/navigation";
import { V8_UI } from "@/lib/v8";
import { KitchenSink } from "@/components/kitchen/KitchenSink";

/** v8 视觉验收页（方案 §7 阶段 1-5）：所有 kit 组件四态摆一遍。只在 v8 构建里存在 */
export default function KitPage() {
  if (!V8_UI) notFound();
  return <KitchenSink />;
}

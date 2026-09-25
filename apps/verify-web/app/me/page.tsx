import { redirect } from "next/navigation";

/** 批次 7：「我的记录」并入「我的任务与记录」 */
export default function MePage() {
  redirect("/agent/tasks");
}

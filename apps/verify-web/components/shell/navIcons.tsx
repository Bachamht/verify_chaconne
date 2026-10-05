import {
  ArrowUpRight, CalendarClock, CodeXml, Coins, BriefcaseBusiness, FlaskConical, KeyRound, LayoutDashboard, ListChecks,
  NotebookPen, PackageCheck, Plus, Radio, Rewind, Rocket, Route, ShieldCheck, Wrench, type LucideIcon,
} from "lucide-react";
import type { NavIcon } from "@/lib/nav";

export const NAV_ICONS: Record<NavIcon, LucideIcon> = {
  today: LayoutDashboard,
  new: Plus,
  tasks: ListChecks,
  events: CalendarClock,
  funds: Coins,
  journal: NotebookPen,
  lab: FlaskConical,
  keys: KeyRound,
  developers: CodeXml,
  tools: Wrench,
  verify: ShieldCheck,
  plan: Route,
  bundle: PackageCheck,
  live: Radio,
  replay: Rewind,
  start: Rocket,
  workspace: BriefcaseBusiness,
  markets: ArrowUpRight,
};

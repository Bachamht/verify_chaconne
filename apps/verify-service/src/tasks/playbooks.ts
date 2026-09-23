/** 模板目录加载（config/playbooks.json，版本化）：启动时校验；不合法拒绝启动。 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePlaybookCatalog, type PlaybookCatalog, type PlaybookDefinition, type PlaybookId } from "@chaconne/core/verify";

export const DEFAULT_PLAYBOOKS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config", "playbooks.json");

export function loadPlaybooks(file: string = DEFAULT_PLAYBOOKS_FILE): PlaybookCatalog {
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  const v = validatePlaybookCatalog(raw);
  if (!v.ok) throw new Error(`playbooks.json 校验失败：${v.errors.join("；")}`);
  return v.catalog;
}

export function playbookOf(catalog: PlaybookCatalog, id: PlaybookId): PlaybookDefinition {
  const def = catalog.playbooks[id];
  if (!def) throw new Error(`unknown playbook ${id}`);
  return def;
}

/** 对外目录（GET /v1/playbooks）：不含内部模板语法 */
export function playbookCatalogView(catalog: PlaybookCatalog) {
  return {
    version: catalog.version,
    playbooks: Object.values(catalog.playbooks).map((p) => ({ id: p.id, name: p.name, description: p.description, side: p.side, implementedBy: p.implementedBy, params: p.params, requiredConditionTypes: p.requiredConditionTypes, simulationAllowed: p.simulationAllowed, defaultConditions: p.conditions })),
  };
}

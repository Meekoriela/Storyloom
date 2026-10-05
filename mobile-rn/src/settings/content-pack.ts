/**
 * 自制内容包：把 Storyloom 自带的写作方法与用户自己创建的规则 / 技能 / 智能体
 * 导出为 JSON，并在另一台设备上导入。
 *
 * 导出范围：
 * - 用户自建（`source === "custom"`）—— 导出它们才是内容包的本意；
 * - **Storyloom 自带的**那批（id 以 `storyloom-skill--` / `storyloom-agent--` 开头）——
 *   它们是本项目的代码，随应用分发，导出无许可问题。少了这一批，包里只有三个空数组，
 *   拿到手是空的。
 *
 * 排除的是上游内容：插件、远程包、基础内容包里除 Storyloom 之外的条目 —— 那些是别人的东西，
 * 导出它们有重新分发的许可风险。
 *
 * 导入策略：同 id 覆盖、其余保留；导入前列出冲突项，由调用方确认后再写入。
 * Storyloom 自带的那批在导入时**跳过**：对方的应用本来也自带一份，写进去会变成重复条目。
 */
import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import {
  getAgentDefinitions,
  getAgentRules,
  getAgentSkills,
  saveAgentDefinitions,
  saveAgentRules,
  saveAgentSkills,
  type AgentDefinition,
  type AgentRule,
  type AgentSkill,
} from "@/settings/config";

const PACK_FORMAT = "storyloom-content-pack";
const PACK_VERSION = 1;

/** Storyloom 自带那批的 id 前缀；它们随应用分发，导入时跳过。 */
const STORYLOOM_SKILL_PREFIX = "storyloom-skill--";
const STORYLOOM_AGENT_PREFIX = "storyloom-agent--";

function isStoryloomBuiltinId(id: string): boolean {
  return id.startsWith(STORYLOOM_SKILL_PREFIX) || id.startsWith(STORYLOOM_AGENT_PREFIX);
}

export interface ContentPack {
  format: typeof PACK_FORMAT;
  version: number;
  exportedAt: string;
  rules: AgentRule[];
  skills: AgentSkill[];
  agents: AgentDefinition[];
}

export interface ContentPackSummary {
  count: number;
  sizeBytes: number;
}

export interface ContentPackPreview {
  pack: ContentPack;
  /** 与本地同 id 的条目数，用于提示用户"导入会覆盖这些" */
  conflicts: number;
  /** 包里带的 Storyloom 自带条目数：这些导入时跳过（对方应用本来也有）。 */
  builtinSkipped: number;
}

/**
 * 打包内容并调起系统分享。
 *
 * 判空放在写盘与分享**之前**：先前是先写文件、先弹分享面板，再由调用方判空，于是用户在
 * 分享面板里打开文件看到的是三个空数组，关掉面板才看到提示 —— 看起来像导出坏了。
 */
export async function exportContentPack(title: string): Promise<ContentPackSummary> {
  const [rules, skills, agents] = await Promise.all([getAgentRules(), getAgentSkills(), getAgentDefinitions()]);
  const customRules = rules.filter((item) => item.id.startsWith("custom") || !isBuiltinId(item.id));
  // 自建 + Storyloom 自带：只排除插件、远程与上游内容包里那部分。
  const exportableSkills = skills.filter((item) => item.source === "custom" || item.source === "builtin");
  const exportableAgents = agents.filter((item) => item.source === "custom" || item.source === "builtin");
  // 上游基础内容包的条目 id 不带 Storyloom 前缀，剔除它们，只留自带那批。
  const customSkills = exportableSkills.filter((item) => item.source === "custom" || isStoryloomBuiltinId(item.id));
  const customAgents = exportableAgents.filter((item) => item.source === "custom" || isStoryloomBuiltinId(item.id));

  const pack: ContentPack = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    exportedAt: new Date().toISOString(),
    rules: customRules,
    skills: customSkills,
    agents: customAgents,
  };
  const count = pack.rules.length + pack.skills.length + pack.agents.length;
  if (count === 0) return { count: 0, sizeBytes: 0 };

  const payload = JSON.stringify(pack, null, 2);

  const directory = new Directory(Paths.cache, "content-packs");
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, `${safeFileName(title)}.json`);
  if (file.exists) file.delete();
  file.write(payload);

  if (!(await Sharing.isAvailableAsync())) throw new Error("当前设备不支持系统分享，请稍后重试");
  await Sharing.shareAsync(file.uri, { mimeType: "application/json", dialogTitle: "导出内容包" });
  return { count, sizeBytes: payload.length };
}

/** 选择内容包文件；取消时返回 null。 */
export async function pickContentPack(): Promise<File | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true, multiple: false });
  if (result.canceled) return null;
  return new File(result.assets[0].uri);
}

/** 解析内容包，返回内容与冲突数；不写入任何数据。 */
export async function previewContentPack(source: File): Promise<ContentPackPreview> {
  const pack = parseContentPack(await source.text());
  const [rules, skills, agents] = await Promise.all([getAgentRules(), getAgentSkills(), getAgentDefinitions()]);
  const conflicts = pack.rules.filter((item) => rules.some((local) => local.id === item.id)).length
    + pack.skills.filter((item) => skills.some((local) => local.id === item.id)).length
    + pack.agents.filter((item) => agents.some((local) => local.id === item.id)).length;
  const builtinSkipped = pack.skills.filter((item) => isStoryloomBuiltinId(item.id)).length
    + pack.agents.filter((item) => isStoryloomBuiltinId(item.id)).length;
  return { pack, conflicts, builtinSkipped };
}

/**
 * 写入内容包：同 id 覆盖，其余保留。
 *
 * Storyloom 自带的那批先剔除再合并 —— 它们的 id 已在托管集合里（`saveAgentSkills` 对托管 id
 * 只写 `{ id, enabled }`），写进去会把 `instructions` 丢掉；而对方应用本来也自带一份，
 * 正确做法是跳过。
 */
export async function applyContentPack(pack: ContentPack): Promise<ContentPackSummary> {
  const [rules, skills, agents] = await Promise.all([getAgentRules(), getAgentSkills(), getAgentDefinitions()]);
  const incomingRules = pack.rules.filter((item) => !isStoryloomBuiltinId(item.id));
  const incomingSkills = pack.skills.filter((item) => !isStoryloomBuiltinId(item.id));
  const incomingAgents = pack.agents.filter((item) => !isStoryloomBuiltinId(item.id));
  await saveAgentRules(mergeById(rules, incomingRules));
  await saveAgentSkills(mergeById(skills, incomingSkills));
  await saveAgentDefinitions(mergeById(agents, incomingAgents));
  return { count: incomingRules.length + incomingSkills.length + incomingAgents.length, sizeBytes: 0 };
}

function mergeById<T extends { id: string }>(local: T[], incoming: T[]): T[] {
  const map = new Map(local.map((item) => [item.id, item]));
  for (const item of incoming) map.set(item.id, item);
  return [...map.values()];
}

function parseContentPack(text: string): ContentPack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("无法解析该文件，请选择由「导出内容包」生成的 JSON 文件");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("该文件不是有效的 Storyloom 内容包");
  const record = parsed as Partial<ContentPack>;
  if (record.format !== PACK_FORMAT) throw new Error("该文件不是 Storyloom 内容包（缺少格式标识）");
  if (record.version !== PACK_VERSION) throw new Error("内容包版本不兼容，无法导入");
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    exportedAt: typeof record.exportedAt === "string" ? record.exportedAt : "",
    rules: Array.isArray(record.rules) ? record.rules : [],
    skills: Array.isArray(record.skills) ? record.skills : [],
    agents: Array.isArray(record.agents) ? record.agents : [],
  };
}

/** 内置条目的 id 都有统一前缀（builtin / plugin / remote / oh-story 等），据此排除。 */
function isBuiltinId(id: string): boolean {
  return /^(builtin|plugin|remote|oh-story|lorn|openficm|storyloom-agent--)/i.test(id);
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "storyloom-content-pack";
}

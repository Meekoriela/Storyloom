// 本文件基于 OpenFicM（Apache-2.0）修改
// 改动说明见仓库根目录 docs/上游来源与改动清单.md
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, BackHandler, FlatList, Pressable, StyleSheet, Text, View } from "react-native";

import { BottomSheet, Button, ConfirmDialog, ErrorNotice, Field, Header, NoticeToast, PlainScrollView, ScalePress, Screen, useNotice } from "@/components/ui";
import {
  deleteProvider,
  getProviderApiKey,
  getSetting,
  listModels,
  listProviders,
  saveModel,
  saveProvider,
  setSetting,
  dedupeProvidersAndModels,
} from "@/data/repositories";
import { fetchProviderModels, type RemoteModel } from "@/llm/model-catalog";
import { DEFAULT_MAX_OUTPUT_TOKENS, MAX_CONFIGURED_OUTPUT_TOKENS } from "@/llm/limits";
import {
  DEFAULT_PROVIDER_ADVANCED,
  getProviderAdvanced,
  hasCustomAdvanced,
  saveProviderAdvanced,
  type ProviderAdvanced,
} from "@/llm/provider-advanced";
import type { RootStackParamList } from "@/navigation/types";
import { SettingsCategoryScreen, SettingRow, ToggleRow, type SettingsCategory } from "@/screens/settings-category-screen";
import { guessModelCapabilities } from "@/settings/model-capabilities";
import { CONTEXT_WINDOW_KEY } from "@/agent/context-usage";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing, themedStyles } from "@/theme";
import type { Model, Provider, ProviderType } from "@/types";
import { FreeModelsScreen } from "@/screens/free-models-screen";

/**
 * 请求超时的合法区间与默认值，与 `llm/client.ts` 读取这项设置时的口径一致：
 * 超出区间的值会被静默改回默认值，所以这里先拦住，别让界面显示的和实际生效的对不上。
 */
const REQUEST_TIMEOUT_MIN = 10_000;
const REQUEST_TIMEOUT_MAX = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = "120000";

/**
 * 要人拿主意的动作（删除、清理这类）走居中确认卡。
 * 与写作页、助手页用的是同一个 `ConfirmDialog`，所以三处观感一致。
 */
type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  danger?: boolean;
};

const providerDefaults: Record<ProviderType, { name: string; url: string }> = {
  "openai-compatible": { name: "OpenAI Compatible", url: "https://api.openai.com/v1" },
  "google-genai": { name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1beta" },
  anthropic: { name: "Anthropic", url: "https://api.anthropic.com/v1" },
};

/**
 * 常用服务商预设：点一下自动填好「显示名称 + Base URL」。
 * 用户只需要去对应站点注册、生成一个 API Key 粘进来即可，不用自己查地址和格式。
 * 这些厂商都提供 OpenAI 兼容接口，所以统一走 openai-compatible 档。
 */
const PROVIDER_PRESETS: Array<{
  id: string;
  label: string;
  name: string;
  url: string;
  modelHint: string;
}> = [
  // 免费额度与免费模型的说明统一由「免费模型」分类页负责，此处只做地址预设。
  { id: "zhipu", label: "智谱", name: "智谱", url: "https://open.bigmodel.cn/api/paas/v4", modelHint: "glm-4.7-flash" },
  { id: "siliconflow", label: "硅基流动", name: "硅基流动", url: "https://api.siliconflow.cn/v1", modelHint: "Qwen/Qwen2.5-7B-Instruct" },
  { id: "openrouter", label: "OpenRouter", name: "OpenRouter", url: "https://openrouter.ai/api/v1", modelHint: "openrouter/free" },
  { id: "dashscope", label: "通义千问", name: "阿里云百炼", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", modelHint: "qwen-turbo" },
  { id: "deepseek", label: "DeepSeek", name: "DeepSeek", url: "https://api.deepseek.com/v1", modelHint: "deepseek-chat" },
  { id: "moonshot", label: "Kimi", name: "月之暗面", url: "https://api.moonshot.cn/v1", modelHint: "moonshot-v1-8k" },
  { id: "custom", label: "中转站 / 自定义", name: "", url: "", modelHint: "" },
];

/**
 * 供应商行第二行显示「协议 + 域名」。
 *
 * 只留域名会看成 `openbigmodel.cn` 这种连在一起的写法，认不出是哪家；地址里本来的
 * 协议头因此一并留下。各家后面的路径长短差得多，一起显示会被行宽截成一条断、一条全。
 *
 * 协议不写死为 https：用户填的地址可以是 http（本机 ollama、局域网中转都是），
 * 校验放行的也是 http 与 https 两种，这里照原样显示。
 */
function siteOf(url: string): string {
  const matched = url.match(/^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]+)/i);
  if (!matched) return url;
  return `${matched[1] ?? ""}${matched[2]}`;
}

/**
 * 设置分组：14 个入口按职能分成 5 组，避免平铺一长串。
 * 入口只显示名称，不写说明——说明统一放在二级页顶部，保持列表一致与清爽。
 */
const settingsGroups: Array<{
  title: string;
  hint?: string;
  items: Array<{
    id: SettingsCategory;
    label: string;
    icon: keyof typeof Ionicons.glyphMap;
  }>;
}> = [
  {
    title: "基础",
    items: [
      { id: "editor", label: "编辑器", icon: "text-outline" },
      { id: "appearance", label: "外观", icon: "contrast-outline" },
      { id: "mascot", label: "吉祥物", icon: "paw-outline" },
    ],
  },
  {
    title: "连接与模型",
    items: [
      { id: "models", label: "模型", icon: "hardware-chip-outline" },
      { id: "free-models", label: "免费模型", icon: "gift-outline" },
      { id: "model-capabilities", label: "模型能力", icon: "speedometer-outline" },
      { id: "conv-advanced", label: "请求超时", icon: "time-outline" },
    ],
  },
  {
    title: "创作系统",
    items: [
      { id: "agents", label: "智能体", icon: "git-network-outline" },
      { id: "skills", label: "技能", icon: "flash-outline" },
      { id: "rules", label: "规则", icon: "list-outline" },
      { id: "agent-tools", label: "工具权限", icon: "shield-checkmark-outline" },
      { id: "style", label: "作者文风", icon: "color-wand-outline" },
    ],
  },
  {
    title: "知识",
    items: [
      { id: "index", label: "索引", icon: "layers-outline" },
      { id: "resources", label: "可选内容", icon: "cloud-download-outline" },
    ],
  },
  {
    title: "系统",
    items: [
      { id: "advanced", label: "高级", icon: "construct-outline" },
    ],
  },
];

/**
 * 中转站 / 自建网关的兼容设置表单。新建供应商和编辑已有供应商共用这一份。
 */
function AdvancedFields({ value, onChange }: { value: ProviderAdvanced; onChange: (next: ProviderAdvanced) => void }) {
  const toggle = (key: "disableTools" | "useMaxCompletionTokens") => {
    onChange({ ...value, [key]: !value[key] });
  };
  return (
    <View style={styles.advancedGroup}>
      <Field
        label="额外请求头（每行一条「名字: 值」，# 开头是注释）"
        value={value.extraHeaders}
        onChangeText={(text) => onChange({ ...value, extraHeaders: text })}
        placeholder={"HTTP-Referer: https://example.com\nX-Title: Storyloom"}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />
      <Field
        label="鉴权请求头名字"
        value={value.authHeader}
        onChangeText={(text) => onChange({ ...value, authHeader: text })}
        placeholder="Authorization"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        label="鉴权前缀（留空＝直接发原始 Key）"
        value={value.authPrefix}
        onChangeText={(text) => onChange({ ...value, authPrefix: text })}
        placeholder="Bearer "
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable onPress={() => toggle("disableTools")} style={[styles.toggleRow, value.disableTools && styles.toggleRowOn]}>
        <Ionicons
          name={value.disableTools ? "checkbox" : "square-outline"}
          size={20}
          color={value.disableTools ? colors.primary : colors.textMuted}
        />
        <Text style={styles.toggleText}>不发送 tools（极少数中转站不支持 function calling 时才需要）</Text>
      </Pressable>
      <Pressable onPress={() => toggle("useMaxCompletionTokens")} style={[styles.toggleRow, value.useMaxCompletionTokens && styles.toggleRowOn]}>
        <Ionicons
          name={value.useMaxCompletionTokens ? "checkbox" : "square-outline"}
          size={20}
          color={value.useMaxCompletionTokens ? colors.primary : colors.textMuted}
        />
        <Text style={styles.toggleText}>用 max_completion_tokens 代替 max_tokens</Text>
      </Pressable>
    </View>
  );
}

export function SettingsScreen() {
  const rootNavigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const revision = useAppStore((state) => state.dataRevision);
  const refreshData = useAppStore((state) => state.refreshData);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [providerType, setProviderType] = useState<ProviderType>("openai-compatible");
  const [presetId, setPresetId] = useState("custom");
  const [providerName, setProviderName] = useState(providerDefaults["openai-compatible"].name);
  const [baseUrl, setBaseUrl] = useState(providerDefaults["openai-compatible"].url);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  // 模型能力页那颗「保存」单独一个标志位：勾选入库那条路（addModel）用的是 savingModel，
  // 两处共用一个会让"正在勾选入库"时这颗保存也跟着转圈并禁用。
  const [savingCapability, setSavingCapability] = useState(false);
  const [fetchingProviderId, setFetchingProviderId] = useState<string | null>(null);
  const [modelsView, setModelsView] = useState<"home" | "addProvider">("home");
  const [addStep, setAddStep] = useState(1);
  const [convSheetModel, setConvSheetModel] = useState<Model | null>(null);
  const [convScope, setConvScope] = useState<"model" | "global">("model");
  const [convHistory, setConvHistory] = useState("30");
  const [convWindow, setConvWindow] = useState("32768");
  const [convCompress, setConvCompress] = useState(false);
  const [capExpandedId, setCapExpandedId] = useState<string | null>(null);
  const [capDraft, setCapDraft] = useState({ temperature: "0.8", maxTokens: "4096", supportsTools: true, supportsVision: false });
  const [requestTimeout, setRequestTimeout] = useState("60000");
  const [modelPickerProvider, setModelPickerProvider] = useState<Provider | null>(null);
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>([]);
  const [modelFilter, setModelFilter] = useState("");
  /** 正在落库的那一行（按远端模型 id）：行内转圈用。 */
  const [addingModelId, setAddingModelId] = useState<string | null>(null);
  /** 本次列表里已经加进来的远端模型 id：面板不关，用来把该行换成对勾。 */
  const [addedModelIds, setAddedModelIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory | null>(null);
  const [newAdvanced, setNewAdvanced] = useState<ProviderAdvanced>({ ...DEFAULT_PROVIDER_ADVANCED });
  const [showNewAdvanced, setShowNewAdvanced] = useState(false);
  const [advancedTarget, setAdvancedTarget] = useState<Provider | null>(null);
  const [advancedDraft, setAdvancedDraft] = useState<ProviderAdvanced>({ ...DEFAULT_PROVIDER_ADVANCED });
  const [advancedFlags, setAdvancedFlags] = useState<Record<string, boolean>>({});
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [notice, showNotice] = useNotice();

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextProviders, nextModels, selected, savedTimeout] = await Promise.all([
        listProviders(),
        listModels(),
        getSetting("activeModelId"),
        getSetting("connections.requestTimeout"),
      ]);
      setProviders(nextProviders);
      setModels(nextModels);
      // 请求超时这一页显示的就是这个值：不读库的话每次进来都是初始的默认值，
      // 用户在外面改过也看不出来，按钮存了什么更是无从确认。
      setRequestTimeout(savedTimeout ?? DEFAULT_REQUEST_TIMEOUT_MS);
      const validSelected = selected && nextModels.some((model) => model.id === selected) ? selected : null;
      setActiveModelId(validSelected);
      if (selected && !validSelected) await setSetting("activeModelId", "");
      const flags = await Promise.all(nextProviders.map(async (provider) => [
        provider.id,
        hasCustomAdvanced(await getProviderAdvanced(provider.id)),
      ] as const));
      setAdvancedFlags(Object.fromEntries(flags));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load, revision]));

  const modelsByProvider = useMemo(() => new Map(providers.map((provider) => [
    provider.id,
    models.filter((model) => model.providerId === provider.id),
  ])), [providers, models]);

  const provNameOf = (id: string) => providers.find((p) => p.id === id)?.name ?? "?";

  const chooseType = (type: ProviderType) => {
    setProviderType(type);
    setProviderName(providerDefaults[type].name);
    setBaseUrl(providerDefaults[type].url);
    setPresetId("custom");
    setNewAdvanced({ ...DEFAULT_PROVIDER_ADVANCED });
    setShowNewAdvanced(false);
  };

  /** 套用常用服务商预设：自动填好类型、名称与地址，用户只需粘贴 API Key。 */
  const applyPreset = (preset: (typeof PROVIDER_PRESETS)[number]) => {
    setPresetId(preset.id);
    setProviderType("openai-compatible");
    setProviderName(preset.name);
    setBaseUrl(preset.url);
    setNewAdvanced({ ...DEFAULT_PROVIDER_ADVANCED });
    setShowNewAdvanced(false);
  };

  const addProvider = async () => {
    if (!providerName.trim() || !baseUrl.trim() || !apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const provider = await saveProvider({ name: providerName, type: providerType, baseUrl, apiKey });
      const customized = hasCustomAdvanced(newAdvanced);
      if (customized) await saveProviderAdvanced(provider.id, newAdvanced);
      setAdvancedFlags((current) => ({ ...current, [provider.id]: customized }));
      setNewAdvanced({ ...DEFAULT_PROVIDER_ADVANCED });
      setShowNewAdvanced(false);
      setApiKey("");
      refreshData();
      // 保存成功要让"页面自己变了"：退回模型页 + 顶部报一次结果。
      // 原来停在第③步一动不动，用户只能看见按钮转完恢复原样。
      setModelsView("home");
      setAddStep(1);
      showNotice(`已添加供应商「${provider.name}」`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally { setSaving(false); }
  };

  /**
   * 把拉取回来的一个远端模型存成本地模型。
   *
   * 供应商与模型信息都由调用方传入（来自「获取模型」列表）—— 本函数不再读表单状态，
   * 因为那张"手动输入模型"的表单从来没有做出来过，原来的 addModel 没有任何入口调用。
   * 温度、输出上限与能力开关用默认值，和「免费模型」页一致，之后可以在「模型能力」页改。
   *
   * 返回保存后的模型；失败返回 null（错误已经写进 error 交给页面显示）。
   */
  const addModel = async (input: { providerId: string; name: string; modelId: string }) => {
    if (!input.providerId || !input.name.trim() || !input.modelId.trim()) return null;
    setSavingModel(true);
    setError(null);
    try {
      const model = await saveModel({
        providerId: input.providerId,
        name: input.name,
        modelId: input.modelId,
        temperature: 0.8,
        maxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        supportsTools: guessModelCapabilities(input.modelId).supportsTools,
        supportsVision: guessModelCapabilities(input.modelId).supportsVision,
      });
      // 手上一个模型都没有时，第一个加进来的直接当默认，免得加完还要再点一次。
      if (!activeModelId) {
        await setSetting("activeModelId", model.id);
        setActiveModelId(model.id);
      }
      refreshData();
      return model;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
      return null;
    } finally {
      setSavingModel(false);
    }
  };

  const openAdvancedEditor = async (provider: Provider) => {
    setAdvancedTarget(provider);
    setAdvancedDraft(await getProviderAdvanced(provider.id));
  };

  const saveAdvancedEditor = async () => {
    if (!advancedTarget) return;
    try {
      await saveProviderAdvanced(advancedTarget.id, advancedDraft);
      setAdvancedFlags((current) => ({ ...current, [advancedTarget.id]: hasCustomAdvanced(advancedDraft) }));
      setAdvancedTarget(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    }
  };

  const removeProvider = async (provider: Provider) => {
    try {
      await deleteProvider(provider);
      refreshData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const openConvSheet = async (model: Model) => {
    setConvSheetModel(model);
    setConvScope("model");
    try {
      const overrideRaw = await getSetting(`context.override.${model.id}`);
      let historyValue = "";
      let windowValue = "";
      let compressValue = false;
      if (overrideRaw) {
        try {
          const parsed = JSON.parse(overrideRaw) as { historyLimit?: number; windowTokens?: number };
          if (parsed?.historyLimit) historyValue = String(parsed.historyLimit);
          if (parsed?.windowTokens) windowValue = String(parsed.windowTokens);
        } catch {}
      }
      const [globalHistory, globalWindow, globalCompress] = await Promise.all([
        getSetting("context.historyLimit"),
        getSetting(CONTEXT_WINDOW_KEY),
        getSetting("context.compressSystemPrompts"),
      ]);
      if (!historyValue) historyValue = globalHistory ?? "30";
      if (!windowValue) windowValue = globalWindow ?? "32768";
      compressValue = globalCompress === "true";
      setConvHistory(historyValue);
      setConvWindow(windowValue);
      setConvCompress(compressValue);
    } catch {
      setConvHistory("30"); setConvWindow("32768"); setConvCompress(false);
    }
  };

  /** 显式保存超时：数值超出合法区间时先拦住 —— 存下去也会被 client 静默改回默认值。 */
  const saveRequestTimeout = async () => {
    const parsed = Number(requestTimeout);
    if (!Number.isInteger(parsed) || parsed < REQUEST_TIMEOUT_MIN || parsed > REQUEST_TIMEOUT_MAX) {
      // 越界是用户填错，不是操作失败：页面里那条红色错误条就是给它准备的。
      setError(`请填 ${REQUEST_TIMEOUT_MIN} ~ ${REQUEST_TIMEOUT_MAX} 之间的毫秒数`);
      return;
    }
    setSaving(true);
    try {
      await setSetting("connections.requestTimeout", String(parsed));
      setRequestTimeout(String(parsed));
      showNotice("已保存");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const restoreRequestTimeoutDefault = async () => {
    setSaving(true);
    try {
      await setSetting("connections.requestTimeout", DEFAULT_REQUEST_TIMEOUT_MS);
      setRequestTimeout(DEFAULT_REQUEST_TIMEOUT_MS);
      showNotice("已恢复默认");
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : String(restoreError));
    } finally {
      setSaving(false);
    }
  };

  const selectModel = async (model: Model) => {
    try {
      await setSetting("activeModelId", model.id);
      setActiveModelId(model.id);
      refreshData();
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : String(selectError));
    }
  };

  const fetchRemoteModels = async (provider: Provider) => {
    setFetchingProviderId(provider.id);
    setError(null);
    try {
      const key = await getProviderApiKey(provider);
      const fetched = await fetchProviderModels(provider, key);
      if (!fetched.length) throw new Error("供应商没有返回可用于生成内容的模型");
      setRemoteModels(fetched);
      setModelFilter("");
      // 列表与供应商必须成对更新：面板里的「+」会直接在这个供应商下落库，
      // 一旦列表还留着上一次那家，就会把模型加到错的供应商下面。
      setAddedModelIds([]);
      setModelPickerProvider(provider);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setFetchingProviderId(null);
    }
  };

  /**
   * 勾选一个远端模型 —— 点了就真的落库，面板不关。
   *
   * 原来这里只把名称与 ID 塞进两个表单状态就把面板关掉，既不写库也不提示，所以点
   * 加号"没有任何反应"。面板不关是因为中转站一次返回几十上百个模型，用户往往要连着
   * 挑几个，关一次就得重开一次；已经加过的行会变成对勾，重复点不会重复建。
   */
  const chooseRemoteModel = async (model: RemoteModel) => {
    const provider = modelPickerProvider;
    if (!provider || addingModelId) return;
    const alreadySaved = models.some((saved) => saved.providerId === provider.id && saved.modelId === model.id);
    if (alreadySaved || addedModelIds.includes(model.id)) {
      setAddedModelIds((current) => (current.includes(model.id) ? current : [...current, model.id]));
      return;
    }
    setAddingModelId(model.id);
    const saved = await addModel({ providerId: provider.id, name: model.name, modelId: model.id });
    setAddingModelId(null);
    if (saved) setAddedModelIds((current) => [...current, model.id]);
  };

  // 中转站常常返回几百个模型，按名称和 ID 做不区分大小写的子串过滤。
  const filteredRemoteModels = useMemo(() => {
    const keyword = modelFilter.trim().toLowerCase();
    if (!keyword) return remoteModels;
    return remoteModels.filter((model) => model.name.toLowerCase().includes(keyword)
      || model.id.toLowerCase().includes(keyword));
  }, [modelFilter, remoteModels]);

  // 「作者文风」有独立页面。之前它只是分类页里的一句空壳提示 —— 点了没有任何反应。
  useEffect(() => {
    if (activeCategory !== "style") return;
    setActiveCategory(null);
    rootNavigation.navigate("StyleLibrary");
  }, [activeCategory, rootNavigation]);

  // 离开设置页时收起分类：这样从其它标签页切回设置，看到的是总面板，而不是上次停留的子页。
  useFocusEffect(useCallback(() => () => setActiveCategory(null), []));

  // Android 返回键：在子页时先回到上一级，不直接退出应用或跳走。
  // 添加供应商向导是"模型"页里的一层：手势应当退回模型页。原来一律退到设置总面板，
  // 等于滑一下就跳过整个模型页，和顶栏返回键（Header 的 onBack）的行为对不上。
  useEffect(() => {
    if (!activeCategory) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (activeCategory === "models" && modelsView === "addProvider") {
        setModelsView("home");
        return true;
      }
      setActiveCategory(null);
      return true; // 已处理，阻止默认行为
    });
    return () => subscription.remove();
  }, [activeCategory, modelsView]);

  if (activeCategory === "free-models") {
    return (
      <FreeModelsScreen
        onBack={() => setActiveCategory(null)}
        onSaved={(message) => {
          // 保存成功要让"页面自己变了"：回模型页 + 顶部报一次结果，新模型就在列表里。
          // 原来停在本页，而提示条在页面顶部、早随内容滚出屏幕，等于没提示。
          refreshData();
          setActiveCategory("models");
          showNotice(message);
        }}
      />
    );
  }

  if (activeCategory === "model-capabilities") {
    return (
      <Screen scroll>
        <Header title="模型能力" onBack={() => setActiveCategory(null)} />
        <NoticeToast notice={notice} />
        {models.map((model) => (
          <View key={model.id} style={styles.providerBlock}>
            <Pressable onPress={() => {
              if (capExpandedId === model.id) { setCapExpandedId(null); return; }
              setCapExpandedId(model.id);
              setCapDraft({ temperature: String(model.temperature), maxTokens: String(model.maxTokens), supportsTools: model.supportsTools, supportsVision: model.supportsVision });
            }} style={styles.providerHeader}>
              <View style={styles.providerInfo}>
                <Text style={styles.providerName}>{model.name}</Text>
                <Text style={styles.providerUrl}>{provNameOf(model.providerId)} · {model.modelId}</Text>
              </View>
              <Ionicons name={capExpandedId === model.id ? "chevron-down" : "chevron-forward"} size={18} color={colors.textMuted} />
            </Pressable>
            {capExpandedId === model.id ? (
              <View style={styles.capExpand}>
                <Field label="温度（0 ~ 2，越大越发散；小说创作建议 0.7 ~ 0.9）" value={capDraft.temperature} onChangeText={(v) => setCapDraft({ ...capDraft, temperature: v })} keyboardType="decimal-pad" />
                <Field label={`最大输出 Token 数（1 ~ ${MAX_CONFIGURED_OUTPUT_TOKENS}）`} value={capDraft.maxTokens} onChangeText={(v) => setCapDraft({ ...capDraft, maxTokens: v })} keyboardType="number-pad" />
                <Text style={styles.fieldHint}>单次回复长度，不是上下文窗口；1M 上下文模型保持 {DEFAULT_MAX_OUTPUT_TOKENS} 或按需填写。</Text>
                <ToggleRow label="支持工具调用" value={capDraft.supportsTools} onChange={(value) => setCapDraft({ ...capDraft, supportsTools: value })} />
                <Text style={styles.fieldHint}>关闭后助手只能对话，无法读取或写入作品内容。</Text>
                <ToggleRow label="支持图片输入" value={capDraft.supportsVision} onChange={(value) => setCapDraft({ ...capDraft, supportsVision: value })} />
                <Text style={styles.fieldHint}>当前判断依据：{guessModelCapabilities(model.modelId).reason}</Text>
                <View style={{ marginTop: spacing.sm }}>
                <Button label="按模型名重新推测" variant="secondary" onPress={() => {
                  const guess = guessModelCapabilities(model.modelId);
                  setCapDraft({ ...capDraft, supportsTools: guess.supportsTools, supportsVision: guess.supportsVision });
                }} />
                </View>
                <View style={{ marginTop: spacing.sm }}>
                <Button label="保存" onPress={() => {
                  const parsedTemperature = Number(capDraft.temperature);
                  const parsedMaxTokens = Number(capDraft.maxTokens);
                  if (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 2) { setError("温度必须在 0 到 2 之间"); return; }
                  if (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens < 1 || parsedMaxTokens > MAX_CONFIGURED_OUTPUT_TOKENS) { setError(`最大输出 Token 数必须在 1 到 ${MAX_CONFIGURED_OUTPUT_TOKENS} 之间`); return; }
                  setSavingCapability(true);
                  void saveModel({ ...model, temperature: parsedTemperature, maxTokens: parsedMaxTokens, supportsTools: capDraft.supportsTools, supportsVision: capDraft.supportsVision })
                    .then(() => { refreshData(); showNotice("已保存「" + model.name + "」"); })
                    .catch((saveError) => setError(saveError instanceof Error ? saveError.message : String(saveError)))
                    .finally(() => setSavingCapability(false));
                }} loading={savingCapability} />
                </View>
              </View>
            ) : null}
          </View>
        ))}
        {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
        <View style={{ height: spacing.md }} />
      </Screen>
    );
  }

  if (activeCategory === "conv-advanced") {
    return (
      <Screen scroll>
        <Header title="请求超时" onBack={() => setActiveCategory(null)} />
        <NoticeToast notice={notice} />
        <View style={styles.section}>
          <Field label="模型请求超时（毫秒）" value={requestTimeout} onChangeText={setRequestTimeout} keyboardType="number-pad" />
          <Text style={styles.fieldHint}>请求超过这个时间仍未返回即判定失败。可填 {REQUEST_TIMEOUT_MIN} ~ {REQUEST_TIMEOUT_MAX}，默认 {DEFAULT_REQUEST_TIMEOUT_MS}（2 分钟）。</Text>
          <View style={styles.btnrow}>
            <Button label="保存" onPress={() => void saveRequestTimeout()} loading={saving} />
            <Button label="恢复默认" variant="secondary" onPress={() => void restoreRequestTimeoutDefault()} disabled={saving} />
          </View>
          <Text style={styles.fieldHint}>各供应商的连接与高级设置（请求头、鉴权前缀、是否发送 tools 等）在「模型」页点该供应商右边的齿轮。</Text>
        </View>

        {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
        <View style={{ height: spacing.md }} />
      </Screen>
    );
  }

  const defaultModel = models.find((m) => m.id === activeModelId) ?? null;
  if (activeCategory && activeCategory !== "models") {
    return <SettingsCategoryScreen category={activeCategory} onBack={() => setActiveCategory(null)} />;
  }

  if (!activeCategory) {
    return (
      <Screen scroll>
        <Header title="设置" />
        <View style={styles.categoryList}>
        {settingsGroups.map((group) => (
          <View key={group.title}>
            <View style={styles.groupHeader}>
              <Text style={styles.groupTitle}>{group.title}</Text>
              {group.hint ? <Text style={styles.groupHint}>{group.hint}</Text> : null}
            </View>
            {group.items.map((category) => (
              <Pressable
                key={category.id}
                onPress={() => {
                  if (category.id === "style") rootNavigation.navigate("StyleLibrary");
                  else setActiveCategory(category.id);
                }}
                style={({ pressed }) => [styles.categoryRow, pressed && styles.categoryRowPressed]}
              >
                <View style={styles.categoryIcon}><Ionicons name={category.icon} size={21} color={colors.primary} /></View>
                <View style={styles.categoryTextWrap}>
                  <Text style={styles.categoryLabel}>{category.label}</Text>
                </View>
                <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />
              </Pressable>
            ))}
          </View>
        ))}
        </View>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Header
        title={modelsView === "addProvider" ? "添加供应商" : "模型"}
        onBack={modelsView === "addProvider" ? () => setModelsView("home") : () => setActiveCategory(null)}
        action={
          <View style={styles.providerActions}>
            <Pressable
              accessibilityLabel="清理重复"
              onPress={() => {
                setConfirmRequest({
                  title: "清理重复",
                  message: "合并同名供应商并删除重复模型（优先保留有 API Key 的）。",
                  confirmLabel: "清理",
                  danger: true,
                  onConfirm: () => {
                    void dedupeProvidersAndModels()
                      .then((r) => {
                        refreshData();
                        showNotice(`清理完成：合并供应商 ${r.mergedProviders} 个，删除重复模型 ${r.removedModels} 个`);
                      })
                      .catch((cleanError) => setError(cleanError instanceof Error ? cleanError.message : String(cleanError)));
                  },
                });
              }}
              style={styles.fetchButton}
            >
              <Text style={{ color: colors.primary, fontSize: 13, fontWeight: "600" }}>清理重复</Text>
            </Pressable>
            <ScalePress accessibilityLabel="添加供应商" onPress={() => { setModelsView("addProvider"); setAddStep(1); }} style={styles.iconButton}>
              <Ionicons name="add" size={24} color={colors.primary} />
            </ScalePress>
          </View>
        }
      />
      <NoticeToast notice={notice} />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      {modelsView === "addProvider" ? (
        <View>
          {/* 步骤条只做指示：显示"现在在第几步"，前进一律走每步底部的按钮。
              原来这三格各自 onPress 跳步，跳到第③步会看到一张什么都没填的确认页。 */}
          <View style={styles.segmented}>
            {[1, 2, 3].map((step) => (
              <View key={step} style={[styles.segment, addStep === step && styles.segmentActive]}>
                <Text style={[styles.segmentText, addStep === step && styles.segmentTextActive]}>
                  {step === 1 ? "① 供应商" : step === 2 ? "② 高级设置" : "③ 确认"}
                </Text>
              </View>
            ))}
          </View>
          {addStep === 1 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>常用服务商</Text>
              <Text style={styles.fieldHint}>选择常用服务商可自动填入接口地址。</Text>
              <View style={styles.presetRow}>
                {PROVIDER_PRESETS.map((preset) => (
                  <ScalePress key={preset.id} onPress={() => applyPreset(preset)} style={[styles.presetChip, presetId === preset.id && styles.presetChipActive]}>
                    <Text style={[styles.presetChipText, presetId === preset.id && styles.presetChipTextActive]}>{preset.label}</Text>
                  </ScalePress>
                ))}
              </View>
              <Text style={styles.sectionTitle}>或者手动填</Text>
              <View style={styles.segmented}>
                {(["openai-compatible", "google-genai", "anthropic"] as ProviderType[]).map((type) => (
                  <Pressable key={type} onPress={() => chooseType(type)} style={[styles.segment, providerType === type && styles.segmentActive]}>
                    <Text style={[styles.segmentText, providerType === type && styles.segmentTextActive]}>
                      {type === "openai-compatible" ? "OpenAI" : type === "google-genai" ? "Gemini" : "Anthropic"}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.fieldHint}>OpenAI 为通用接口格式，国内多数厂商与中转服务均兼容此格式，并非特指 OpenAI 官方服务。</Text>
              <Field label="显示名称" value={providerName} onChangeText={setProviderName} />
              <Field label="Base URL" value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" keyboardType="url" />
              <Text style={styles.fieldHint}>接口地址填写至 /v1 或 /v4 层级即可，对话路径由程序自动拼接。</Text>
              <Field label="API Key" value={apiKey} onChangeText={setApiKey} autoCapitalize="none" secureTextEntry />
              <Text style={styles.fieldHint}>密钥仅存于系统安全存储，不会写入数据库。</Text>
              <View style={styles.btnrow}>
                <Button label="下一步" onPress={() => setAddStep(2)} />
              </View>
            </View>
          ) : null}
          {addStep === 2 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>高级设置（中转站 / 自建网关，可跳过）</Text>
              <AdvancedFields value={newAdvanced} onChange={setNewAdvanced} />
              <View style={styles.btnrow}>
                <Button label="上一步" variant="secondary" onPress={() => setAddStep(1)} />
                <Button label="跳过，用默认值" onPress={() => setAddStep(3)} />
              </View>
            </View>
          ) : null}
          {addStep === 3 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>确认</Text>
              <SettingRow label="显示名称" value={providerName} />
              <SettingRow label="Base URL" value={baseUrl} />
              <SettingRow label="API Key" value={apiKey ? "● 已填写" : "○ 未填写"} />
              <View style={styles.btnrow}>
                <Button label="上一步" variant="secondary" onPress={() => setAddStep(2)} disabled={saving} />
                <Button label="保存供应商" onPress={() => void addProvider()} disabled={!providerName.trim() || !baseUrl.trim() || !apiKey.trim()} loading={saving} />
              </View>
              <Text style={styles.fieldHint}>保存后回到模型页，用该供应商行的「获取模型」拉取并勾选要用的模型。</Text>
            </View>
          ) : null}
          <View style={{ height: spacing.md }} />
        </View>
      ) : (
        <View>
          <View style={styles.defaultCard}>
            <Text style={styles.defaultCardLabel}>当前默认模型</Text>
            <Text style={styles.defaultCardName}>{defaultModel ? defaultModel.name : "未选择"}</Text>
            <Text style={styles.defaultCardPro}>{defaultModel ? provNameOf(defaultModel.providerId) + " · 支持 function calling" : "点下方模型行选择默认模型"}</Text>
          </View>
          {providers.map((provider) => (
            <View key={provider.id} style={styles.providerBlock}>
              <View style={styles.providerHeader}>
                <View style={styles.providerInfo}>
                  <Text style={styles.providerName}>{provider.name}</Text>
                  <Text style={styles.providerUrl} numberOfLines={1}>{siteOf(provider.baseUrl)}</Text>
                </View>
                <View style={styles.providerActions}>
                  <Pressable
                    accessibilityLabel="获取模型"
                    disabled={fetchingProviderId !== null}
                    onPress={() => void fetchRemoteModels(provider)}
                    style={styles.fetchButton}
                  >
                    {fetchingProviderId === provider.id
                      ? <ActivityIndicator size="small" color={colors.primary} />
                      : <Ionicons name="cloud-download-outline" size={18} color={colors.primary} />}
                    <Text style={styles.fetchButtonText}>获取模型</Text>
                  </Pressable>
                  <ScalePress
                    accessibilityLabel="高级设置"
                    onPress={() => void openAdvancedEditor(provider)}
                    style={styles.iconButton}
                  >
                    <Ionicons
                      name={advancedFlags[provider.id] ? "options" : "options-outline"}
                      size={18}
                      color={advancedFlags[provider.id] ? colors.primary : colors.textMuted}
                    />
                  </ScalePress>
                  <ScalePress accessibilityLabel="删除供应商" onPress={() => {
                    setConfirmRequest({
                      title: "删除供应商",
                      message: `删除 ${provider.name} 及其全部模型？`,
                      confirmLabel: "删除",
                      danger: true,
                      onConfirm: () => void removeProvider(provider),
                    });
                  }} style={styles.iconButton}><Ionicons name="trash-outline" size={20} color={colors.danger} /></ScalePress>
                </View>
              </View>
              {(modelsByProvider.get(provider.id) ?? []).map((model) => (
                <Pressable
                  key={model.id}
                  onPress={() => void selectModel(model)}
                  onLongPress={() => void openConvSheet(model)}
                  style={styles.modelRow}
                >
                  <Ionicons name={activeModelId === model.id ? "radio-button-on" : "radio-button-off"} size={20} color={activeModelId === model.id ? colors.primary : colors.textMuted} />
                  <View style={styles.modelText}>
                    <Text style={styles.modelName}>{model.name}</Text>
                    <Text style={styles.modelId}>长按设置上下文参数</Text>
                  </View>
                </Pressable>
              ))}
              {/* 这一行与「获取模型」是同一个动作：面板里的列表必须属于这个供应商，
                  否则勾选会把模型加到上一家下面。所以这里直接重新拉一次再打开面板。 */}
              <Pressable accessibilityLabel={`为${provider.name}添加模型`} onPress={() => { void fetchRemoteModels(provider); }} style={styles.addModelRow}>
                {fetchingProviderId === provider.id
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Ionicons name="add-circle-outline" size={18} color={colors.primary} />}
                <Text style={{ color: colors.primary, fontSize: 12.5, fontWeight: "600" }}>添加模型（拉取该供应商的模型列表后勾选）</Text>
              </Pressable>
            </View>
          ))}
          <View style={{ height: spacing.md }} />
        </View>
      )}
      <BottomSheet
        visible={convSheetModel !== null}
        title="对话设置"
        subtitle={convSheetModel ? convSheetModel.name : ""}
        onClose={() => setConvSheetModel(null)}
      >
          <View style={styles.convSheetBody}>
            <View style={styles.segmented}>
              <Pressable onPress={() => setConvScope("model")} style={[styles.segment, convScope === "model" && styles.segmentActive]}>
                <Text style={[styles.segmentText, convScope === "model" && styles.segmentTextActive]}>仅此模型</Text>
              </Pressable>
              <Pressable onPress={() => setConvScope("global")} style={[styles.segment, convScope === "global" && styles.segmentActive]}>
                <Text style={[styles.segmentText, convScope === "global" && styles.segmentTextActive]}>全局默认</Text>
              </Pressable>
            </View>
            <Field label="保留最近消息数（4 ~ 100）" value={convHistory} onChangeText={setConvHistory} keyboardType="number-pad" />
            <Field label="模型上下文窗口（Token，按所用模型填写）" value={convWindow} onChangeText={setConvWindow} keyboardType="number-pad" />
            {convScope === "global" ? (
              <ToggleRow label="压缩系统提示词（全局）" value={convCompress} onChange={(value) => { setConvCompress(value); void setSetting("context.compressSystemPrompts", value ? "true" : "false"); }} />
            ) : (
              <Text style={styles.fieldHint}>压缩系统提示词为全局设置；切到「全局默认」可修改。</Text>
            )}
            <View style={styles.btnrow}>
              {convScope === "model" ? (
                <Button label="恢复默认" variant="secondary" onPress={() => {
                  if (!convSheetModel) return;
                  void setSetting(`context.override.${convSheetModel.id}`, "").then(() => {
                    showNotice("已恢复跟随全局默认");
                    setConvSheetModel(null);
                  });
                }} />
              ) : null}
              <Button label="保存" onPress={() => {
                const parsedHistory = Number(convHistory);
                const parsedWindow = Number(convWindow);
                if (!convSheetModel) return;
                if (convScope === "model") {
                  const override = {
                    historyLimit: Number.isInteger(parsedHistory) && parsedHistory >= 4 && parsedHistory <= 100 ? parsedHistory : null,
                    windowTokens: Number.isInteger(parsedWindow) && parsedWindow > 0 ? parsedWindow : null,
                  };
                  void setSetting(`context.override.${convSheetModel.id}`, JSON.stringify(override)).then(() => {
                    showNotice("已保存（仅此模型生效）");
                    setConvSheetModel(null);
                  });
                } else {
                  void Promise.all([
                    setSetting("context.historyLimit", String(Number.isInteger(parsedHistory) && parsedHistory >= 4 ? parsedHistory : 30)),
                    setSetting(CONTEXT_WINDOW_KEY, String(Number.isInteger(parsedWindow) && parsedWindow > 0 ? parsedWindow : 32768)),
                  ]).then(() => {
                    showNotice("已保存（全局默认）");
                    setConvSheetModel(null);
                  });
                }
              }} />
            </View>
          </View>
        </BottomSheet>
      <BottomSheet
        visible={modelPickerProvider !== null}
        title="选择模型"
        subtitle={modelFilter.trim()
            ? `${filteredRemoteModels.length} / ${remoteModels.length} 个模型`
            : `${remoteModels.length} 个可用模型`}
        onClose={() => setModelPickerProvider(null)}
      >
            <View style={styles.modelFilterWrap}>
              <Field
                label="查找模型"
                value={modelFilter}
                onChangeText={setModelFilter}
                placeholder="输入名称或模型 ID 的一部分"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <FlatList
              style={styles.panelList}
              data={filteredRemoteModels}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={(
                <Text style={styles.modelFilterEmpty}>
                  {remoteModels.length ? `没有匹配“${modelFilter.trim()}”的模型` : "还没有获取到模型列表"}
                </Text>
              )}
              renderItem={({ item }) => {
                // 已经在库里的（含上一次进来加的）也要显示对勾，否则重复点了会以为没成。
                const added = addedModelIds.includes(item.id)
                  || models.some((saved) => saved.providerId === modelPickerProvider?.id && saved.modelId === item.id);
                const busy = addingModelId === item.id;
                return (
                  <Pressable
                    accessibilityLabel={`添加模型 ${item.name}`}
                    accessibilityState={{ disabled: added || busy }}
                    onPress={() => void chooseRemoteModel(item)}
                    disabled={added || busy}
                    style={styles.remoteModelRow}
                  >
                    <View style={styles.modelText}>
                      <Text style={styles.modelName}>{item.name}</Text>
                      <Text style={styles.modelId}>{item.id}</Text>
                    </View>
                    {busy ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : added ? (
                      <Ionicons name="checkmark-circle" size={22} color={colors.primary} />
                    ) : (
                      <Ionicons name="add-circle-outline" size={22} color={colors.primary} />
                    )}
                  </Pressable>
                );
              }}
            />
        </BottomSheet>

      <BottomSheet
        visible={advancedTarget !== null}
        title="高级设置"
        subtitle={advancedTarget ? advancedTarget.name : ""}
        onClose={() => setAdvancedTarget(null)}
      >
            <PlainScrollView
              style={styles.advancedSheetBody}
              contentContainerStyle={styles.advancedSheetContent}
              keyboardShouldPersistTaps="handled"
            >
              <AdvancedFields value={advancedDraft} onChange={setAdvancedDraft} />
              <Button label="保存高级设置" onPress={() => void saveAdvancedEditor()} />
            </PlainScrollView>
        </BottomSheet>

      {/* 先把卡收掉再执行动作：动作里可能开别的弹层，卡片留在上面会挡住新开的那一层。 */}
      <ConfirmDialog
        visible={Boolean(confirmRequest)}
        title={confirmRequest?.title ?? ""}
        message={confirmRequest?.message ?? ""}
        confirmLabel={confirmRequest?.confirmLabel}
        danger={confirmRequest?.danger}
        onClose={() => setConfirmRequest(null)}
        onConfirm={() => {
          const request = confirmRequest;
          setConfirmRequest(null);
          request?.onConfirm();
        }}
      />
    </Screen>
  );
}

const styles = themedStyles((colors, shadow) => StyleSheet.create({
  categoryList: { paddingVertical: spacing.sm },
  groupHeader: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.xs },
  groupTitle: { color: colors.textMuted, fontSize: 13, fontWeight: "700" },
  groupHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: 2 },
  categoryRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  categoryRowPressed: { backgroundColor: colors.surfaceMuted },
  categoryIcon: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.primarySoft },
  categoryTextWrap: { flex: 1 },
  categoryLabel: { color: colors.text, fontSize: 16, fontWeight: "600" },
  section: { padding: spacing.lg, gap: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  errorWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  // 对话设置面板的内容框：面板本体是全宽贴屏幕两边的，内容要自己留左右边距。
  // 元素之间统一由 gap 管，避免散装 children 各贴各的。
  convSheetBody: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  segmented: { flexDirection: "row", padding: 3, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  segment: { flex: 1, minHeight: 38, alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  segmentActive: { backgroundColor: colors.surface },
  segmentText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  segmentTextActive: { color: colors.primary },
  presetRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  presetChip: { minHeight: 36, justifyContent: "center", paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: 999 },
  presetChipActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  presetChipText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  presetChipTextActive: { color: colors.primary },
  advancedToggle: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  advancedToggleText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  advancedGroup: { gap: spacing.md },
  // 弹层里的列表：高度上限由面板给，超出在这里滚。
  panelList: { flexShrink: 1 },
  advancedSheetBody: { flexShrink: 1, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  advancedSheetContent: { gap: spacing.md },
  toggleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  toggleRowOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  toggleText: { flex: 1, color: colors.text, fontSize: 13, lineHeight: 20 },
  defaultCard: { margin: spacing.md, marginBottom: spacing.sm, backgroundColor: colors.primary, borderRadius: radius.lg, padding: spacing.lg },
  defaultCardLabel: { color: "rgba(255,255,255,0.75)", fontSize: 10, letterSpacing: 1, marginBottom: 4 },
  defaultCardName: { color: colors.onPrimary, fontSize: 19, fontWeight: "800" },
  defaultCardPro: { color: "rgba(255,255,255,0.85)", fontSize: 11, marginTop: 3 },
  addModelRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.sm, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  btnrow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm },
  providerBlock: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  capExpand: { paddingTop: spacing.sm, paddingBottom: spacing.md, gap: spacing.sm },
  providerHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  providerActions: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  providerInfo: { flex: 1, minWidth: 0, marginRight: spacing.sm },
  providerName: { color: colors.text, fontSize: 16, fontWeight: "700" },
  providerUrl: { color: colors.textMuted, fontSize: 12, marginTop: 3 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  fetchButton: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.sm },
  fetchButtonText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  modelRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md },
  modelText: { flex: 1 },
  modelName: { color: colors.text, fontSize: 15, fontWeight: "600" },
  modelId: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  fieldHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18, marginTop: -spacing.sm },
  providerChoices: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  choice: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  choiceActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  choiceText: { color: colors.textMuted, fontSize: 13 },
  choiceTextActive: { color: colors.primary, fontWeight: "700" },
  modelFilterWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  modelFilterEmpty: { padding: spacing.lg, color: colors.textMuted, fontSize: 14, lineHeight: 21 },
  remoteModelRow: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
}));

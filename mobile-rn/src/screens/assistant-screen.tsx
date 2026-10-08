// 本文件基于 OpenFicM（Apache-2.0）修改
// 改动说明见仓库根目录 docs/上游来源与改动清单.md
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  ActivityIndicator,
  PanResponder,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import * as Clipboard from "expo-clipboard";
import { mascotSource, normalizeMascotKind } from "@/settings/mascots";

import { AgentRunError, listSelectableSkills, runAgent } from "@/agent/runtime";
import { isDestructiveTool, undoLastWrite, undoLabel, type WritePreview } from "@/agent/write-review";
import {
  attachmentContextBlock,
  MAX_ATTACHMENTS_PER_MESSAGE,
  pickTextAttachment,
  saveAttachmentAsNote,
  type TextAttachment,
} from "@/agent/attachments";
import {
  computeContextUsage,
  CONTEXT_WINDOW_KEY,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  formatUsagePercent,
  normalizeContextWindow,
} from "@/agent/context-usage";
import { editorFontFamily, readChatPrefs } from "@/settings/editor-prefs";
import { AgentQuestionSheet, AgentTraceView } from "@/components/agent-run-view";
import { appendBreadcrumb, appendCrashLog } from "@/lib/crash-log";
import { throttleFrameGap } from "@/lib/debounce";
import { MessageActionBar } from "@/components/message-action-bar";
import { SessionDrawer } from "@/components/session-drawer";
import { AdaptiveScroll, BottomSheet, Button, ConfirmDialog, EmptyState, ErrorNotice, Header, PlainScrollView, PromptDialog, ScalePress, Screen, TopSheet } from "@/components/ui";
import {
  addMessage,
  createChatSession,
  deleteChatSession,
  deleteProject,
  ensureScratchProject,
  listProjects,
  deleteMessagesFrom,
  getProject,
  getProviderApiKey,
  getSetting,
  listChatSessions,
  listMessages,
  listModels,
  listProviders,
  replaceUserMessageBranch,
  setSetting,
  updateChatSession,
  updateProjectInfo,
} from "@/data/repositories";
import {
  getActiveStyleProfile,
  listStyleProfiles,
  setActiveStyleProfile,
} from "@/data/style-repositories";
import type { RootTabParamList } from "@/navigation/types";
import { TOOL_CATALOG, getAgentDefinitions, getWriteApproval, saveWriteApproval, type AgentDefinition, type WriteApprovalMode } from "@/settings/config";
import { useAppStore } from "@/store/app-store";
import { colors, radius, shadow, spacing, themedStyles } from "@/theme";
import { useAppearance } from "@/theme-context";
import type {
  AgentClarificationRequest,
  AgentClarificationResponse,
  AgentRunTrace,
  ChatMessage,
  ChatSession,
  Model,
  ModelSelection,
  Project,
  Provider,
  StyleProfile,
} from "@/types";

/**
 * 工具授权。写入类工具先展示「改前 / 改后」，按一整组接受或驳回——
 * 逐行确认在长正文上不现实，整组粒度才看得清一次改动动了什么。
 */
type WriteCardRequest = {
  /** 本次请求的唯一标识：确认卡只认自己那一次请求的令牌，避免过期请求落盘。 */
  requestToken: number;
  name: string;
  target?: string;
  before?: string;
  after?: string;
  /** 只有一句动作说明、没有逐行正文可比时为真，界面据此不渲染差异。 */
  actionOnly?: boolean;
  details?: string;
  resolve: (ok: boolean) => void;
};

/**
 * 居中确认卡的内容。
 *
 * 除工具调用授权（那一处是阻塞式的，仍是系统弹窗）外，助手页的确认与告知统一走这张卡，
 * 尺寸与颜色与写作页那张一致。
 */
type ConfirmRequest = {
  title: string;
  message: string;
  /** 不传即纯告知，只剩一颗「知道了」。 */
  confirmLabel?: string;
  onConfirm?: () => void;
  danger?: boolean;
  extraLabel?: string;
  onExtra?: () => void;
};

/** 红绿行统计：after 有而 before 没有的行计新增，反之计删除。 */
function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return sameDay ? `${hh}:${mm}` : `${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
}

function diffLineStats(before: string, after: string): { added: number; removed: number } {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const pool = new Map<string, number>();
  beforeLines.forEach((line) => pool.set(line, (pool.get(line) ?? 0) + 1));
  let added = 0;
  afterLines.forEach((line) => {
    const remain = pool.get(line) ?? 0;
    if (remain > 0) pool.set(line, remain - 1); else added += 1;
  });
  const pool2 = new Map<string, number>();
  afterLines.forEach((line) => pool2.set(line, (pool2.get(line) ?? 0) + 1));
  let removed = 0;
  beforeLines.forEach((line) => {
    const remain = pool2.get(line) ?? 0;
    if (remain > 0) pool2.set(line, remain - 1); else removed += 1;
  });
  return { added, removed };
}

/**
 * 请求一次写入确认。
 *
 * 🔴 弹卡接口此前是模块顶层的全局变量，多条消息并发时后者会覆盖前者，前一次请求
 * 的 resolve 永远悬空。改为由 `send` 通过参数传入当前请求自己的回调，并把
 * `requestToken` 带在卡上 —— 用户在确认期间切换对话或取消后，卡片上的令牌就与
 * 当前请求不符，两颗按钮会拒绝 resolve，不会把已经作废的改动写进作品。
 */
/** 写入审批方式的两档。说明行讲清这一档会怎么做，不带警示语气。 */
const APPROVAL_MODES: Array<{ id: WriteApprovalMode; label: string; hint: string }> = [
  { id: "ask", label: "请求批准", hint: "写入前展示改动内容，确认后写入文件。" },
  { id: "auto", label: "替我审批", hint: "跳过确认卡直接写入，写入后可撤销。" },
];

function requestToolApproval(
  emit: (req: WriteCardRequest) => void,
  requestToken: number,
  name: string,
  args: Record<string, unknown>,
  preview: WritePreview | null,
  mode: WriteApprovalMode,
): Promise<boolean> {
  // 替我审批：跳过的是"等你点这一下"，不是记录 —— 预览与撤销快照在本函数被调用
  // 之前就已备好，自动放行时同样入撤销栈。删除类例外：掉了的东西撤不回来。
  if (mode === "auto" && !isDestructiveTool(name)) return Promise.resolve(true);
  if (!preview) {
    const details = JSON.stringify(args, null, 2).slice(0, 1_200);
    // 一律交给写入审批卡呈现（emitWriteCard 由本页定义，恒可用）。
    // 此前这里还有一条系统弹窗的兜底分支，条件是 emit 为空 —— 唯一调用点
    // 永远传 emitWriteCard，那条分支走不到、从未弹过，已删。
    return new Promise((resolve) => {
      emit({ requestToken, name, details, resolve });
    });
  }
  const before = preview.before.trim() || "（当前为空）";
  const after = preview.after.trim() || "（将清空）";
  return new Promise((resolve) => {
    if (emit) emit({
      requestToken,
      name,
      target: preview.target,
      before,
      after,
      ...(preview.actionOnly ? { actionOnly: true } : {}),
      resolve,
    });
    else resolve(false);
  });
}

function activeSessionSettingKey(projectId: string): string {
  return `assistant.activeSession.${projectId}`;
}

/** 作品级智能体。留空表示这部作品跟随设置里的全局默认智能体。 */
function activeAgentSettingKey(projectId: string): string {
  return `assistant.activeAgent.${projectId}`;
}

/** Plan 只规划不动笔：它出的那条消息下方多一颗「按这个计划开工」。 */
const PLAN_AGENT_ID = "builtin-agent--plan";
/** 跑动中的临时行：实时轨迹与流式正文挂在它身上，占列表最新那一端的位置。 */
const STREAMING_ROW_ID = "__streaming__";
/** 长按菜单的固定尺寸：宽照参考实测 175；高 = 3 行 × 45 ＋ 卡内上下内边距 8。 */
const MESSAGE_MENU_WIDTH = 175;
const MESSAGE_MENU_HEIGHT = 143;

function generatedSessionTitle(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 24) || "新对话";
}

async function resolveSelection(
  modelId: string | null,
  models: Model[],
  providers: Provider[],
): Promise<ModelSelection | null> {
  if (!modelId) return null;
  const model = models.find((item) => item.id === modelId);
  if (!model) return null;
  const provider = providers.find((item) => item.id === model.providerId);
  if (!provider) return null;
  const apiKey = await getProviderApiKey(provider);
  if (!apiKey) throw new Error(`${provider.name} 没有可用的 API Key，请到设置页重新保存`);
  return { provider, model, apiKey };
}

/** 输入框「技能」面板里点选的一条技能；面板与 chip 只用这三个字段。 */
type PickedSkill = { id: string; name: string; description: string };

type RetryRequest = {
  sessionId: string;
  userMessage: ChatMessage;
  history: ChatMessage[];
  sourceMessageId: string;
  modelId: string;
  agentId: string | null;
};

function humanizeAgentError(error: unknown): { message: string; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();
  if (/sslhandshake|ssl handshake|certificate|connection closed/.test(normalized)) {
    return { message: "网络连接异常（SSL 握手失败），请检查网络环境或供应商配置后重试", detail };
  }
  if (/timeout|timed out|aborterror|请求超时/.test(normalized)) {
    return { message: "模型请求超时，请检查网络或供应商配置后重试", detail };
  }
  if (/fetch failed|network request failed|unable to connect|cannot connect/.test(normalized)) {
    return { message: "网络连接异常，请检查网络、Base URL 和证书设置后重试", detail };
  }
  if (/\bhttp\s*400\b|\b400\s*:/.test(normalized)) {
    return { message: "供应商拒绝了本次请求（400），请检查模型工具调用兼容性后重试", detail };
  }
  if (/\bhttp\s*429\b|\b429\s*:/.test(normalized)) {
    return { message: "供应商暂时限流（429），请稍后重试或更换模型", detail };
  }
  return { message: detail, detail };
}

function retryRequestForMessage(
  message: ChatMessage,
  messages: ChatMessage[],
  session: ChatSession | null,
  selection: ModelSelection | null,
  agentId: string | null,
): RetryRequest | null {
  if (!session || message.role !== "assistant") return null;
  const messageIndex = messages.findIndex((item) => item.id === message.id);
  if (messageIndex < 0) return null;
  const context = message.metadata?.retryContext;
  const userIndex = context
    ? messages.findIndex((item) => item.id === context.userMessageId && item.role === "user")
    : messages.slice(0, messageIndex).map((item) => item.role).lastIndexOf("user");
  if (userIndex < 0 || userIndex >= messageIndex) return null;
  const userMessage = messages[userIndex];
  return {
    sessionId: session.id,
    userMessage,
    history: messages.slice(0, userIndex + 1),
    sourceMessageId: message.id,
    modelId: context?.modelId ?? selection?.model.id ?? "",
    agentId: context?.agentId ?? agentId,
  };
}

/** 消息正文的样式入参：字号与行高随「阅读偏好」档位变。 */
type ChatTextStyle = { fontSize: number; lineHeight: number; fontFamily?: string };

/**
 * 单条消息的渲染单元。
 *
 * 抽成独立组件并做浅比较，是为了让流式刷新只重画正在变的那条：实时轨迹每 40ms 提交一次，
 * 消息项若仍内联在列表里渲染，每次提交都会把整屏历史重跑一遍 —— 会话越长越明显。
 * 因此入参里不含 `messages` 数组，重试参数由外部按 id 预算好传进来；三个回调也由外部用
 * useCallback 固定引用，否则函数身份一变，浅比较就失去意义。
 */
const MessageRow = memo(function MessageRow({
  item,
  retry,
  sending,
  chatTextStyle,
  onLongPress,
  onMeasureRow,
  onRetry,
  onStartPlan,
}: {
  item: ChatMessage;
  retry: RetryRequest | null;
  sending: boolean;
  chatTextStyle: ChatTextStyle;
  /** offsetY 是按压点在这条消息内的纵向位置：由它反推消息的上边缘，菜单再贴着下边缘落。 */
  onLongPress: (id: string, pageX: number, pageY: number, offsetY: number) => void;
  onMeasureRow: (id: string, height: number) => void;
  onRetry: (retry: RetryRequest) => void;
  onStartPlan: () => void;
}) {
  const failed = item.role === "assistant"
    && (item.metadata?.taskStatus === "failed" || item.metadata?.agentTrace?.status === "error");
  const isPlan = item.metadata?.agentTrace?.primaryAgentId === PLAN_AGENT_ID;
  return (
    <View>
      <Pressable
        // 长按出操作菜单只对用户消息开放；卡片贴在这条消息的下边缘，点空白处收起。
        onLayout={(event) => onMeasureRow(item.id, event.nativeEvent.layout.height)}
        onLongPress={item.role === "user"
          ? (event) => onLongPress(item.id, event.nativeEvent.pageX, event.nativeEvent.pageY, event.nativeEvent.locationY)
          : undefined}
        style={[styles.message, item.role === "user" ? styles.userMessage : styles.assistantMessage]}
      >
        {item.metadata?.agentTrace ? (
          <AgentTraceView
            trace={item.metadata.agentTrace}
            durationSeconds={item.metadata.processingSeconds}
            inline
            reasoningSegments={item.metadata.reasoningSegments
              ?? (item.metadata.reasoning ? [{ text: item.metadata.reasoning }] : undefined)}
          />
        ) : failed ? (
          <View style={styles.failureCard}>
            <Text style={styles.failureTitle}>执行失败</Text>
            {retry ? (
              <Pressable accessibilityRole="button" disabled={sending} onPress={() => onRetry(retry)} style={[styles.failureRetry, sending && styles.failureRetryDisabled]}>
                <Ionicons name="refresh-outline" size={17} color={colors.danger} />
                <Text style={styles.failureRetryText}>{sending ? "处理中" : "重试"}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
        {item.role === "user" && item.metadata?.attachments?.length ? (
          <View style={styles.attachmentRow}>
            {item.metadata.attachments.map((entry) => (
              <View key={entry.name} style={styles.attachmentChip}>
                <Ionicons name="document-text-outline" size={14} color={colors.primary} />
                <Text numberOfLines={1} style={styles.attachmentName}>{entry.name}</Text>
                <Text style={styles.attachmentMeta}>{entry.characters} 字</Text>
              </View>
            ))}
          </View>
        ) : null}
        {/* 用户消息不可选中：长按要留给操作菜单，选择文本由菜单打开底部面板承载。 */}
        <Text selectable={item.role !== "user"} style={[styles.messageText, chatTextStyle]}>{item.content}</Text>

        {item.role === "assistant" && retry ? (
          <MessageActionBar
            content={item.content}
            onRetry={() => onRetry(retry)}
            retryDisabled={sending}
            onStartPlan={isPlan ? onStartPlan : undefined}
          />
        ) : null}
      </Pressable>
      {item.role === "user" ? (
        <View style={styles.messageEditRowOutside}>
          <Text style={styles.messageTime}>{formatMessageTime(item.createdAt)}</Text>
        </View>
      ) : null}
    </View>
  );
});

export function AssistantScreen() {
  // 订阅外观档位：样式表由 themedStyles 的 Proxy 在**读样式键时**才重建，而 StyleSheet.create
  // 的结果会随元素 props 一起固化 —— 屏组件不重渲染，它产出的元素就还带着上一档的 style 引用。
  // 外壳 Screen 订阅只能让外壳换色，屏内元素仍旧停在旧档（背景变了、正文没变）。
  useAppearance();
  const navigation = useNavigation<BottomTabNavigationProp<RootTabParamList>>();
  const projectId = useAppStore((state) => state.currentProjectId);
  const setCurrentProject = useAppStore((state) => state.setCurrentProject);
  const [scratchProjectId, setScratchProjectId] = useState<string | null>(null);
  // 无作品模式：未选书时落到「未命名」，助手照常可用
  const effectiveProjectId = projectId ?? scratchProjectId;
  const refreshData = useAppStore((state) => state.refreshData);
  const revision = useAppStore((state) => state.dataRevision);
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** 聊天列表为 inverted（业界标准：GiftedChat 等）——offset 0 恒为最新消息，
   *  打开 / 切换 / 发送天然落在最新，无需任何滚动代码。 */
  const reversedMessages = useMemo(() => [...messages].reverse(), [messages]);
  /** 列表此刻是否停在最新这一端：思考轨迹跑完要不要自动收起，先问它。
   *  写 ref 不写 state —— 每次滚动都重渲染会拖慢列表本身。 */
  const atBottomRef = useRef(true);
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  // 用户显式选过的那一个（对应设置里的 activeModelId）。为空表示「跟随主智能体或默认模型」。
  const [explicitModelId, setExplicitModelId] = useState<string | null>(null);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [activeAgentName, setActiveAgentName] = useState("Build");
  /** 可选的主智能体清单：选择模型面板的第二级用。 */
  const [agentDefinitions, setAgentDefinitions] = useState<AgentDefinition[]>([]);
  const [styleProfiles, setStyleProfiles] = useState<StyleProfile[]>([]);
  const [activeStyleProfile, setActiveStyleProfileState] = useState<StyleProfile | null>(null);
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const [loading, setLoading] = useState(true);
  /**
   * 加载超过 200ms 才画转圈。
   *
   * 实测 load() 多在 40~140ms —— 短于人会察觉的时长。一上来就画一个转圈再抹掉，
   * 本身就是一次"闪"。只有真的慢下来才值得给出指示。
   */
  const [slowHint, setSlowHint] = useState(false);
  useEffect(() => {
    if (!loading) {
      setSlowHint(false);
      return;
    }
    const timer = setTimeout(() => setSlowHint(true), 200);
    return () => clearTimeout(timer);
  }, [loading]);
  const [error, setError] = useState<string | null>(null);
  /** 作品与对话抽屉：全部作品与它们各自的对话都收在里面。 */
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [drawerProjects, setDrawerProjects] = useState<Project[]>([]);
  const [drawerSessions, setDrawerSessions] = useState<Record<string, ChatSession[]>>({});
  /** 重命名目标：对话与作品共用同一个输入入口，标题与保存分支随 kind 走。 */
  const [renaming, setRenaming] = useState<
    { kind: "session"; session: ChatSession } | { kind: "project"; project: Project } | null
  >(null);
  /** 居中确认卡：新建与删除对话、删除作品、附件归处、完成与失败告知。 */
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [mascotEnabled, setMascotEnabled] = useState(true);
  const [mascotKind, setMascotKind] = useState<string>("cat");
  const [mascotOffset, setMascotOffset] = useState({ x: 0, y: 0 });
  const [renameTitle, setRenameTitle] = useState("");
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  /** 选择模型面板的两级：model = 模型列表；agent = 智能体列表。同一张面板内换页。 */
  const [agentPickerStep, setAgentPickerStep] = useState<"model" | "agent">("model");
  const [stylePickerVisible, setStylePickerVisible] = useState(false);
  const [updatingStyle, setUpdatingStyle] = useState(false);
  const [liveTrace, setLiveTrace] = useState<AgentRunTrace | null>(null);
  /**
   * 实时轨迹刷进 state：一帧最多一次，且两次之间不短于 40ms。
   *
   * 流式思考每到一个 token，runtime 就发布一次轨迹；不节流就是每 token 整屏重渲染。
   * 只用毫秒节流时，提交时点与绘制帧不对齐，文字会落在帧中间，看上去一格一格；
   * 改成落在帧上、间隔又不低于 40ms（约 25 次/秒）之后，文字的增长读起来是连续的。
   */
  const flushLiveTrace = useMemo(() => throttleFrameGap((trace: AgentRunTrace) => setLiveTrace(trace), 40), []);
  /**
   * 🔴 临时埋点（量完即删）：流式期间逐帧记帧间隔，整轮跑完写一行。
   *
   * 为什么不用「setState 到下一帧」那种量法：两次 requestAnimationFrame 自带一帧多的
   * 固定等待，与旧的 setTimeout(…, 260) 是同一个毛病 —— 基线把信号吃掉。帧间隔没有基线：
   * 一帧超过 50ms 就是实打实的掉帧，均值与峰值直接反映流式期间顺不顺。
   */
  const frameProbe = useRef({ raf: 0, last: 0, count: 0, total: 0, peak: 0, jank: 0 });

  const startFrameProbe = useCallback(() => {
    const stat = frameProbe.current;
    if (stat.raf) cancelAnimationFrame(stat.raf);
    stat.last = 0; stat.count = 0; stat.total = 0; stat.peak = 0; stat.jank = 0;
    const tick = (stamp: number) => {
      if (stat.last) {
        const delta = Math.round(stamp - stat.last);
        stat.count += 1;
        stat.total += delta;
        if (delta > stat.peak) stat.peak = delta;
        if (delta > 50) stat.jank += 1;
      }
      stat.last = stamp;
      stat.raf = requestAnimationFrame(tick);
    };
    stat.raf = requestAnimationFrame(tick);
  }, []);

  const stopFrameProbe = useCallback(() => {
    const stat = frameProbe.current;
    if (!stat.raf) return;
    cancelAnimationFrame(stat.raf);
    stat.raf = 0;
    if (stat.count) {
      appendBreadcrumb(`__perf 流式帧 ${stat.count}帧 均${Math.round(stat.total / stat.count)}ms 峰${stat.peak}ms 卡${stat.jank}次`);
    }
  }, []);

  // 离开页面时丢弃挂起的那一次刷新，不给已卸载的组件发 setState；帧统计一并收掉。
  useEffect(() => () => {
    flushLiveTrace.cancel();
    if (frameProbe.current.raf) cancelAnimationFrame(frameProbe.current.raf);
  }, [flushLiveTrace]);
  /**
   * 正在写出的正文。
   *
   * 与思考共用同一条 `segments`：正文增量由 runtime 追加进轨迹里的 content 段，
   * 界面只读这一处，不另开第二条流式通道。正文落定后由消息体承载，那一段在落库
   * 前就被移除，所以不会与气泡重复。
   */
  const streamingContent = useMemo(() => {
    const parts: string[] = [];
    for (const segment of liveTrace?.segments ?? []) {
      if (segment.kind === "content") parts.push(segment.text);
    }
    return parts.join("");
  }, [liveTrace]);
  /**
   * 跑动中的临时行。
   *
   * 实时轨迹与流式正文原来挂在列表头：列表头与消息项是两个容器，回答结束那一帧要跨容器
   * 搬一次，位置与高度都跟着变。改成 data 的第一项之后，它占的正是落定消息的位置，结束时
   * 原地替换 —— 正文不再从一处挪到另一处。
   */
  const liveRow: ChatMessage | null = liveTrace || streamingContent
    ? {
        id: STREAMING_ROW_ID,
        projectId: effectiveProjectId ?? "",
        sessionId: activeSession?.id ?? "",
        role: "assistant",
        content: streamingContent,
        metadata: null,
        createdAt: "",
      }
    : null;
  const listData = useMemo(
    () => (liveRow ? [liveRow, ...reversedMessages] : reversedMessages),
    [liveRow, reversedMessages],
  );
  // 最近一次被接受的 AI 写入（撤销入口），null 表示当前没有可撤销的改动
  const [undoTarget, setUndoTarget] = useState<string | null>(null);
  // 写入审批方式：过了工具权限那道门之后，是等你点一下，还是直接放行。默认等你点。
  const [writeApproval, setWriteApproval] = useState<WriteApprovalMode>("ask");
  // 输入框「+」上的菜单：null 关闭 / "root" 附件、权限与技能 / "approval" 权限的两档 / "skill" 技能列表。
  const [composerMenu, setComposerMenu] = useState<null | "root" | "approval" | "skill">(null);
  // 待随下一条消息发送的文本附件
  const [attachments, setAttachments] = useState<TextAttachment[]>([]);
  // 技能面板：候选、搜索词，以及已点选的那一条（只作用于下一条消息，发送即清）。
  const [skillOptions, setSkillOptions] = useState<PickedSkill[]>([]);
  const [skillQuery, setSkillQuery] = useState("");
  const [pickedSkill, setPickedSkill] = useState<PickedSkill | null>(null);
  // 消息长按菜单：记下被按的那条、按压点的横坐标，以及那条消息在屏幕上的上边缘与高度。
  // 纵向上贴这条消息的下边缘出现（不留间隙），因此要的是行的边界而不是按压点本身。
  const [messageMenu, setMessageMenu] = useState<{ id: string; pageX: number; rowTop: number; rowHeight: number } | null>(null);
  // 消息行的高度：长按时用它把「按压点」换算成「这条消息的下边缘」。写进 ref 而不是 state，
  // 免得每次布局都触发一轮重渲染。
  const rowHeightsRef = useRef(new Map<string, number>());
  // 「选择文本」打开的底部面板：面板里显示这条消息的原文，长按即可选中。
  const [textSelection, setTextSelection] = useState<ChatMessage | null>(null);
  // 消息区的窗口坐标与尺寸：把按压点的屏幕坐标换算成卡片在消息区里的位置。
  const messagesAreaRef = useRef<View>(null);
  const [messagesArea, setMessagesArea] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const measureMessagesArea = useCallback(() => {
    messagesAreaRef.current?.measureInWindow((x, y, width, height) => setMessagesArea({ x, y, width, height }));
  }, []);
  // 列表自身的可视范围：菜单纵向要夹在**列表**里，不能按整个消息区算 ——
  // 消息区还含输入框，按它算，卡片会落到输入框上。
  const [listLayout, setListLayout] = useState({ y: 0, height: 0 });
  const measureList = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    setListLayout({ y, height });
  }, []);
  const [writeCard, setWriteCard] = useState<WriteCardRequest | null>(null);
  const [writeDiffExpanded, setWriteDiffExpanded] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<AgentClarificationRequest | null>(null);
  const [retryRequest, setRetryRequest] = useState<RetryRequest | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const composerRef = useRef<TextInput>(null);
  const loadRequestRef = useRef(0);
  const sendRequestRef = useRef(0);
  const questionResolverRef = useRef<((response: AgentClarificationResponse) => void) | null>(null);
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);

  const cancelPendingQuestion = useCallback(() => {
    const resolver = questionResolverRef.current;
    questionResolverRef.current = null;
    setPendingQuestion(null);
    resolver?.({ answers: [], cancelled: true });
  }, []);

  const load = useCallback(async (overrideId?: string) => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    const activeProjectId = overrideId ?? projectId ?? scratchProjectId;
    // 无作品模式且还没开聊：不再预创建空作品，页面就停在欢迎屏。模型、供应商与设置
    // 照常加载（发送按钮的可用性取决于它们）；作品与会话留给第一次点发送那一刻创建
    // —— 点输入框、打字、点建议 chip 都不建任何东西。
    const noProject = !activeProjectId;
    setLoading(true);
    setError(null);
    try {
      const [
        nextProject,
        storedSessions,
        preferredSessionId,
        activeModelId,
        nextModels,
        nextProviders,
        projectAgentId,
        activeAgentId,
        agents,
        nextStyleProfiles,
        nextActiveStyleProfile,
        approvalMode,
      ] = await Promise.all([
        // 还没开聊时这些按空作品查（本地库，空 id 直接查不到），省掉一整套分支。
        getProject(activeProjectId ?? ""),
        listChatSessions(activeProjectId ?? ""),
        getSetting(activeSessionSettingKey(activeProjectId ?? "")),
        getSetting("activeModelId"),
        listModels(),
        listProviders(),
        getSetting(activeAgentSettingKey(activeProjectId ?? "")),
        getSetting("agent.activeDefinitionId"),
        getAgentDefinitions(),
        listStyleProfiles(activeProjectId ?? ""),
        getActiveStyleProfile(activeProjectId ?? ""),
        getWriteApproval(),
      ]);
      if (!noProject && !nextProject) throw new Error("作品不存在");
      // 作品自己有就用作品的，没有就落回设置里的全局默认。
      const activeAgent = agents.find((agent) => agent.id === projectAgentId && agent.enabled && agent.kind === "primary")
        ?? agents.find((agent) => agent.id === activeAgentId && agent.enabled && agent.kind === "primary")
        ?? agents.find((agent) => agent.id === "builtin-agent--build" && agent.enabled)
        ?? agents.find((agent) => agent.enabled && agent.kind === "primary");
      // 模型只有一个来源：用户当前选定的那个（activeModelId）。智能体不再各自绑定模型。
      const nextDefaultModelId = nextModels.find((model) => model.id === activeModelId)?.id ?? null;
      if (activeModelId && !nextModels.some((model) => model.id === activeModelId)) {
        await setSetting("activeModelId", "");
      }
      let nextSessions = storedSessions;
      let nextSession = nextSessions.find((session) => session.id === preferredSessionId) ?? nextSessions[0] ?? null;
      // 打开一部从没聊过的作品时不再预建一条「新对话」：页面直接是空对话，
      // 第一条对话与作品一起等发第一条消息那一刻才建（唯一创建点在 send 里）。
      // 模型是全局唯一的：每条对话不再各存一份，一律用当前模型（activeModelId）。
      // 换模型因此立刻对所有对话生效，包括已经聊过的那些。
      const selectedModelId = nextDefaultModelId;
      const nextMessages = nextSession ? await listMessages(nextSession.id) : [];
      let nextSelection: ModelSelection | null = null;
      let selectionError: string | null = null;
      try {
        nextSelection = await resolveSelection(selectedModelId, nextModels, nextProviders);
      } catch (resolveError) {
        selectionError = resolveError instanceof Error ? resolveError.message : String(resolveError);
      }
      if (nextSession) await setSetting(activeSessionSettingKey(activeProjectId!), nextSession.id);
      if (loadRequestRef.current !== requestId) return;
      setProject(nextProject);
      setSessions(nextSessions);
      setActiveSession(nextSession);
      setMessages(nextMessages);
      setWriteApproval(approvalMode);
            const lastFailed = [...nextMessages].reverse().find((message) => message.role === "assistant" && (message.metadata?.taskStatus === "failed" || message.metadata?.agentTrace?.status === "error"));
      setRetryRequest(lastFailed && nextSession ? retryRequestForMessage(lastFailed, nextMessages, nextSession, nextSelection, activeAgent?.id ?? null) : null);
      setModels(nextModels);
      setProviders(nextProviders);
      setDefaultModelId(nextDefaultModelId);
      setExplicitModelId(activeModelId ?? null);
      setActiveAgentId(activeAgent?.id ?? null);
      setActiveAgentName(activeAgent?.name ?? "Build");
      setAgentDefinitions(agents);
      setStyleProfiles(nextStyleProfiles);
      setActiveStyleProfileState(nextActiveStyleProfile);
      setSelection(nextSelection);
      setError(selectionError);
    } catch (loadError) {
      if (loadRequestRef.current !== requestId) return;
      setActiveSession(null);
      setSelection(null);
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (loadRequestRef.current === requestId) setLoading(false);
    }
  }, [cancelPendingQuestion, effectiveProjectId, flushLiveTrace]);

  useEffect(() => {
    cancelPendingQuestion();
    setSending(false);
    setLiveTrace(null);
    flushLiveTrace.cancel();
    return () => {
      sendRequestRef.current += 1;
      cancelPendingQuestion();
    };
    // 只在"真的换了作品"时重置：创建速记作品（无作品 → 有作品）不算切换，
    // 若跟着它重置，会把刚点下去的那次发送当场作废。
  }, [cancelPendingQuestion, projectId]);

  useEffect(() => {
    setInput("");
    setEditingMessageId(null);
  }, [activeSession?.id]);
  // 对话字体与字号跟随「设置 → 编辑器 → 对话时」，在页面获得焦点时读取，改完返回即生效。
  const [chatTextStyle, setChatTextStyle] = useState<{ fontSize: number; lineHeight: number; fontFamily?: string }>({
    fontSize: 16,
    lineHeight: 24,
  });
  // 上下文用量：窗口上限与保留条数来自设置，估算随消息变化实时更新
  const [contextWindow, setContextWindow] = useState(DEFAULT_CONTEXT_WINDOW_TOKENS);
  const [historyLimit, setHistoryLimit] = useState(30);
  const [contextSheetVisible, setContextSheetVisible] = useState(false);
  // 思考计时：请求进行中每秒 +1，给用户“正在思考”的实时感知
  useEffect(() => {
    if (!sending) {
      setThinkingSeconds(0);
      return;
    }
    const timer = setInterval(() => setThinkingSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [sending]);

  /**
   * 第一次真正开聊（点了发送）才创建「灵感速记」与会话。
   *
   * 点输入框、打字、点建议 chip 都不建任何东西 —— 原先 `load()` 一进页面就把空作品建
   * 出来，界面上凭空多一条「新对话」。
   *
   * 返回建好的作品与会话：发送那一处要继续用它们，而那次调用的闭包里 `project` /
   * `activeSession` 还是旧值（setState 不会同步生效）。
   */
  const ensureConversation = useCallback(async (): Promise<{ project: Project; session: ChatSession; messages: ChatMessage[] } | null> => {
    if (project && activeSession) return { project, session: activeSession, messages };
    if (loading) return null;
    try {
      const scratch = project ?? await ensureScratchProject();
      // 速记作品可能早就有会话（上次聊过，这次是重开应用进来的）：沿用它，并把历史消息一起
      // 读回来。新开一条会把旧的留在库里不显示 —— 界面上就成了"聊过的记录消失"。
      const stored = await listChatSessions(scratch.id);
      const preferredId = await getSetting(activeSessionSettingKey(scratch.id));
      const existing = activeSession ?? stored.find((item) => item.id === preferredId) ?? stored[0] ?? null;
      const session = existing ?? await createChatSession(scratch.id, selection?.model.id ?? defaultModelId);
      await setSetting(activeSessionSettingKey(scratch.id), session.id);
      const nextSessions = stored.some((item) => item.id === session.id) ? stored : [session, ...stored];
      const nextMessages = existing ? await listMessages(session.id) : [];
      const [nextStyleProfiles, nextActiveStyleProfile] = await Promise.all([
        listStyleProfiles(scratch.id),
        getActiveStyleProfile(scratch.id),
      ]);
      setScratchProjectId(scratch.id);
      setProject(scratch);
      setSessions(nextSessions);
      setActiveSession(session);
      setMessages(nextMessages);
      setStyleProfiles(nextStyleProfiles);
      setActiveStyleProfileState(nextActiveStyleProfile);
      return { project: scratch, session, messages: nextMessages };
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return null;
    }
  }, [project, activeSession, loading, selection, defaultModelId, messages]);

  const mascotOffsetRef = useRef({ x: 0, y: 0 });
  const mascotDragStartRef = useRef({ x: 0, y: 0 });
  const mascotPressAtRef = useRef(0);
  const mascotPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        mascotDragStartRef.current = { ...mascotOffsetRef.current };
        mascotPressAtRef.current = Date.now();
      },
      onPanResponderMove: (_event, gesture) => {
        // 长按 350ms 后才进入拖动，避免误触页面滑动
        if (Date.now() - mascotPressAtRef.current < 350) return;
        const next = { x: mascotDragStartRef.current.x + gesture.dx, y: mascotDragStartRef.current.y + gesture.dy };
        mascotOffsetRef.current = next;
        setMascotOffset(next);
      },
      onPanResponderRelease: () => {
        void setSetting("assistant.mascotOffset", JSON.stringify(mascotOffsetRef.current)).catch(() => {});
      },
    }),
  ).current;

  // 离开助手页（切到别的 tab）时收起抽屉：抽屉不盖底部 tab 栏，状态留着的话，
  // 返回键会被一个看不见的抽屉吃掉一次。
  useFocusEffect(useCallback(() => () => setDrawerVisible(false), []));

  useFocusEffect(useCallback(() => {
    void (async () => {
      const prefs = await readChatPrefs();
      setChatTextStyle({
        fontSize: prefs.fontSize,
        lineHeight: Math.round(prefs.fontSize * 1.5),
        fontFamily: editorFontFamily(prefs.fontFamily),
      });
      const [windowValue, limitValue] = await Promise.all([
        getSetting(CONTEXT_WINDOW_KEY),
        getSetting("context.historyLimit"),
      ]);
      let effectiveWindow = normalizeContextWindow(windowValue);
      let effectiveLimit = Math.max(1, Number(limitValue) || 30);
      const effectiveModelId = selection?.model?.id;
      if (effectiveModelId) {
        const overrideRaw = await getSetting(`context.override.${effectiveModelId}`).catch(() => null);
        if (overrideRaw) {
          try {
            const parsed = JSON.parse(overrideRaw) as { historyLimit?: number; windowTokens?: number };
            if (parsed?.historyLimit) effectiveLimit = parsed.historyLimit;
            if (parsed?.windowTokens) effectiveWindow = normalizeContextWindow(String(parsed.windowTokens));
          } catch {}
        }
      }
      setContextWindow(effectiveWindow);
      setHistoryLimit(effectiveLimit);
      setMascotEnabled((await getSetting("general.mascotEnabled")) !== "false");
      setMascotKind(normalizeMascotKind(await getSetting("general.mascot")));
      const mascotRaw = await getSetting("assistant.mascotOffset");
      if (mascotRaw) {
        try {
          const parsed = JSON.parse(mascotRaw) as { x?: number; y?: number };
          if (typeof parsed?.x === "number" && typeof parsed?.y === "number") {
            const next = { x: parsed.x, y: parsed.y };
            mascotOffsetRef.current = next;
            setMascotOffset(next);
          }
        } catch {}
      }
    })();
  }, []));
  // 用 ref 取最新的 load：load 的依赖里含当前作品，若把它写进依赖数组，"刚创建出速记
  // 作品"那一刻也会额外触发一次重载，把这一次发送作废（cleanup 里 loadRequestRef 自增）。
  const loadRef = useRef(load);
  loadRef.current = load;
  // projectId 必须留在依赖里：它就是"换了一部作品"这件事本身（抽屉选作品、书架点作品都
  // 走它），拿掉之后切作品页面不会刷新。而创建速记作品只动 scratchProjectId，
  // 不会走到这里 —— 那次发送因此不被打断。
  useFocusEffect(useCallback(() => {
    void loadRef.current();
    return () => {
      loadRequestRef.current += 1;
      cancelPendingQuestion();
    };
  }, [cancelPendingQuestion, revision, projectId]));

  const switchSession = async (session: ChatSession) => {
    if (!effectiveProjectId || sending) return;
    setError(null);
    try {
      if (session.projectId !== effectiveProjectId || !sessions.some((item) => item.id === session.id)) {
        throw new Error("对话不属于当前作品");
      }
      // 模型不随对话走：切到哪条对话都用当前模型，切对话因此不会把模型也换掉。
      const effectiveModelId = defaultModelId;
      const nextMessages = await listMessages(session.id);
      let nextSelection: ModelSelection | null = null;
      let selectionError: string | null = null;
      try {
        nextSelection = await resolveSelection(effectiveModelId, models, providers);
      } catch (resolveError) {
        selectionError = resolveError instanceof Error ? resolveError.message : String(resolveError);
      }
      await setSetting(activeSessionSettingKey(effectiveProjectId), session.id);
      setActiveSession(session);
      setMessages(nextMessages);
      // 切走的那条如果上一轮失败过，把「重试」按在新对话上重算一遍。
      const lastFailed = [...nextMessages].reverse().find((message) => message.role === "assistant"
        && (message.metadata?.taskStatus === "failed" || message.metadata?.agentTrace?.status === "error"));
      setRetryRequest(lastFailed ? retryRequestForMessage(lastFailed, nextMessages, session, nextSelection, activeAgentId) : null);
      setSelection(nextSelection);
      setError(selectionError);
      setDrawerVisible(false);
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : String(switchError));
    }
  };

  // 抽屉打开时把全部作品与它们各自的对话读一遍。写操作后会 refreshData，
  // revision 一变这里就重查，所以新建、改名、删除之后列表会跟上。
  useEffect(() => {
    if (!drawerVisible) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listProjects();
        const sessionMap: Record<string, ChatSession[]> = {};
        await Promise.all(list.map(async (item) => {
          sessionMap[item.id] = await listChatSessions(item.id);
        }));
        if (cancelled) return;
        setDrawerProjects(list);
        setDrawerSessions(sessionMap);
      } catch {
        // 抽屉数据读失败不打断对话：沿用上一次读到的结果。
      }
    })();
    return () => { cancelled = true; };
  }, [drawerVisible, revision]);

  /**
   * 新建对话前先确认：误触会立刻切走，且每次点都会新建。
   * 带 target 时是抽屉里某部作品行的 ＋，新对话归那部作品。
   */
  const confirmNewSession = (target?: Project) => {
    if (sending) return;
    if (!target && !effectiveProjectId) return;
    setConfirmRequest({
      title: "新建对话？",
      message: "当前对话不会被删除，之后可在历史对话里找回。",
      confirmLabel: "新建",
      onConfirm: () => { void newSession(target); },
    });
  };

  /** 重命名对话或作品：改完即时更新抽屉列表与当前的会话 / 作品标题。 */
  const saveRename = async () => {
    if (!renaming || !renameTitle.trim()) return;
    const nextTitle = renameTitle.trim();
    try {
      if (renaming.kind === "project") {
        const target = renaming.project;
        await updateProjectInfo(target.id, nextTitle, target.description);
        setDrawerProjects((current) => current.map((item) => (item.id === target.id ? { ...item, title: nextTitle } : item)));
        if (project?.id === target.id) setProject({ ...project, title: nextTitle });
      } else {
        const updated = await updateChatSession({ id: renaming.session.id, title: nextTitle });
        setSessions((current) => current.map((session) => (session.id === updated.id ? updated : session)));
        if (activeSession?.id === updated.id) setActiveSession(updated);
      }
      setRenaming(null);
      refreshData();
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : String(renameError));
    }
  };

  /** 新对话归到 target 那部作品；不带 target 时归当前作品。 */
  const newSession = async (target?: Project) => {
    const targetProjectId = target?.id ?? effectiveProjectId;
    if (!targetProjectId || sending) return;
    setError(null);
    try {
      const session = await createChatSession(targetProjectId, selection?.model.id ?? defaultModelId);
      await setSetting(activeSessionSettingKey(targetProjectId), session.id);
      if (targetProjectId === effectiveProjectId) {
        setSessions((current) => [session, ...current]);
        setActiveSession(session);
        setMessages([]);
        setRetryRequest(null);
      } else {
        // 给别的作品新建：切过去，加载时会按上面的设置把这条新对话选为当前。
        setCurrentProject(targetProjectId);
      }
      setDrawerVisible(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    }
  };

  const chooseModel = async (modelId: string | null) => {
    if (sending) return;
    setError(null);
    try {
      const nextSelection = await resolveSelection(modelId ?? defaultModelId, models, providers);
      if (modelId) {
        // 写全局那一份（activeModelId），所有对话立刻跟着变。
        await setSetting("activeModelId", modelId);
        setDefaultModelId(modelId);
        setExplicitModelId(modelId);
      } else {
        // 选「跟随主智能体或默认模型」：清掉显式选择，回落到主智能体那一个。
        await setSetting("activeModelId", "");
        setExplicitModelId(null);
      }
      setSelection(nextSelection);
      setModelPickerVisible(false);
    } catch (modelError) {
      setError(modelError instanceof Error ? modelError.message : String(modelError));
    }
  };

  /** 切换这部作品使用的智能体：只写当前作品那一份，其他作品不受影响。 */
  const chooseAgent = async (agentId: string) => {
    if (sending || !effectiveProjectId) return;
    setError(null);
    try {
      await setSetting(activeAgentSettingKey(effectiveProjectId), agentId);
      setActiveAgentId(agentId);
      setActiveAgentName(agentDefinitions.find((agent) => agent.id === agentId)?.name ?? "Build");
      setAgentPickerStep("model");
    } catch (agentError) {
      setError(agentError instanceof Error ? agentError.message : String(agentError));
    }
  };

  const chooseStyle = async (profile: StyleProfile | null) => {
    if (!effectiveProjectId || sending || updatingStyle) return;
    setUpdatingStyle(true);
    setError(null);
    try {
      await setActiveStyleProfile(effectiveProjectId, profile?.id ?? null);
      setActiveStyleProfileState(profile);
      setStylePickerVisible(false);
    } catch (styleError) {
      setError(styleError instanceof Error ? styleError.message : String(styleError));
    } finally {
      setUpdatingStyle(false);
    }
  };

  const removeSession = async (session: ChatSession) => {
    if (sending) return;
    const targetProjectId = effectiveProjectId;
    if (!targetProjectId) return;
    try {
      await deleteChatSession(session.id);
      // 抽屉里那一行同时消失，不必等下一次全量重读。
      setDrawerSessions((current) => {
        const list = current[session.projectId];
        if (!list) return current;
        return { ...current, [session.projectId]: list.filter((item) => item.id !== session.id) };
      });
      // 删的是别的作品的对话：它不在当前列表里，当前对话不受影响。
      if (session.projectId !== targetProjectId) return;
      const remaining = sessions.filter((item) => item.id !== session.id);
      setSessions(remaining);
      if (activeSession?.id !== session.id) return;
      // 删掉的正好是当前对话、而且它是这条作品的最后一条：回到空对话，不再补建一条空的。
      // 作品还在，下次点发送时会建一条新的 —— 空对话也是一个正常状态。
      if (!remaining.length) {
        await setSetting(activeSessionSettingKey(targetProjectId), "");
        setActiveSession(null);
        setMessages([]);
        setRetryRequest(null);
        return;
      }
      const replacement = remaining[0];
      await setSetting(activeSessionSettingKey(targetProjectId), replacement.id);
      const effectiveModelId = defaultModelId;
      const nextMessages = await listMessages(replacement.id);
      setActiveSession(replacement);
      setMessages(nextMessages);
            setRetryRequest(null);
      try {
        setSelection(await resolveSelection(effectiveModelId, models, providers));
        setError(null);
      } catch (resolveError) {
        setSelection(null);
        setError(resolveError instanceof Error ? resolveError.message : String(resolveError));
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const confirmDeleteSession = (session: ChatSession) => {
    setConfirmRequest({
      title: "删除对话",
      message: `确定删除“${session.title}”及其中的全部消息？`,
      confirmLabel: "删除",
      danger: true,
      onConfirm: () => { void removeSession(session); },
    });
  };

  const removeProject = async (target: Project) => {
    if (sending) return;
    setError(null);
    try {
      await deleteProject(target.id);
      // 删掉的正是正打开的那部：回到"还没有选作品"的状态，助手下次使用时自建「未命名」。
      if (target.id === effectiveProjectId) setCurrentProject(null);
      refreshData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  };

  const confirmDeleteProject = (target: Project) => {
    setConfirmRequest({
      title: "删除作品",
      message: "确定删除《" + target.title + "》？这部作品的章节、笔记与全部对话会一并删除。",
      confirmLabel: "删除",
      danger: true,
      onConfirm: () => { setDrawerVisible(false); void removeProject(target); },
    });
  };

  const beginEditMessage = (message: ChatMessage) => {
    if (sending || message.role !== "user") return;
    setError(null);
    setRetryRequest(null);
    setEditingMessageId(message.id);
    setInput(message.content);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const cancelMessageEdit = () => {
    setEditingMessageId(null);
    setInput("");
  };

  /** 选一个文本文件，由用户决定是这次发给助手，还是存进本作品的资料。 */
  const handlePickAttachment = async () => {
    let picked: TextAttachment | null = null;
    try {
      picked = await pickTextAttachment();
    } catch (pickError) {
      setConfirmRequest({
        title: "无法读取文件",
        message: pickError instanceof Error ? pickError.message : String(pickError),
      });
      return;
    }
    if (!picked) return;
    const attachment = picked;
    setConfirmRequest({
      title: attachment.name,
      message: `共 ${attachment.characters} 字${attachment.truncated ? "（内容较长，已截取前 10 万字）" : ""}\n\n「加入本次对话」：随下一条消息发给助手，不写入数据库。\n「存入资料」：写成本作品的笔记，之后助手可长期检索引用。`,
      confirmLabel: "存入资料",
      extraLabel: "加入本次对话",
      onConfirm: () => {
        void (async () => {
          if (!project) return;
          try {
            const title = await saveAttachmentAsNote(project.id, attachment);
            refreshData();
            setConfirmRequest({
              title: "已存入资料",
              message: `「${title}」已写成本作品的笔记，助手可在需要时检索到。`,
            });
          } catch (saveError) {
            setConfirmRequest({
              title: "存入失败",
              message: saveError instanceof Error ? saveError.message : String(saveError),
            });
          }
        })();
      },
      onExtra: () => setAttachments((current) => (
        current.some((item) => item.name === attachment.name) || current.length >= MAX_ATTACHMENTS_PER_MESSAGE
          ? current
          : [...current, attachment]
      )),
    });
  };

  /**
   * 撤销入口自己走掉：出现后 15 秒收起。
   *
   * 只在真正可见时计时 —— 发送中这条被 `!sending` 隐藏，此时暂停，使条出现之后仍有完整
   * 的 15 秒。点撤销会立刻把 undoTarget 置空，effect 随之清掉定时器。
   */
  useEffect(() => {
    if (!undoTarget || sending) return;
    const timer = setTimeout(() => setUndoTarget(null), 15000);
    return () => clearTimeout(timer);
  }, [undoTarget, sending]);

  /** 撤销最近一次被接受的 AI 写入，把对象还原为改动前的内容。 */
  const handleUndoWrite = () => {
    void (async () => {
      try {
        const label = await undoLastWrite();
        if (label) {
          setUndoTarget(null);
          refreshData();
          setConfirmRequest({ title: "已撤销", message: `「${label}」已还原为改动前的内容。` });
        } else {
          setUndoTarget(null);
        }
      } catch (error) {
        setConfirmRequest({
          title: "撤销失败",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };

  /** 从「+」菜单里选附件：先收起菜单再走原来的选文件流程。 */
  const pickAttachment = () => {
    setComposerMenu(null);
    void handlePickAttachment();
  };

  /**
   * 切换写入审批方式。输入框菜单与设置页共用同一份持久化，改一处两处同时生效。
   *
   * 它只决定"过了权限那道门之后等不等你点"：工具被禁用的仍然不执行，删除类
   * 在任何一档下都等你点。
   */
  const changeWriteApproval = async (mode: WriteApprovalMode) => {
    setWriteApproval(mode);
    setComposerMenu(null);
    await saveWriteApproval(mode);
  };

  const askUser = useCallback((request: AgentClarificationRequest) => new Promise<AgentClarificationResponse>((resolve) => {
    questionResolverRef.current?.({ answers: [], cancelled: true });
    questionResolverRef.current = resolve;
    setPendingQuestion(request);
  }), []);

  const finishQuestion = (response: AgentClarificationResponse) => {
    const resolver = questionResolverRef.current;
    questionResolverRef.current = null;
    setPendingQuestion(null);
    resolver?.(response);
  };

  const send = async (retry: RetryRequest | null = null, composedContent?: string) => {
    const content = retry?.userMessage.content ?? composedContent ?? input.trim();
    const editTarget = !retry && !composedContent && editingMessageId
      ? messages.find((message) => message.id === editingMessageId && message.role === "user") ?? null
      : null;
    if (!content || sending) return;
    // 还没有作品或还没有会话：到这一刻（点了发送）才创建。用返回值继续 ——
    // setState 不会同步落进这次调用的闭包，读 state 只会读到 null。
    const ready = project && activeSession
      ? { project, session: activeSession, messages }
      : await ensureConversation();
    if (!ready) return;
    const readyProject = ready.project;
    const readySession = ready.session;
    // 历史用返回值里的：这一轮刚把旧会话读回来时，闭包里的 messages 还是空的，
    // 用它当 baseHistory 会把之前聊过的内容从上下文里抹掉。
    const readyMessages = ready.messages;
    if (retry && (retry.sessionId !== readySession.id || !messages.some((message) => message.id === retry.userMessage.id))) {
      setRetryRequest(null);
      setError("重试消息已不在当前对话中，请重新发送");
      return;
    }
    const sessionId = readySession.id;
    const requestId = sendRequestRef.current + 1;
    sendRequestRef.current = requestId;
    const isCurrentRequest = () => sendRequestRef.current === requestId;
    // 本请求专属的弹卡回调：并发请求各自持有自己的 emit，不共用全局槽位。
    const emitWriteCard = (req: WriteCardRequest) => {
      if (req.requestToken !== requestId) {
        // 已作废的请求：直接回绝，不给界面展示的机会。
        req.resolve(false);
        return;
      }
      setWriteDiffExpanded(false);
      setWriteCard(req);
    };
    setSending(true);
    setError(null);
    setInput("");
    setLiveTrace(null);
    flushLiveTrace.cancel();
    startFrameProbe();
    let userMessage = retry?.userMessage ?? null;
    let nextHistory = retry?.history ?? [];
    let userMessageSaved = Boolean(userMessage);
    let workingSession = readySession;
    let latestTrace: AgentRunTrace | null = null;
    let runSelection: ModelSelection | null = selection;
    try {
      // 当前选中的模型优先。失败消息里记录的 modelId 只作兜底，
      // 否则用户换了可用模型后点重试仍会打回那个出错的旧模型。
      runSelection = selection
        ?? (retry?.modelId ? await resolveSelection(retry.modelId, models, providers) : null);
      if (!runSelection) throw new Error("请先配置可用模型");
      if (retry?.sourceMessageId) {
        await deleteMessagesFrom(sessionId, retry.sourceMessageId);
        if (!isCurrentRequest()) return;
        setMessages((current) => {
          const sourceIndex = current.findIndex((message) => message.id === retry.sourceMessageId);
          return sourceIndex < 0 ? current : current.slice(0, sourceIndex);
        });
      }
      if (!retry) {
        let baseHistory = readyMessages;
        if (editTarget) {
          const editIndex = messages.findIndex((message) => message.id === editTarget.id);
          if (editIndex < 0) throw new Error("要编辑的消息不存在");
          const replacement = await replaceUserMessageBranch(sessionId, editTarget.id, content);
          userMessage = replacement.message;
          userMessageSaved = true;
          baseHistory = messages.slice(0, editIndex);
          nextHistory = [...baseHistory, userMessage];
          workingSession = replacement.session;
          setEditingMessageId(null);
        } else {
          userMessage = await addMessage(sessionId, "user", content, attachments.length
            ? { attachments: attachments.map((item) => ({ name: item.name, characters: item.characters })) }
            : null);
          userMessageSaved = true;
          nextHistory = [...baseHistory, userMessage];
          workingSession = {
            ...workingSession,
            title: workingSession.title === "新对话" ? generatedSessionTitle(content) : workingSession.title,
            updatedAt: userMessage.createdAt,
          };
        }
        if (!isCurrentRequest()) return;
        setMessages(nextHistory);
        setActiveSession(workingSession);
        setSessions((current) => [workingSession, ...current.filter((session) => session.id !== workingSession.id)]);
      }
      if (!userMessage) throw new Error("消息准备失败，请重试");
      // 附件内容不写进消息正文（避免气泡里堆满原文），而是作为一条独立的资料消息随本次请求发给模型。
      const attachmentMessage = attachments.length
        ? {
            id: `${userMessage.id}-attachments`,
            projectId: userMessage.projectId,
            sessionId: userMessage.sessionId,
            role: "user" as const,
            content: attachmentContextBlock(attachments),
            metadata: null,
            createdAt: userMessage.createdAt,
          }
        : null;
      const runHistory = attachmentMessage ? [...nextHistory, attachmentMessage] : nextHistory;
      const requestStartedAt = Date.now();
      // 技能只作用于本条消息：先把值取下来，再把 chip 清掉，下一轮回到按关键词判定。
      const pickedSkillName = pickedSkill?.name ?? null;
      setPickedSkill(null);
      setMessageMenu(null);
      const response = await runAgent({
        project: readyProject,
        selection: runSelection,
        history: runHistory,
        agentId: retry?.agentId ?? activeAgentId,
        pickedSkillName,
        approveTool: (name, args, preview) =>
          requestToolApproval(emitWriteCard, requestId, name, args, preview, writeApproval),
        askUser,
        onTrace: (trace) => {
          // 实时时间线唯一的数据源：思考增量与执行事件都在这同一份轨迹里，
          // 界面不再另存一份流式文本，也就不会出现同一段思考显示两遍。
          latestTrace = trace;
          flushLiveTrace(trace);
        },
      });
      const processingSeconds = Math.max(1, Math.round((Date.now() - requestStartedAt) / 1000));
      const assistantMessage = await addMessage(sessionId, "assistant", response.content, {
        agentTrace: response.trace,
        ...(response.reasoning ? { reasoning: response.reasoning } : {}),
        ...(response.reasoningSegments?.length ? { reasoningSegments: response.reasoningSegments } : {}),
        processingSeconds,
        taskStatus: "completed",
        retryContext: { userMessageId: userMessage.id, modelId: runSelection.model.id, agentId: retry?.agentId ?? activeAgentId },
      });
      if (!isCurrentRequest()) return;
      setMessages((current) => {
        if (!retry) return [...current, assistantMessage];
        const sourceIndex = current.findIndex((message) => message.id === retry.sourceMessageId);
        return sourceIndex < 0 ? [...current, assistantMessage] : [...current.slice(0, sourceIndex), assistantMessage];
      });
      setRetryRequest(null);
      setLiveTrace(null);
      flushLiveTrace.cancel();
      stopFrameProbe();
      setUndoTarget(undoLabel());
      setAttachments([]);
    } catch (sendError) {
      const friendlyError = humanizeAgentError(sendError);
      // 失败必须留痕：此前这条路径只弹提示、不写诊断报告，复现时查不到任何记录。
      void appendCrashLog(
        "助手执行失败",
        friendlyError.detail ? `${friendlyError.message} —— ${friendlyError.detail}` : friendlyError.message,
      );
      if (isCurrentRequest()) setError(friendlyError.message);
      const failedTrace = sendError instanceof AgentRunError ? sendError.trace : latestTrace;
      const retryModelId = runSelection?.model.id ?? retry?.modelId ?? "";
      if (userMessageSaved && userMessage) {
        try {
          const failedMessage = await addMessage(
            sessionId,
            "assistant",
            "任务未完成：" + friendlyError.message,
            {
              agentTrace: failedTrace ?? undefined,
              taskStatus: "failed",
              errorMessage: friendlyError.message,
              errorDetail: friendlyError.detail,
              retryContext: { userMessageId: userMessage.id, modelId: retryModelId, agentId: retry?.agentId ?? activeAgentId },
            },
          );
          if (isCurrentRequest()) {
            setMessages((current) => [...current, failedMessage]);
            setRetryRequest({ sessionId, userMessage, history: nextHistory, sourceMessageId: failedMessage.id, modelId: retryModelId, agentId: retry?.agentId ?? activeAgentId });
            refreshData();
          }
        } catch {
          if (isCurrentRequest()) setRetryRequest({ sessionId, userMessage, history: nextHistory, sourceMessageId: retry?.sourceMessageId ?? "", modelId: retryModelId, agentId: retry?.agentId ?? activeAgentId });
        }
      }
      // 失败时不回填输入框：原话已经在消息列表里，重发走那条消息下方的「重试」。
      if (isCurrentRequest()) {
        setLiveTrace(null);
        flushLiveTrace.cancel();
        stopFrameProbe();
      }
    } finally {
      if (isCurrentRequest()) setSending(false);
    }
  };

  /**
   * 点「按这个计划开工」：把这份计划交给执行者继续。
   *
   * 执行者取这部作品当时指定的智能体；若它本身就是 Plan（Plan 只规划不动笔），退到
   * Build。选定后写进作品级设置，与手动换智能体走同一条存储。计划本身已经在对话历史里，
   * 这里只发一句指令，不重复贴一遍计划正文。
   */
  const startFromPlan = () => {
    if (sending || !effectiveProjectId) return;
    const followers = agentDefinitions.filter((agent) => agent.enabled && agent.kind === "primary");
    const executor = activeAgentId === PLAN_AGENT_ID
      ? followers.find((agent) => agent.id === "builtin-agent--build") ?? followers.find((agent) => agent.id !== PLAN_AGENT_ID)
      : undefined;
    if (executor) {
      void setSetting(activeAgentSettingKey(effectiveProjectId), executor.id);
      setActiveAgentId(executor.id);
      setActiveAgentName(executor.name);
    }
    void send(null, "按上面的计划开工。");
  };

  // send 与 startFromPlan 每次渲染都是新函数；这里用 ref 桥接，让行级回调保持稳定引用 ——
  // 否则消息项的浅比较失效，流式刷新仍旧把整屏历史重跑一遍。
  const sendRef = useRef(send);
  const startFromPlanRef = useRef(startFromPlan);
  useEffect(() => {
    sendRef.current = send;
    startFromPlanRef.current = startFromPlan;
  });

  /**
   * 重试参数按消息 id 惰性缓存。
   *
   * 算它要读整份 messages：放进行内时，每次渲染每行都会重算一遍。缓存之后每条只算一次，
   * 而且返回的引用稳定 —— 行的浅比较才有意义。
   */
  const retryFor = useMemo(() => {
    const cache = new Map<string, RetryRequest | null>();
    return (id: string) => {
      if (!cache.has(id)) {
        const message = messages.find((item) => item.id === id);
        cache.set(id, message
          ? retryRequestForMessage(message, messages, activeSession, selection, activeAgentId)
          : null);
      }
      return cache.get(id) ?? null;
    };
  }, [messages, activeSession, selection, activeAgentId]);

  const handleRowMeasure = useCallback((id: string, height: number) => {
    rowHeightsRef.current.set(id, height);
  }, []);

  const handleRowLongPress = useCallback((id: string, pageX: number, pageY: number, offsetY: number) => {
    setMessageMenu({
      id,
      pageX,
      // 按压点减去它在行内的位置 = 这条消息的上边缘（屏幕坐标）。
      rowTop: pageY - offsetY,
      rowHeight: rowHeightsRef.current.get(id) ?? 0,
    });
  }, []);

  const handleRowRetry = useCallback((retry: RetryRequest) => {
    void sendRef.current(retry);
  }, []);

  const handleRowStartPlan = useCallback(() => {
    startFromPlanRef.current();
  }, []);

  const messageKey = useCallback((item: ChatMessage) => item.id, []);

  const renderMessageRow = useCallback(({ item }: { item: ChatMessage }) => {
    // 跑动中的那一行：排版沿用原样（轨迹在上、正文在下），与落定后的消息同顺序。
    if (item.id === STREAMING_ROW_ID) {
      return (
        <View style={styles.liveTimeline}>
          {/* 跑动中的时长由组头自己写「已处理 Ns」，这里不再另画一行同义的状态条。 */}
          {liveTrace ? <AgentTraceView trace={liveTrace} defaultExpanded inline liveElapsedSeconds={thinkingSeconds} listAtBottomRef={atBottomRef} /> : null}
          {streamingContent ? (
            <View style={styles.streamingBubble}>
              <Text selectable style={[styles.messageText, chatTextStyle]}>{streamingContent}</Text>
            </View>
          ) : null}
        </View>
      );
    }
    return (
      <MessageRow
        item={item}
        retry={retryFor(item.id)}
        sending={sending}
        chatTextStyle={chatTextStyle}
        onLongPress={handleRowLongPress}
        onMeasureRow={handleRowMeasure}
        onRetry={handleRowRetry}
        onStartPlan={handleRowStartPlan}
      />
    );
  }, [chatTextStyle, handleRowLongPress, handleRowMeasure, handleRowRetry, handleRowStartPlan, liveTrace, retryFor, sending, streamingContent, thinkingSeconds]);

  const contextUsage = useMemo(
    () => computeContextUsage(messages, contextWindow, historyLimit),
    [contextWindow, historyLimit, messages],
  );

  // 不再为「首次没有数据」另开一屏：早退会把整棵页面树换成「顶栏 + 转圈」再换回来，
  // 那一下就是刷新感。页面骨架常驻，数据与空态都落在消息区这一格里替换。
  return (
    <Screen>
      <Header
        leading={(
          <ScalePress accessibilityLabel="作品与对话" hitSlop={{ left: 12 }} onPress={() => setDrawerVisible(true)} style={styles.headerMenuButton}>
            {/* 两条线，一长一短：与写作页左上角同一个入口画法，两页手势一致。 */}
            <View style={styles.menuGlyph}>
              <View style={[styles.menuGlyphBar, styles.menuGlyphBarLong]} />
              <View style={[styles.menuGlyphBar, styles.menuGlyphBarShort]} />
            </View>
          </ScalePress>
        )}
        title="助手"
        action={(
          <ScalePress accessibilityLabel="上下文占用" onPress={() => setContextSheetVisible(true)} style={styles.iconButton}>
            <Ionicons name="pie-chart-outline" size={20} color={colors.primary} />
          </ScalePress>
        )}
      />
      <View style={styles.contextBar}>
        <View style={styles.projectContext}>
          <Ionicons name="book-outline" size={19} color={colors.primary} />
          <View style={styles.projectCopy}>
            <Text style={styles.projectTitle} numberOfLines={1}>{project?.title ?? "当前作品"}</Text>
            <Text style={styles.agentLabel} numberOfLines={1}>{activeAgentName} 主智能体</Text>
          </View>
        </View>
        <Pressable
          accessibilityLabel="切换助手模型"
          disabled={!models.length || sending}
          onPress={() => { setAgentPickerStep("model"); setModelPickerVisible(true); }}
          style={styles.modelSelector}
        >
          <Ionicons name="hardware-chip-outline" size={17} color={selection ? colors.primary : colors.textMuted} />
          <Text style={[styles.modelSelectorText, !selection && styles.mutedText]} numberOfLines={1}>
            {selection?.model.name ?? "选择模型"}
          </Text>
          <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
        </Pressable>

      </View>
      <Pressable
        accessibilityRole="button"
        disabled={sending || updatingStyle}
        onPress={() => setStylePickerVisible(true)}
        style={styles.styleSelector}
      >
        {updatingStyle ? (
          <ActivityIndicator size="small" color={colors.primary} />
        ) : (
          <Ionicons name="color-wand-outline" size={17} color={activeStyleProfile ? colors.primary : colors.textMuted} />
        )}
        <Text style={[styles.styleSelectorText, activeStyleProfile && styles.styleSelectorTextActive]} numberOfLines={1}>
          {activeStyleProfile ? `${activeStyleProfile.name} V${activeStyleProfile.version}` : "不使用创作文风"}
        </Text>
        <Ionicons name="chevron-down" size={16} color={colors.textMuted} />
      </Pressable>
      <KeyboardAvoidingView ref={messagesAreaRef} onLayout={measureMessagesArea} style={styles.flex} behavior="height" automaticOffset>
        <FlatList
          style={styles.flex}
          onLayout={measureList}
          data={listData}
          keyExtractor={messageKey}
          // 倒置列表：offset 0 恒为最新，打开 / 切换 / 发送天然落在最新。
          // 不要再加 maintainVisibleContentPosition —— 它在每次内容尺寸变化时都会
          // 调整滚动偏移，而这条列表的内容尺寸变得很频繁（正在跑的那一行随字数增长、
          // 展开或收起执行轨迹也改高度），偏移被反复改写会把单元排到错误的
          // 位置上，表现为文字堆在一起或滑到一片空白。
          inverted
          // 只记位置、不写 state：跑完自动收起前要问"用户是不是停在最新这一端"。
          onScroll={(event) => { atBottomRef.current = event.nativeEvent.contentOffset.y <= 8; if (messageMenu) setMessageMenu(null); }}
          scrollEventThrottle={16}
          contentContainerStyle={listData.length ? styles.messages : styles.emptyMessages}
          // 实时轨迹与流式正文已移进 data 的第一项（见 liveRow）：它们占的正是落定消息的位置，
          // 回答结束时原地替换。列表头只剩写入确认卡 —— 它是覆盖层，不参与列表布局。
          ListHeaderComponent={(
            <View>
              {writeCard ? (
                <Modal visible transparent animationType="fade" onRequestClose={() => { /* 返回键不算决定：只有按按钮才算 */ }}>
                  <View style={styles.writeDialogBackdrop}>
                    <View style={styles.writeDialogCard}>
                      <View style={styles.writeCardHeader}>
                        <Text style={styles.writeCardTitle}>{TOOL_CATALOG.find((tool) => tool.key === writeCard.name)?.name ?? "写入确认"}</Text>
                        <Text numberOfLines={1} style={styles.writeCardTarget}>{writeCard.target ?? writeCard.name}</Text>
                        <Text style={styles.writeBadge}>待确认</Text>
                      </View>
                      {/* 新建作品是唯一会在书架里多出一部作品的动作（其余都落在当前作品内），
                          单列一行说明它落在哪，与写正文那几类分开。 */}
                      {writeCard.name === "create_project" ? (
                        <Text style={styles.writeCardAlert}>将在书架里新建一部作品，与当前作品并列</Text>
                      ) : null}
                      <AdaptiveScroll maxHeight={300} style={styles.writeCardScroll}>
                        {writeCard.actionOnly ? (
                          <Text style={styles.writeCardDetails}>{writeCard.after}</Text>
                        ) : writeCard.before !== undefined && writeCard.after !== undefined ? (() => {
                          const stats = diffLineStats(writeCard.before, writeCard.after);
                          const afterLines = writeCard.after.split("\n").filter((line) => line.trim().length > 0);
                          const beforeLines = writeCard.before.split("\n").filter((line) => line.trim().length > 0);
                          return (
                            <>
                              <View style={styles.writeStats}>
                                <Text style={styles.writeStatAdd}>+{stats.added} 行</Text>
                                <Text style={styles.writeStatDel}>−{stats.removed} 行</Text>
                              </View>
                              {/* 展开态要能读全：不限制每行显示几行，也不截断行数。角色设定、世界书
                                  条目是一整段没有换行的文本，按换行切只有一行 —— 旧写法给每行压了
                                  「最多两行」，整段就只显示得到开头两行；笔记同样受益，超过 120 行的
                                  内容此前会被切掉尾巴。 */}
                              {writeDiffExpanded ? (
                                <AdaptiveScroll maxHeight={260} style={styles.writeDiffScroll}>
                                  <Text style={styles.writeDiffLabel}>写入前</Text>
                                  {beforeLines.length === 0 ? (
                                    <Text style={styles.writeDiffDel}>− （当前为空）</Text>
                                  ) : beforeLines.map((line, idx) => (
                                    <Text key={"b" + idx} style={styles.writeDiffDel}>− {line}</Text>
                                  ))}
                                  <Text style={[styles.writeDiffLabel, styles.writeDiffLabelSpaced]}>写入后</Text>
                                  {afterLines.map((line, idx) => (
                                    <Text key={"a" + idx} style={styles.writeDiffAdd}>+ {line}</Text>
                                  ))}
                                </AdaptiveScroll>
                              ) : (
                                <View style={styles.writeDiff}>
                                  <Text style={styles.writeDiffLabel}>写入前</Text>
                                  {beforeLines.length === 0 ? (
                                    <Text style={styles.writeDiffDel}>− （当前为空）</Text>
                                  ) : beforeLines.slice(0, 2).map((line, idx) => (
                                    <Text key={"b" + idx} style={styles.writeDiffDel} numberOfLines={1}>− {line}</Text>
                                  ))}
                                  <Text style={[styles.writeDiffLabel, styles.writeDiffLabelSpaced]}>写入后</Text>
                                  {afterLines.slice(0, 3).map((line, idx) => (
                                    <Text key={"a" + idx} style={styles.writeDiffAdd} numberOfLines={1}>+ {line}</Text>
                                  ))}
                                </View>
                              )}
                              <Pressable accessibilityRole="button" onPress={() => setWriteDiffExpanded((value) => !value)} style={styles.writeDiffToggle}>
                                <Text style={styles.writeDiffToggleText}>{writeDiffExpanded ? "收起变更" : `展开全部 ${stats.added + stats.removed} 行变更`}</Text>
                                <Ionicons name={writeDiffExpanded ? "chevron-up" : "chevron-down"} size={15} color={colors.textMuted} />
                              </Pressable>
                            </>
                          );
                        })() : writeCard.details ? (
                          <Text style={styles.writeCardDetails}>{writeCard.details}</Text>
                        ) : null}
                      </AdaptiveScroll>
                      <View style={styles.writeCardActions}>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => {
                            if (writeCard.requestToken !== sendRequestRef.current) return;
                            writeCard.resolve(false);
                            setWriteCard(null);
                          }}
                          style={styles.writeCardButtonSecondary}
                        >
                          <Text style={styles.writeCardButtonSecondaryText}>驳回</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => {
                            if (writeCard.requestToken !== sendRequestRef.current) return;
                            writeCard.resolve(true);
                            setWriteCard(null);
                          }}
                          style={styles.writeCardButtonPrimary}
                        >
                          <Text style={styles.writeCardButtonPrimaryText}>接受</Text>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                </Modal>
              ) : null}
            </View>
          )}
          // 加载中不插任何中间态：这一段实测只有几十毫秒，画出来马上又抹掉，本身就是
          // 一次闪。慢到 200ms 以上才给转圈（slowHint）。空态容器的尺寸由 emptyMessages
          // 固定住，不渲染内容也不会产生位移。
          ListEmptyComponent={loading
            ? (slowHint ? (
              <View style={styles.loading}>
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : null)
            : models.length
              ? (
                <View style={styles.welcomeBox}>
                  <Text style={styles.welcomeTitle}>聊灵感、记想法</Text>
                  <View style={styles.welcomeChipsRow}>
                  {/* 建议只填进输入框：创建作品与会话留给点发送那一刻。 */}
                  {["记一个灵感", "梳理一下我的想法", "随便聊聊"].map((suggestion) => (
                    <ScalePress key={suggestion} style={styles.welcomeChip} onPress={() => setInput(suggestion)}>
                      <Text style={styles.welcomeChipText}>{suggestion}</Text>
                    </ScalePress>
                  ))}
                  </View>
                </View>
              )
              : (
                <EmptyState title="请先配置供应商并添加模型" action={<Button label="打开模型设置" onPress={() => navigation.navigate("Settings")} />} />
              )}
          renderItem={renderMessageRow}
        />
        {/* 长按菜单：上边缘贴被按那条消息的下边缘，中间不留间隙；下方放不下时翻到该条上方，
            底边贴它的上边缘。横向仍按按压点居中并夹在消息区内，点卡片外的任意位置收起。 */}
        {messageMenu ? (() => {
          const target = messages.find((message) => message.id === messageMenu.id) ?? null;
          if (!target) return null;
          const maxLeft = Math.max(spacing.sm, messagesArea.width - MESSAGE_MENU_WIDTH - spacing.sm);
          const maxTop = Math.max(spacing.sm, listLayout.height - MESSAGE_MENU_HEIGHT - spacing.sm);
          const left = Math.min(Math.max(messageMenu.pageX - messagesArea.x - MESSAGE_MENU_WIDTH / 2, spacing.sm), maxLeft);
          const rowTop = messageMenu.rowTop - messagesArea.y - listLayout.y;
          const rowBottom = rowTop + messageMenu.rowHeight;
          const topInList = listLayout.height - spacing.sm - rowBottom >= MESSAGE_MENU_HEIGHT
            ? rowBottom
            : Math.min(Math.max(rowTop - MESSAGE_MENU_HEIGHT, spacing.sm), maxTop);
          const top = topInList + listLayout.y;
          return (
            <View style={styles.messageMenuLayer} pointerEvents="box-none">
              <Pressable accessibilityLabel="关闭消息菜单" style={StyleSheet.absoluteFill} onPress={() => setMessageMenu(null)} />
              <View style={[styles.messageMenu, { left, top }]}>
                <Pressable accessibilityLabel="复制" onPress={() => { void Clipboard.setStringAsync(target.content); setMessageMenu(null); }} style={({ pressed }) => [styles.messageMenuRow, pressed && styles.composerMenuRowPressed]}>
                  <Ionicons name="copy-outline" size={16} color={colors.textMuted} />
                  <Text style={styles.composerMenuText}>复制</Text>
                </Pressable>
                <Pressable accessibilityLabel="选择文本" onPress={() => { setTextSelection(target); setMessageMenu(null); }} style={({ pressed }) => [styles.messageMenuRow, pressed && styles.composerMenuRowPressed]}>
                  <Ionicons name="text-outline" size={16} color={colors.textMuted} />
                  <Text style={styles.composerMenuText}>选择文本</Text>
                </Pressable>
                <Pressable accessibilityLabel="修改" disabled={sending} onPress={() => { setMessageMenu(null); beginEditMessage(target); }} style={({ pressed }) => [styles.messageMenuRow, pressed && styles.composerMenuRowPressed]}>
                  <Ionicons name="create-outline" size={16} color={colors.textMuted} />
                  <Text style={styles.composerMenuText}>修改</Text>
                </Pressable>
              </View>
            </View>
          );
        })() : null}
        {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={retryRequest ? () => void send(retryRequest) : () => void load()} /></View> : null}
        {undoTarget && !sending ? (
          <View style={styles.undoBanner}>
            <Text numberOfLines={1} style={styles.undoText}>AI 已改动「{undoTarget}」</Text>
            <Pressable accessibilityLabel="撤销 AI 上次改动" onPress={handleUndoWrite} style={styles.undoButton}>
              <Text style={styles.undoButtonText}>撤销</Text>
            </Pressable>
          </View>
        ) : null}
        {selection && selection.model.supportsTools === false ? (
          <View style={styles.capabilityNotice}>
            <Ionicons name="alert-circle-outline" size={16} color={colors.danger} />
            <Text style={styles.capabilityNoticeText}>
              当前模型已标注为不支持工具调用，助手只能对话、无法读写作品内容。若该模型实际支持，可在模型设置中改回。
            </Text>
          </View>
        ) : null}
        {composerMenu ? (
          <Pressable accessibilityLabel="关闭菜单" style={styles.composerMenuScrim} onPress={() => setComposerMenu(null)} />
        ) : null}
        {/* 吉祥物挂件：坐在输入框上沿，纯装饰不响应点击。可在设置里换/关（外观主题批）。 */}
        <View style={styles.composerWrap}>
          {mascotEnabled ? (
            <View
              style={[styles.mascot, { transform: [{ translateX: mascotOffset.x }, { translateY: mascotOffset.y }] }]}
              {...mascotPan.panHandlers}
            >
              <Image
                source={mascotSource(mascotKind)}
                style={[styles.mascotImage, { tintColor: colors.primary }]}
              />
            </View>
          ) : null}
          {attachments.length || pickedSkill ? (
            <View style={styles.attachmentRow}>
              {pickedSkill ? (
                <View style={styles.attachmentChip}>
                  <Ionicons name="sparkles-outline" size={14} color={colors.primary} />
                  <Text numberOfLines={1} style={styles.attachmentName}>{pickedSkill.name}</Text>
                  <Pressable accessibilityLabel={`取消技能 ${pickedSkill.name}`} onPress={() => setPickedSkill(null)} style={styles.attachmentRemove}>
                    <Ionicons name="close" size={15} color={colors.textMuted} />
                  </Pressable>
                </View>
              ) : null}
              {attachments.map((item) => (
                <View key={item.name} style={styles.attachmentChip}>
                  <Ionicons name="document-text-outline" size={14} color={colors.primary} />
                  <Text numberOfLines={1} style={styles.attachmentName}>{item.name}</Text>
                  <Text style={styles.attachmentMeta}>{item.characters} 字</Text>
                  <Pressable accessibilityLabel={`移除附件 ${item.name}`} onPress={() => setAttachments((current) => current.filter((entry) => entry.name !== item.name))} style={styles.attachmentRemove}>
                    <Ionicons name="close" size={15} color={colors.textMuted} />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          {editingMessageId ? (
            <View style={styles.editingBanner}>
              <View style={styles.editingCopy}>
                <Ionicons name="create-outline" size={17} color={colors.primary} />
                <Text style={styles.editingText}>正在编辑之前的发言</Text>
              </View>
              <ScalePress accessibilityLabel="取消编辑" onPress={cancelMessageEdit} style={styles.iconButton}>
                <Ionicons name="close" size={20} color={colors.textMuted} />
              </ScalePress>
            </View>
          ) : null}
          <View style={styles.composerArea}>
            {composerMenu ? (
              <View style={styles.composerMenu}>
                {composerMenu === "root" ? (
                  <>
                  <Pressable
                    accessibilityLabel="添加附件"
                    disabled={attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                    onPress={pickAttachment}
                    style={({ pressed }) => [styles.composerMenuRow, pressed && styles.composerMenuRowPressed,
                      attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE && styles.composerMenuRowDisabled]}
                  >
                    <Ionicons name="attach-outline" size={16} color={colors.textMuted} />
                    <Text style={styles.composerMenuText}>附件</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel="写入权限"
                    onPress={() => setComposerMenu("approval")}
                    style={({ pressed }) => [styles.composerMenuRow, pressed && styles.composerMenuRowPressed]}
                  >
                    <Ionicons name="lock-closed-outline" size={16} color={colors.textMuted} />
                    <Text style={styles.composerMenuText}>权限</Text>
                    <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
                  </Pressable>
                  <Pressable
                    accessibilityLabel="选择技能"
                    onPress={() => {
                      setComposerMenu("skill");
                      setSkillQuery("");
                      void listSelectableSkills().then(setSkillOptions).catch(() => setSkillOptions([]));
                    }}
                    style={({ pressed }) => [styles.composerMenuRow, pressed && styles.composerMenuRowPressed]}
                  >
                    <Ionicons name="sparkles-outline" size={16} color={colors.textMuted} />
                    <Text style={styles.composerMenuText}>技能</Text>
                    <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
                  </Pressable>
                </>
              ) : composerMenu === "approval" ? (
                <>
                  <Pressable accessibilityLabel="返回" onPress={() => setComposerMenu("root")} style={styles.composerMenuBack}>
                    <Ionicons name="chevron-back" size={13} color={colors.textMuted} />
                    <Text style={styles.composerMenuBackText}>权限</Text>
                  </Pressable>
                  <Text style={styles.composerMenuHint}>写入正文前的确认方式</Text>
                  {APPROVAL_MODES.map((mode) => (
                    <Pressable
                      key={mode.id}
                      accessibilityLabel={mode.label}
                      onPress={() => void changeWriteApproval(mode.id)}
                      style={[styles.approvalOption, writeApproval === mode.id && styles.approvalOptionActive]}
                    >
                      <View style={styles.approvalCopy}>
                        <Text style={[styles.approvalTitle, writeApproval === mode.id && styles.approvalTitleActive]}>
                          {mode.label}
                        </Text>
                        <Text style={styles.approvalHint}>{mode.hint}</Text>
                      </View>
                      {writeApproval === mode.id ? <Ionicons name="checkmark" size={15} color={colors.primary} /> : null}
                    </Pressable>
                  ))}
                </>
              ) : (
                <>
                  <Pressable accessibilityLabel="返回" onPress={() => setComposerMenu("root")} style={styles.composerMenuBack}>
                    <Ionicons name="chevron-back" size={13} color={colors.textMuted} />
                    <Text style={styles.composerMenuBackText}>技能</Text>
                  </Pressable>
                  <Text style={styles.composerMenuHint}>选中后本条消息强制加载该技能的完整指令</Text>
                  <TextInput
                    value={skillQuery}
                    onChangeText={setSkillQuery}
                    placeholder="搜索技能"
                    placeholderTextColor={colors.textMuted}
                    style={styles.skillSearch}
                  />
                  <AdaptiveScroll maxHeight={260} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.skillList}>
                    {skillOptions
                      .filter((skill) => {
                        const keyword = skillQuery.trim();
                        return !keyword || skill.name.includes(keyword) || skill.description.includes(keyword);
                      })
                      .map((skill) => (
                        <Pressable
                          key={skill.id}
                          accessibilityLabel={skill.name}
                          onPress={() => { setPickedSkill(skill); setComposerMenu(null); }}
                          style={[styles.approvalOption, pickedSkill?.id === skill.id && styles.approvalOptionActive]}
                        >
                          <View style={styles.approvalCopy}>
                            <Text style={[styles.approvalTitle, pickedSkill?.id === skill.id && styles.approvalTitleActive]}>{skill.name}</Text>
                            <Text style={styles.approvalHint}>{skill.description}</Text>
                          </View>
                          {pickedSkill?.id === skill.id ? <Ionicons name="checkmark" size={15} color={colors.primary} /> : null}
                        </Pressable>
                      ))}
                  </AdaptiveScroll>
                </>
              )}
            </View>
          ) : null}
          <View style={styles.composer}>
            <ScalePress
              accessibilityLabel="打开输入菜单"
              disabled={sending}
              onPress={() => setComposerMenu((current) => (current ? null : "root"))}
              style={({ pressed }) => [styles.attachButton, (pressed || sending) && styles.sendDisabled]}
            >
              <Ionicons name={composerMenu ? "close" : "add"} size={24} color={colors.primary} />
            </ScalePress>
            <TextInput
              ref={composerRef}
              value={input}
              onChangeText={setInput}
              onFocus={() => { setComposerMenu(null); setMessageMenu(null); }}
              style={styles.composerInput}
              placeholder={editingMessageId ? "修改后重新发送" : "输入创作任务"}
              placeholderTextColor={colors.textMuted}
              editable={!sending}
              multiline
              maxLength={12000}
            />
            <ScalePress
              accessibilityLabel={editingMessageId ? "重发编辑后的消息" : "发送"}
              disabled={!selection || !input.trim() || sending}
              onPress={() => void send(retryRequest && input.trim() === retryRequest.userMessage.content ? retryRequest : null)}
              style={({ pressed }) => [styles.sendButton, (pressed || !selection || !input.trim()) && styles.sendDisabled]}
            >
              {sending ? <ActivityIndicator color={colors.onPrimary} size="small" /> : <Ionicons name="arrow-up" size={20} color={colors.onPrimary} />}
            </ScalePress>
          </View>
          </View>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={contextSheetVisible} transparent animationType="fade" onRequestClose={() => setContextSheetVisible(false)}>
        <TopSheet
          title="上下文占用"
          subtitle="按字符估算，供观察趋势，非精确计费"
          onClose={() => setContextSheetVisible(false)}
        >
          <View style={styles.contextBody}>
            <View style={styles.contextMeter}>
              <View style={[styles.contextMeterFill, {
                width: `${Math.min(100, Math.round(contextUsage.ratio * 100))}%`,
                backgroundColor: contextUsage.overflow ? colors.danger : colors.primary,
              }]} />
            </View>
            <Text style={styles.contextPercent}>{formatUsagePercent(contextUsage.ratio)}</Text>
            <View style={styles.sheetRow}>
              <Text style={styles.sheetRowLabel}>估算占用</Text>
              <Text style={styles.sheetRowValue}>{contextUsage.estimatedTokens.toLocaleString()} / {contextUsage.windowTokens.toLocaleString()} Token</Text>
            </View>
            <View style={styles.sheetRow}>
              <Text style={styles.sheetRowLabel}>参与对话的消息</Text>
              <Text style={styles.sheetRowValue}>{contextUsage.keptMessages} 条 · {contextUsage.characters.toLocaleString()} 字</Text>
            </View>
            <View style={styles.sheetRow}>
              <Text style={styles.sheetRowLabel}>会话消息总数</Text>
              <Text style={styles.sheetRowValue}>{contextUsage.messages} 条</Text>
            </View>
            {contextUsage.droppedMessages > 0 ? (
              <Text style={styles.contextNote}>
                超出「保留最近消息数」的 {contextUsage.droppedMessages} 条不会发送给模型；需要它们参与时，可在设置 → 上下文提高保留条数。
              </Text>
            ) : null}
            {contextUsage.overflow ? (
              <Text style={[styles.contextNote, styles.contextNoteWarning]}>
                已超出所填窗口上限。继续追加内容可能导致模型截断或报错，建议新建对话，或调高「模型上下文窗口」的数值。
              </Text>
            ) : null}
            <Text style={styles.contextNote}>
              估算含约 1500 Token 的固定开销（系统提示、技能说明与工具定义）。实际占用随模型分词器不同会有偏差。
            </Text>
          </View>
        </TopSheet>
      </Modal>

      {/* 重命名作品与重命名对话共用同一张居中输入卡，与写作页是同一个组件、同一套数值。 */}
      <PromptDialog
        visible={renaming !== null}
        title={renaming?.kind === "project" ? "重命名作品" : "重命名对话"}
        label={renaming?.kind === "project" ? "作品名" : "对话标题"}
        value={renameTitle}
        onChangeText={setRenameTitle}
        onClose={() => setRenaming(null)}
        onConfirm={() => { void saveRename(); }}
        confirmDisabled={!renameTitle.trim()}
      />

      <BottomSheet
        visible={modelPickerVisible}
        title={agentPickerStep === "agent" ? "选择智能体" : "选择模型"}
        onClose={() => {
          setModelPickerVisible(false);
          setAgentPickerStep("model");
        }}
      >
        {agentPickerStep === "agent" ? (
          <FlatList
            style={styles.panelList}
            data={agentDefinitions.filter((agent) => agent.enabled && agent.kind === "primary")}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => {
              const selected = activeAgentId === item.id;
              return (
                <Pressable onPress={() => void chooseAgent(item.id)} style={[styles.sheetRow, selected && styles.sheetRowActive]}>
                  <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={selected ? colors.primary : colors.textMuted} />
                  <View style={styles.sheetRowText}>
                    <Text style={styles.sheetRowTitle} numberOfLines={1}>{item.name}</Text>
                    <Text style={styles.sheetRowMeta} numberOfLines={2}>{item.description}</Text>
                  </View>
                </Pressable>
              );
            }}
          />
        ) : (
          <>
            <Pressable onPress={() => setAgentPickerStep("agent")} style={styles.sheetRow}>
              <Ionicons name="git-branch-outline" size={20} color={colors.primary} />
              <View style={styles.sheetRowText}>
                <Text style={styles.sheetRowTitle} numberOfLines={1}>{activeAgentName} 主智能体</Text>
                <Text style={styles.sheetRowMeta} numberOfLines={1}>当前智能体</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </Pressable>
          <FlatList
              style={styles.panelList}
              data={models.filter((model) => model.id !== defaultModelId)}
              keyExtractor={(item) => item.id}
              ListHeaderComponent={
                <Pressable
                  onPress={() => void chooseModel(null)}
                  style={[
                    styles.sheetRow,
                    (explicitModelId === null || explicitModelId === defaultModelId) && styles.sheetRowActive,
                  ]}
                >
                  <Ionicons
                    name={explicitModelId === null || explicitModelId === defaultModelId ? "radio-button-on" : "radio-button-off"}
                    size={20}
                    color={explicitModelId === null || explicitModelId === defaultModelId ? colors.primary : colors.textMuted}
                  />
                  <View style={styles.sheetRowText}>
                    {/* 第一项是「此刻正在用的那个模型」。下面列表已把 defaultModelId 那一行
                        剔掉，所以这个名字在这个面板里只有这里能显示 —— 少了这一行，就只剩
                        「跟随」两个字，看不出落到哪个模型上。 */}
                    <Text style={styles.sheetRowTitle}>跟随默认模型</Text>
                    <Text style={styles.sheetRowMeta} numberOfLines={1}>
                      {models.find((model) => model.id === defaultModelId)?.name ?? "尚未选择默认模型"}
                    </Text>
                  </View>
                </Pressable>
              }
              renderItem={({ item }) => {
                const selected = explicitModelId === item.id;
                const provider = providerById.get(item.providerId);
                return (
                  <Pressable onPress={() => void chooseModel(item.id)} style={[styles.sheetRow, selected && styles.sheetRowActive]}>
                    <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={selected ? colors.primary : colors.textMuted} />
                    <View style={styles.sheetRowText}>
                      <Text style={styles.sheetRowTitle} numberOfLines={1}>{item.name}</Text>
                      <Text style={styles.sheetRowMeta} numberOfLines={1}>{provider?.name ?? "未知供应商"} · {item.modelId}</Text>
                    </View>
                  </Pressable>
                );
              }}
            />
          </>
        )}
      </BottomSheet>
      {/* 「选择文本」面板：与项目其它底部弹层同一形态，正文沿用弹层里既有的可选中文本样式。 */}
      <BottomSheet
        visible={textSelection !== null}
        title="选择文本"
        onClose={() => setTextSelection(null)}
      >
        <PlainScrollView style={styles.selectTextScroll} contentContainerStyle={styles.selectTextContent}>
          <Text selectable style={styles.selectTextBody}>{textSelection?.content ?? ""}</Text>
        </PlainScrollView>
      </BottomSheet>
      <BottomSheet
        visible={stylePickerVisible}
        title="选择创作文风"
        subtitle={project?.title ?? "当前作品"}
        onClose={() => setStylePickerVisible(false)}
      >
          <FlatList
              style={styles.panelList}
              data={styleProfiles}
              keyExtractor={(item) => item.id}
              ListHeaderComponent={(
                <Pressable onPress={() => void chooseStyle(null)} style={[styles.sheetRow, !activeStyleProfile && styles.sheetRowActive]}>
                  <Ionicons name={!activeStyleProfile ? "radio-button-on" : "radio-button-off"} size={20} color={!activeStyleProfile ? colors.primary : colors.textMuted} />
                  <View style={styles.sheetRowText}>
                    <Text style={styles.sheetRowTitle}>不使用文风</Text>
                    <Text style={styles.sheetRowMeta}>仅遵循作品设定和本轮要求</Text>
                  </View>
                </Pressable>
              )}
              renderItem={({ item }) => {
                const selected = item.id === activeStyleProfile?.id;
                return (
                  <Pressable onPress={() => void chooseStyle(item)} style={[styles.sheetRow, selected && styles.sheetRowActive]}>
                    <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={selected ? colors.primary : colors.textMuted} />
                    <View style={styles.sheetRowText}>
                      <Text style={styles.sheetRowTitle} numberOfLines={1}>{item.name} V{item.version}</Text>
                      <Text style={styles.sheetRowMeta}>{item.kind === "author" ? "当前作品作者文风" : "参考小说文风"}</Text>
                    </View>
                  </Pressable>
                );
              }}
            />
        </BottomSheet>

      {/* 切换作品与历史对话都由抽屉承担：顶栏不再单开选择器与面板，点作品行即切换。 */}
      <SessionDrawer
        visible={drawerVisible}
        projects={drawerProjects}
        currentProjectId={effectiveProjectId ?? ""}
        sessionsByProject={drawerSessions}
        activeSessionId={activeSession?.id ?? null}
        onClose={() => setDrawerVisible(false)}
        onSelectProject={(target) => {
          if (target.id === effectiveProjectId) return;
          // 切作品前先收抽屉：抽屉列表与助手页主区会在同一帧各自重渲染
          // （切作品还要跑一次 load() 的整页重载），两者叠在一起会掉一帧。
          // 选对话那条本来就先收抽屉，这里与之对齐。
          setDrawerVisible(false);
          setCurrentProject(target.id);
        }}
        onSelectSession={(target, session) => {
          setDrawerVisible(false);
          if (target.id === effectiveProjectId) {
            void switchSession(session);
            return;
          }
          // 换到那部作品，并把它的当前对话指向这一条：加载时按这个设置选中。
          setCurrentProject(target.id);
          void setSetting(activeSessionSettingKey(target.id), session.id);
        }}
        onCreateSession={(target) => { confirmNewSession(target); }}
        onRenameProject={(target) => {
          // 与写作页一致：先把抽屉收掉再弹居中卡，避免两层浮层同时占屏。
          setDrawerVisible(false);
          setRenaming({ kind: "project", project: target });
          setRenameTitle(target.title);
        }}
        onDeleteProject={confirmDeleteProject}
        onRenameSession={(_target, session) => {
          setDrawerVisible(false);
          setRenaming({ kind: "session", session });
          setRenameTitle(session.title);
        }}
        onDeleteSession={(_target, session) => { confirmDeleteSession(session); }}
      />

      {/* 提问卡：AI 停下来等你回答，所以浮在屏幕中间（一屏一题由组件内部管步进）。 */}
      <AgentQuestionSheet
        request={pendingQuestion}
        onSubmit={(answers) => finishQuestion({ answers, cancelled: false })}
        onCancel={() => finishQuestion({ answers: [], cancelled: true })}
      />

      {/* 先把卡收掉再执行动作：动作里可能再弹一张（例如存入资料的结果）。 */}
      <ConfirmDialog
        visible={Boolean(confirmRequest)}
        title={confirmRequest?.title ?? ""}
        message={confirmRequest?.message ?? ""}
        confirmLabel={confirmRequest?.confirmLabel}
        danger={confirmRequest?.danger}
        extraLabel={confirmRequest?.extraLabel}
        onClose={() => setConfirmRequest(null)}
        onConfirm={() => {
          const request = confirmRequest;
          setConfirmRequest(null);
          request?.onConfirm?.();
        }}
        onExtra={() => {
          const request = confirmRequest;
          setConfirmRequest(null);
          request?.onExtra?.();
        }}
      />
    </Screen>
  );
}

const styles = themedStyles((colors, shadow) => StyleSheet.create({
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  // 左上角那个入口单独一份，与写作页同一处理：图形贴 16dp，触摸区用 hitSlop 补回 44。
  headerMenuButton: { width: 32, height: 44, alignItems: "flex-start", justifyContent: "center" },
  // 顶栏入口：两条线，上长下短，与写作页左上角同一套画法。
  menuGlyph: { width: 20, gap: 5 },
  menuGlyphBar: { height: 2, borderRadius: 2, backgroundColor: colors.primary },
  menuGlyphBarLong: { width: 20 },
  menuGlyphBarShort: { width: 13 },
  contextBar: {
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  projectContext: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.sm },
  projectCopy: { flex: 1, minWidth: 0, gap: 2 },
  projectTitle: { flex: 1, color: colors.text, fontSize: 15, fontWeight: "700" },
  agentLabel: { color: colors.textMuted, fontSize: 11 },
  modelSelector: {
    maxWidth: "48%",
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: spacing.xs,
  },
  modelSelectorText: { flexShrink: 1, color: colors.primary, fontSize: 13, fontWeight: "700" },
  mutedText: { color: colors.textMuted },
  styleSelector: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  styleSelectorText: { flex: 1, minWidth: 0, color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  styleSelectorTextActive: { color: colors.primary },
  errorWrap: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  messages: { padding: spacing.lg, gap: spacing.md },
  liveTimeline: { marginTop: spacing.md, gap: spacing.sm },
  // 流式正文：与落定后的消息气泡同一套排版，只是还没进消息列表。
  streamingBubble: { gap: spacing.xs, paddingVertical: spacing.xs },
  // 与 messages 同内边距：消息从 0 条变为有内容时，容器的几何不跟着变，避免布局位移。
  // flexGrow 保留 —— 空态要让欢迎屏在剩余高度里居中。
  emptyMessages: { flexGrow: 1, padding: spacing.lg },
  // 消息内间距比别处紧一档（12 → 8）：过程轨迹与正文要连成一段，不能再被空档切开。
  message: { gap: spacing.sm, paddingVertical: spacing.md },
  messageEditRowOutside: { alignSelf: "flex-end", flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2, paddingRight: 2 },
  messageTime: { color: colors.textMuted, fontSize: 12 },
  userMessage: { alignSelf: "flex-end", maxWidth: "88%", paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceMuted },
  assistantMessage: {},
  messageText: { color: colors.text, fontSize: 16, lineHeight: 24 },
  failureCard: { alignSelf: "flex-start", flexShrink: 1, maxWidth: "88%", minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs, borderWidth: 1, borderColor: colors.dangerBorder, borderRadius: radius.sm, backgroundColor: colors.sand },
  failureTitle: { color: colors.danger, fontSize: 13, fontWeight: "700" },
  failureRetry: { minHeight: 28, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.sm, borderWidth: 1, borderColor: colors.danger, borderRadius: radius.sm },
  failureRetryDisabled: { opacity: 0.5 },
  failureRetryText: { color: colors.danger, fontSize: 12, fontWeight: "700" },
  composerWrap: { marginHorizontal: spacing.md, marginBottom: spacing.sm, gap: 6 },
  /** 输入框与它的菜单同处这一个容器：菜单绝对定位到这个容器里，容器高度不变，列表就不会被顶矮。 */
  composerArea: { position: "relative" },
  /** 只承接点击关闭，不做遮罩：早先那层 5% 黑几乎看不见，只让整列消息发灰。 */
  composerMenuScrim: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  composerMenu: {
    position: "absolute",
    bottom: "100%",
    left: 6,
    marginBottom: 6,
    width: 236,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.xs,
    ...shadow.card,
  },
  // 消息长按菜单：横向随按压点居中、纵向贴被按消息的下边缘（left / top 由消息行的边界算出），
  // 宽 175、行高 45 照参考实测，其余取现有值。
  messageMenuLayer: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  messageMenu: {
    position: "absolute",
    width: 175,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.xs,
    ...shadow.card,
  },
  messageMenuRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 45, paddingHorizontal: spacing.md },
  // 「选择文本」面板的正文：内边距与字号照文风库那个弹层的可选中文本，高度上限由弹层给。
  selectTextScroll: { flexShrink: 1 },
  selectTextContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  selectTextBody: { color: colors.text, fontSize: 14, lineHeight: 21 },
  composerMenuRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 40, paddingHorizontal: spacing.md },
  composerMenuRowPressed: { backgroundColor: colors.surfaceMuted },
  composerMenuRowDisabled: { opacity: 0.55 },
  composerMenuText: { flex: 1, color: colors.text, fontSize: 14 },
  composerMenuBack: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 26, paddingHorizontal: spacing.md },
  composerMenuBackText: { color: colors.textMuted, fontSize: 11 },
  composerMenuHint: { paddingHorizontal: spacing.md, paddingBottom: spacing.xs, color: colors.textMuted, fontSize: 11 },
  // 技能面板的搜索框：比设置页那一个收一档（34 高 / 13 号），与面板里的技能名同档。
  // paddingVertical 归零是必须的：输入框自带上下内边距，不显式压住的话高度会多出约 8dp。
  skillSearch: { minHeight: 34, marginHorizontal: spacing.md, marginBottom: spacing.xs, paddingHorizontal: spacing.md, paddingVertical: 0, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.background, color: colors.text, fontSize: 13 },
  skillList: { paddingBottom: spacing.xs },
  approvalOption: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, marginHorizontal: spacing.xs, borderRadius: radius.sm, padding: spacing.sm },
  approvalOptionActive: { backgroundColor: colors.surfaceMuted },
  approvalCopy: { flex: 1 },
  approvalTitle: { color: colors.text, fontSize: 13 },
  approvalTitleActive: { color: colors.primary },
  approvalHint: { marginTop: 2, color: colors.textMuted, fontSize: 11, lineHeight: 16 },
  composer: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 6, paddingRight: 6, paddingVertical: 6, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, borderRadius: 999, ...shadow.card },
  writeBadge: { marginLeft: "auto", color: colors.primary, fontSize: 11, fontWeight: "800", backgroundColor: "rgba(23,107,87,0.12)", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, overflow: "hidden" },
  // 写入确认卡与提问卡同一套居中卡形态：遮罩 0.48、卡内边距 24、圆角 14、底色跟页面同色。
  writeDialogBackdrop: { flex: 1, justifyContent: "center", padding: spacing.lg, backgroundColor: colors.overlay },
  writeDialogCard: {
    maxHeight: "80%",
    gap: spacing.md,
    padding: spacing.xl,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  writeCardScroll: { maxHeight: 300 },
  writeCardHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  writeCardTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  writeCardTarget: { flexShrink: 1, minWidth: 0, color: colors.textMuted, fontSize: 12 },
  writeCardDetails: { marginTop: spacing.xs, color: colors.text, fontSize: 12, lineHeight: 18 },
  writeCardAlert: { color: colors.accent, fontSize: 12, lineHeight: 18, fontWeight: "700" },
  writeCardActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, marginTop: spacing.sm },
  // 与提问卡的两个按钮同一套尺寸（34 / 13），比共享 Button 小一档。
  writeCardButtonSecondary: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
  },
  writeCardButtonSecondaryText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  writeCardButtonPrimary: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  writeCardButtonPrimaryText: { color: colors.onPrimary, fontSize: 13, fontWeight: "600" },
  writeStats: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.md, paddingVertical: spacing.xs },
  writeStatAdd: { color: colors.success, fontSize: 12, fontWeight: "800" },
  writeStatDel: { color: colors.danger, fontSize: 12, fontWeight: "800" },
  writeDiffScroll: { maxHeight: 260, marginTop: spacing.sm },
  writeDiffToggle: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, marginTop: spacing.xs, paddingVertical: spacing.sm + 2 },
  writeDiffToggleText: { color: colors.textMuted, fontSize: 13 },
  writeDiffToggleHint: { color: colors.textMuted, fontSize: 12, flexShrink: 1, textAlign: "right" },
  writeDiff: { marginTop: spacing.sm, gap: 4 },
  writeDiffLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "700" },
  writeDiffLabelSpaced: { marginTop: spacing.xs },
  writeDiffAdd: { color: colors.success, fontSize: 12, lineHeight: 18 },
  writeDiffDel: { color: colors.danger, fontSize: 12, lineHeight: 18 },
  mascot: { position: "absolute", right: 14, top: -40, width: 40, height: 44 },
  mascotImage: { width: "100%", height: "100%", resizeMode: "contain" },
  welcomeBox: { flexGrow: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, paddingHorizontal: spacing.xl },
  welcomeChipsRow: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
  welcomeTitle: { color: colors.text, fontSize: 17, fontWeight: "700", marginBottom: spacing.xs },
  welcomeChip: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: colors.background },
  welcomeChipText: { color: colors.textMuted, fontSize: 11.5 },
  editingBanner: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  undoBanner: { minHeight: 36, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.md, paddingVertical: spacing.xs, backgroundColor: colors.primarySoft, borderRadius: 8 },
  attachmentRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  attachmentChip: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "100%", paddingHorizontal: 9, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.primarySoft },
  attachmentName: { color: colors.text, fontSize: 12, maxWidth: 150 },
  attachmentMeta: { color: colors.textMuted, fontSize: 11 },
  attachmentRemove: { padding: 2 },
  attachButton: { width: 38, height: 38, alignItems: "center", justifyContent: "center", borderRadius: 19 },
  undoText: { flex: 1, color: colors.text, fontSize: 13 },
  undoButton: { minWidth: 56, minHeight: 30, alignItems: "center", justifyContent: "center", borderRadius: 6, backgroundColor: colors.primary },
  undoButtonText: { color: colors.onPrimary, fontSize: 13, fontWeight: "600" },
  editingCopy: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  editingText: { color: colors.primary, fontSize: 13, fontWeight: "600" },
  composerInput: { flex: 1, maxHeight: 130, minHeight: 40, paddingHorizontal: spacing.sm, paddingVertical: 10, color: colors.text, fontSize: 16 },
  sendButton: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", backgroundColor: colors.primary },
  sendDisabled: { opacity: 0.48 },
  sheetRow: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  // 弹层里的列表：高度上限由面板给，超出在这里滚。
  panelList: { flexShrink: 1 },
  sheetRowActive: { backgroundColor: colors.surfaceMuted },
  sheetRowText: { flex: 1, minWidth: 0 },
  sheetRowTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
  sheetRowMeta: { marginTop: 3, color: colors.textMuted, fontSize: 12 },
  contextMeter: { height: 8, marginHorizontal: spacing.lg, borderRadius: 4, overflow: "hidden", backgroundColor: colors.surfaceMuted },
  contextMeterFill: { height: 8, borderRadius: 4 },
  contextPercent: { marginTop: spacing.sm, marginHorizontal: spacing.lg, color: colors.text, fontSize: 26, fontWeight: "700" },
  sheetRowLabel: { color: colors.textMuted, fontSize: 13 },
  sheetRowValue: { color: colors.text, fontSize: 13, fontWeight: "600" },
  contextNote: { marginTop: spacing.sm, marginHorizontal: spacing.lg, color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  // 面板最后一条说明不贴下沿。
  contextBody: { paddingBottom: spacing.xl },
  contextNoteWarning: { color: colors.danger },
  capabilityNotice: { flexDirection: "row", alignItems: "flex-start", gap: 6, marginHorizontal: spacing.md, marginBottom: spacing.xs, padding: spacing.sm, borderRadius: 8, backgroundColor: colors.dangerSoftStrong },
  capabilityNoticeText: { flex: 1, color: colors.danger, fontSize: 12, lineHeight: 18 },
}));

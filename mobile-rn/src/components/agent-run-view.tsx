import { Ionicons } from "@expo/vector-icons";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardAvoidingView as KeyboardAvoider } from "react-native-keyboard-controller";
import { AdaptiveScroll } from "@/components/ui";
import { colors, radius, spacing } from "@/theme";
import type {
  AgentClarificationAnswer,
  AgentClarificationRequest,
  AgentRunTrace,
  AgentTraceEvent,
  AgentTraceEventKind,
  AgentTraceEventStatus,
} from "@/types";

/**
 * 三级，每一级只靠缩进与字体表达，不画任何线（竖线也画过，字与圈被挤得看不出层次）。
 *
 *   第一级 · 组头（处理完成 · 用时 · 字数）           节点左缘 0
 *   第二级 · 思考过程 / 执行完成（连续调用的外壳）     节点左缘 8
 *   第三级 · 一次具体的调用（已执行 询问用户）         节点左缘 16
 *
 * 第四层不是级别：第三级展开出来的「参数 / 结果」是那一行的内容，与它的文字同列（左缘 34）。
 */
const MONO_FONT = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

/**
 * 行首的节点，一个标记同时承担"节点"与"状态"：跑着是转圈、完成是实心或空心、失败是叉。
 *
 * 行里不再另放图标 —— 在干什么由那一行的文字说（工具名、技能名、提问），
 * 图形再说一遍就是同一件事写两遍。
 */
function TraceNode({ status, lead = false }: { status: AgentTraceEventStatus; lead?: boolean }) {
  if (status === "running" || status === "waiting") {
    return <ActivityIndicator size="small" color={colors.primary} />;
  }
  if (status === "error") return <Ionicons name="close" size={lead ? 13 : 11} color={colors.danger} />;
  return <View style={lead ? styles.nodeLead : styles.nodeChild} />;
}

function runStatus(trace: AgentRunTrace): { label: string; color: string } {
  if (trace.status === "error") return { label: "执行失败", color: colors.danger };
  if (trace.events.some((event) => event.status === "waiting")) return { label: "等待你的操作", color: colors.accent };
  if (trace.status === "running") return { label: "正在协作", color: colors.primary };
  return { label: "已完成", color: colors.primary };
}

/**
 * 事件类型 → 跑动时那一行用的短名。
 *
 * 提问 / 技能 / 子智能体这三类的 title 里带着智能体名，直接显示等于把名字绕回来一次，
 * 所以改用固定短名；工具类的 title 本身就是纯动作名，可以直接用。
 */
const EVENT_KIND_LABELS: Partial<Record<AgentTraceEventKind, string>> = {
  question: "向你提问",
  skill: "加载技能",
  agent: "子智能体协作",
};

/**
 * 组头标题：跟着助手当前这一步走。
 *
 * 展开前就能看出它此刻在做什么，比固定写「已完成」有信息量。两处要收窄，否则会把
 * 重复信息带回组头：标题取短名而非 event.title —— 提问与子智能体的 title 形如
 * 「Build 的提问」，带智能体名；末尾思考段完成时写「处理完成」，与摘除末段思考配套。
 */
function activityLabel(
  lines: ReadonlyArray<{ kind: "reasoning" | "event"; short?: string; running?: boolean }>,
  trace: AgentRunTrace,
): { label: string; color: string } {
  if (trace.status === "error") return { label: "执行失败", color: colors.danger };
  if (trace.events.some((event) => event.status === "waiting")) return { label: "等待你的操作", color: colors.accent };
  const last = lines[lines.length - 1];
  if (!last) return runStatus(trace);
  if (!last.running) return { label: "处理完成", color: colors.primary };
  // 还在跑：报出此刻在做什么。
  if (last.kind === "reasoning") return { label: "思考中", color: colors.primary };
  return { label: last.short ?? "处理中", color: colors.primary };
}

function EventPayload({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.payload}>
      <Text style={styles.payloadLabel}>{label}</Text>
      <Text selectable style={styles.payloadText}>{value}</Text>
    </View>
  );
}

/**
 * 第二级：一段连续的调用。
 *
 * 一轮里常连着调好几个工具（读章节、核对角色、写章节），逐个平铺会让"这一轮动了哪些手"
 * 散成一片；包成一组之后，第二级是「执行完成 · N 项」，第三级才是每一次调用。
 *
 * 这一层不做折叠：一轮只有一个折叠（组头那个），多一个箭头就多一次"点了没反应"。
 * 组里的状态由下面每一行的节点自己说，这一行只报整组的结果。
 */
function TraceEventGroup({ events }: { events: AgentTraceEvent[] }) {
  const running = events.some((event) => event.status === "running" || event.status === "waiting");
  const failed = events.some((event) => event.status === "error");
  const label = failed ? "执行中断" : running ? "正在执行" : "执行完成";
  return (
    <View>
      <View style={styles.groupHeader}>
        <View style={styles.nodeSlotGroup}>
          <View style={[styles.nodeGroup, failed && styles.nodeGroupFailed]} />
        </View>
        <Text style={styles.groupTitle}>
          {label}
          {events.length > 1 ? ` · ${events.length} 项` : ""}
        </Text>
      </View>
      {events.map((event) => <TraceEventRow key={event.id} event={event} />)}
    </View>
  );
}

/** 第三级：一次具体的调用（「已执行 询问用户」这种）。行首一个节点，节点兼作状态。 */
function TraceEventRow({ event }: { event: AgentTraceEvent }) {
  const [expanded, setExpanded] = useState(false);
  const hasPayload = Boolean(event.input || event.output);
  return (
    <View>
      <Pressable
        accessibilityRole={hasPayload ? "button" : undefined}
        accessibilityState={hasPayload ? { expanded } : undefined}
        disabled={!hasPayload}
        onPress={() => setExpanded((value) => !value)}
        style={styles.eventHeader}
      >
        <View style={styles.nodeSlotChild}>
          <TraceNode status={event.status} />
        </View>
        <View style={styles.eventCopy}>
          <View style={styles.eventTitleLine}>
            <Text style={styles.eventTitle} numberOfLines={2}>{event.title}</Text>
            {/* 提问与子智能体协作的 title 本身已带智能体名（"Build 的提问"），
                右边再挂一次 agentName 就是同一行内重复，所以只在 title 不含它时补。 */}
            {event.agentName && !event.title.includes(event.agentName) ? (
              <Text style={styles.agentName} numberOfLines={1}>{event.agentName}</Text>
            ) : null}
          </View>
          {event.detail ? <Text style={styles.eventDetail} numberOfLines={expanded ? undefined : 2}>{event.detail}</Text> : null}
        </View>
        {hasPayload ? (
          <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={17} color={colors.textMuted} />
        ) : null}
      </Pressable>
      {expanded ? (
        <View style={styles.payloads}>
          {event.input ? <EventPayload label="参数" value={event.input} /> : null}
          {event.output ? <EventPayload label="结果" value={event.output} /> : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * 时间线里的一段思考。
 *
 * 组内的一段，不是独立折叠：没有自己的箭头，展开由外层那个合集统一控制。
 * 「用时」与「字数」也不在这里写 —— 两样都由组头承担一次，段内再写一遍就是同一件事说两遍。
 */
export function ReasoningSegment({ text, live }: { text: string; live?: boolean }) {
  return (
    <View style={styles.reasoningSegment}>
      <View style={styles.reasoningSegmentHeader}>
        <View style={styles.nodeSlotChild}>
          <TraceNode status={live ? "running" : "completed"} />
        </View>
        <Text style={[styles.reasoningSegmentTitle, live && styles.reasoningSegmentTitleLive]}>
          {live ? "思考中" : "思考过程"}
        </Text>
      </View>
      <View style={styles.reasoningSegmentBody}>
        <Text selectable style={styles.reasoningSegmentText}>{text}</Text>
      </View>
    </View>
  );
}

export type TraceLine = {
  kind: "reasoning" | "event";
  id?: string;
  text?: string;
  short?: string;
  running?: boolean;
  live?: boolean;
};

/**
 * 时间线的行 = 段落的唯一映射。
 *
 * 抽成纯函数是为了能脱离组件直接验证：同一份 segments 算两遍必须得到同一结果
 * —— 实时看到的与关掉重开看到的必须是同一条线。
 *
 * 段落只有一个来源：`segments`。流式思考在生成侧就追加进末段，界面不再另拼一份
 * 实时文本，也就不会出现同一段思考显示两遍。旧数据没有 segments 时，退回
 * 「思考全在前 + 事件全在后」的兜底排法。
 */
export function buildTraceLines(input: {
  segments?: Array<{ kind: string; text?: string; eventId?: string; live?: boolean }>;
  events: AgentTraceEvent[];
  reasoningSegments?: Array<{ text: string; seconds?: number; live?: boolean }>;
}): TraceLine[] {
  const collected: TraceLine[] = [];
  const eventsById = new Map(input.events.map((event) => [event.id, event]));
  if (input.segments?.length) {
    for (const segment of input.segments) {
      if (segment.kind === "reasoning") {
        if ((segment.text ?? "").trim()) {
          collected.push({ kind: "reasoning", text: segment.text, live: segment.live });
        }
      } else if (segment.eventId && eventsById.has(segment.eventId)) {
        const event = eventsById.get(segment.eventId)!;
        collected.push({
          kind: "event",
          id: event.id,
          short: EVENT_KIND_LABELS[event.kind] ?? event.title.trim(),
          running: event.status === "running" || event.status === "waiting",
        });
      }
    }
    return collected;
  }
  for (const segment of input.reasoningSegments ?? []) {
    if (segment.text.trim()) collected.push({ kind: "reasoning", text: segment.text });
  }
  for (const event of input.events) {
    collected.push({
      kind: "event",
      id: event.id,
      short: EVENT_KIND_LABELS[event.kind] ?? event.title.trim(),
      running: event.status === "running" || event.status === "waiting",
    });
  }
  return collected;
}

/**
 * 一轮回复 = 一个合集。
 *
 * 一个折叠、一个箭头，组内所有内容一起展开收起，段落自身不再各带箭头。展开后是
 * 一条按真实顺序排下来的线 —— 思考与工具事件混在里面，不写死谁在前。
 *
 * 此前组头、思考行、每个工具行各带一个箭头，等于三层独立折叠：点开思考行会与
 * 外层争状态，用户看到的是"点了没反应"。收敛成一个折叠后不存在这个问题。
 *
 * 组头只留三样：节点、状态词、用时与合计字数。工具名不进组头 —— 一多就
 * 会被挤成几个字，而展开后每行都写着它。
 *
 * 展开后是三级：组头 → 思考段 / 「执行完成」壳（连续的调用合成一组）→ 每一次调用。
 * 具体一级的「参数 / 结果」是那一行的内容，不算级别。
 *
 * 收起时机：跑着展开（过程要看得到），跑完收起（体量不能一直占屏）。失败除外 ——
 * 报错必须一眼看见。收起前还要问一句外层列表是不是停在最新（`listAtBottomRef`）：
 * 用户正往上翻历史时收，高度一变矮就会把他看的位置拽走。
 */
export function AgentTraceView({
  trace,
  defaultExpanded = false,
  durationSeconds,
  liveElapsedSeconds,
  inline = false,
  reasoningSegments,
  listAtBottomRef,
}: {
  trace: AgentRunTrace;
  defaultExpanded?: boolean;
  /** 本轮总耗时（秒）：完成态在组头写一次，组内不再重复。 */
  durationSeconds?: number;
  /** 跑动中的已用时（秒）：跑着的时候写「已处理 Ns」，替代助手页另画的那一行。 */
  liveElapsedSeconds?: number;
  /** 时间线形态：不画卡片外框与底色，组直接铺在消息/实时时间线里。 */
  inline?: boolean;
  /** 全部思考段落，按真实顺序；旧数据可回落到单个 reasoning 文本 */
  reasoningSegments?: Array<{ text: string; seconds?: number; live?: boolean }>;
  /**
   * 外层消息列表此刻是否停在最新一条。传 ref 的用意在这里：收起发生在"状态变化那一
   * 刻"，那时组件不一定重渲染，只有 ref 拿得到当下的真实位置。
   */
  listAtBottomRef?: RefObject<boolean>;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded || trace.status === "running");
  const previousStatus = useRef(trace.status);

  // 只在状态真的发生变化时收，避免覆盖调用方给 defaultExpanded 的显式意图。
  useEffect(() => {
    const changed = previousStatus.current !== trace.status;
    previousStatus.current = trace.status;
    if (trace.status === "running") {
      setExpanded(true);
      return;
    }
    // 用户正往上翻历史时不动：这一下高度变矮会把他看的位置拽走。停在最新这一端时照旧
    // 收 —— 那正是收起来最不打扰人的时刻。
    const atBottom = listAtBottomRef ? listAtBottomRef.current : true;
    if (changed && trace.status !== "error" && atBottom) setExpanded(false);
  }, [trace.status, listAtBottomRef]);

  const eventsById = useMemo(() => new Map(trace.events.map((event) => [event.id, event])), [trace.events]);
  const lines = useMemo(
    () => buildTraceLines({ segments: trace.segments, events: trace.events, reasoningSegments }),
    [trace.segments, trace.events, reasoningSegments],
  );

  // 末段思考是模型给出正面前的最后一步，它的内容已经由助手正文表达了；再留在
  // 时间线里就是同一件事说了两遍，所以完成态把它摘掉。
  // 流式期间不摘 —— 那一段正是正在增长的思考，还没有对应的正文。
  const visibleLines = useMemo(() => {
    if (trace.status === "running") return lines;
    if (lines.length < 2) return lines;
    const tail = lines[lines.length - 1];
    if (tail.kind === "reasoning" && !tail.live) return lines.slice(0, -1);
    return lines;
  }, [lines, trace.status]);

  const status = useMemo(() => activityLabel(visibleLines, trace), [visibleLines, trace]);

  // 连续的调用合成一组：第二级是「执行完成」，第三级才是每一次调用。思考段自成一块，
  // 与执行组同级、按真实顺序交替出现。
  const blocks = useMemo(() => {
    const out: Array<{ key: string; reasoning?: TraceLine; events?: AgentTraceEvent[] }> = [];
    for (const line of visibleLines) {
      if (line.kind === "reasoning") {
        out.push({ key: `reasoning-${out.length}`, reasoning: line });
        continue;
      }
      const event = line.id ? eventsById.get(line.id) : undefined;
      if (!event) continue;
      const tail = out[out.length - 1];
      if (tail?.events) tail.events.push(event);
      else out.push({ key: event.id, events: [event] });
    }
    return out;
  }, [visibleLines, eventsById]);

  // 字数合计：收起后只剩组头，展开区还可能被截断，总数只有这里说得清。
  const reasoningChars = useMemo(
    () => visibleLines.reduce((sum, line) => sum + (line.kind === "reasoning" ? (line.text ?? "").trim().length : 0), 0),
    [visibleLines],
  );

  const nodeStatus: AgentTraceEventStatus =
    trace.status === "running" ? "running" : trace.status === "error" ? "error" : "completed";
  const elapsedLabel = trace.status === "running"
    ? (liveElapsedSeconds ? `已处理 ${liveElapsedSeconds}s` : undefined)
    : durationSeconds
      ? `用时 ${durationSeconds}s${reasoningChars ? ` · ${reasoningChars} 字` : ""}`
      : undefined;

  return (
    <View style={[styles.trace, inline && styles.traceInline]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={expanded ? "收起处理过程" : "展开处理过程"}
        onPress={() => setExpanded((value) => !value)}
        style={styles.traceHeader}
      >
        <View style={styles.nodeSlotLead}>
          <TraceNode status={nodeStatus} lead />
        </View>
        <Text style={[styles.traceStatus, { color: status.color }]} numberOfLines={1}>{status.label}</Text>
        <View style={styles.traceSpacer} />
        {elapsedLabel ? <Text style={styles.traceElapsed}>{elapsedLabel}</Text> : null}
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color={colors.textMuted} />
      </Pressable>
      {expanded && visibleLines.length ? (
        // 思考与正文连着同一条滚动：这里不再留自己的限高滚动区 —— 框一旦滑到头就会把
        // 手势抢走，表现成「滑不动、还回弹」。跑动时要贴最新一行由外层列表天然承担
        // （它本身就是"最新在底"的装法）。
        <View style={styles.events}>
          {trace.collaborationRequired ? (
            <View style={styles.collaborationNotice}>
              <Ionicons name="people-outline" size={16} color={colors.primary} />
              <Text style={styles.collaborationText}>此任务可按需调用专业子智能体协作</Text>
            </View>
          ) : null}
          {blocks.map((block) =>
            block.reasoning ? (
              <ReasoningSegment key={block.key} text={block.reasoning.text ?? ""} live={block.reasoning.live} />
            ) : (
              <TraceEventGroup key={block.key} events={block.events ?? []} />
            ),
          )}
        </View>
      ) : null}
    </View>
  );
}

type QuestionAnswerState = Record<number, string>;
type CustomAnswerState = Record<number, boolean>;

/**
 * 提问卡：一屏一题。
 *
 * 与写入确认卡同属「AI 停下来等用户」的两种卡，所以形态与口径也一致：浮在屏幕中间的
 * 卡 + 遮罩；只有按按钮才算回答 —— 点遮罩、系统返回键都不关，否则等于替用户作了决定。
 *
 * 一屏一题是刻意的：问题个数没有上限（工具定义就是"问题列表"），一次全列出来必然要在
 * 卡里滚；一题一屏之后，卡永远只有一屏高。
 */
export function AgentQuestionSheet({
  request,
  onSubmit,
  onCancel,
}: {
  request: AgentClarificationRequest | null;
  onSubmit: (answers: AgentClarificationAnswer[]) => void;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<QuestionAnswerState>({});
  const [customAnswers, setCustomAnswers] = useState<CustomAnswerState>({});
  const [step, setStep] = useState(0);

  useEffect(() => {
    setAnswers({});
    setCustomAnswers({});
    setStep(0);
  }, [request?.id]);

  if (!request) return null;

  const total = request.questions.length;
  const index = Math.min(step, total - 1);
  const question = request.questions[index];
  const isLast = index >= total - 1;
  const answered = (at: number) => Boolean(answers[at]?.trim());
  const canSubmit = request.questions.every((_, at) => answered(at));
  const submit = () => {
    if (!canSubmit) return;
    onSubmit(request.questions.map((entry, at) => ({
      question: entry.title,
      answer: answers[at].trim(),
    })));
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => { /* 返回键不算回答，卡保持等待 */ }}>
      <KeyboardAvoider style={styles.questionBackdrop} behavior="height" automaticOffset>
        <View style={styles.questionSheet}>
          <View style={styles.questionHeader}>
            <View style={styles.questionHeaderIcon}>
              <Ionicons name="help-circle-outline" size={21} color={colors.primary} />
            </View>
            <View style={styles.questionHeaderCopy}>
              <Text style={styles.questionSheetTitle}>{request.agentName} 需要你的选择</Text>
              <Text style={styles.questionProgress}>第 {index + 1} / {total} 题</Text>
            </View>
            <Pressable accessibilityLabel="稍后回答" onPress={onCancel} style={styles.closeButton}>
              <Ionicons name="close" size={24} color={colors.textMuted} />
            </Pressable>
          </View>
          <AdaptiveScroll maxHeight={320} contentContainerStyle={styles.questions} keyboardShouldPersistTaps="handled">
            <View style={styles.question}>
              <Text style={styles.questionIndex}>问题 {index + 1}</Text>
              <Text style={styles.questionTitle}>{question.title}</Text>
              {question.description ? <Text style={styles.questionDescription}>{question.description}</Text> : null}
              <View accessibilityRole="radiogroup" style={styles.options}>
                {question.options.map((option, optionIndex) => {
                  const selected = !customAnswers[index] && answers[index] === option.label;
                  return (
                    <Pressable
                      key={`${option.label}-${optionIndex}`}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                      onPress={() => {
                        setCustomAnswers((current) => ({ ...current, [index]: false }));
                        setAnswers((current) => ({ ...current, [index]: option.label }));
                      }}
                      style={[styles.option, selected && styles.optionSelected]}
                    >
                      <Ionicons
                        name={selected ? "radio-button-on" : "radio-button-off"}
                        size={20}
                        color={selected ? colors.primary : colors.textMuted}
                      />
                      <View style={styles.optionCopy}>
                        <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>{option.label}</Text>
                        {option.description ? <Text style={styles.optionDescription}>{option.description}</Text> : null}
                      </View>
                    </Pressable>
                  );
                })}
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: Boolean(customAnswers[index]) }}
                  onPress={() => {
                    setCustomAnswers((current) => ({ ...current, [index]: true }));
                    setAnswers((current) => ({ ...current, [index]: "" }));
                  }}
                  style={[styles.option, customAnswers[index] && styles.optionSelected]}
                >
                  <Ionicons
                    name={customAnswers[index] ? "radio-button-on" : "radio-button-off"}
                    size={20}
                    color={customAnswers[index] ? colors.primary : colors.textMuted}
                  />
                  <Text style={[styles.optionLabel, customAnswers[index] && styles.optionLabelSelected]}>
                    自行输入答案
                  </Text>
                </Pressable>
                {customAnswers[index] ? (
                  <TextInput
                    autoFocus
                    multiline
                    maxLength={1200}
                    onChangeText={(value) => setAnswers((current) => ({ ...current, [index]: value }))}
                    placeholder="输入你的决定或补充"
                    placeholderTextColor={colors.textMuted}
                    style={styles.customInput}
                    value={answers[index] ?? ""}
                  />
                ) : null}
              </View>
            </View>
          </AdaptiveScroll>
          <View style={styles.questionActions}>
            <Pressable accessibilityRole="button" onPress={onCancel} style={styles.questionButtonSecondary}>
              <Text style={styles.questionButtonSecondaryText}>稍后再说</Text>
            </Pressable>
            {isLast ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !canSubmit }}
                disabled={!canSubmit}
                onPress={submit}
                style={[styles.questionButtonPrimary, !canSubmit && styles.questionButtonDisabled]}
              >
                <Text style={styles.questionButtonPrimaryText}>提交回答</Text>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !answered(index) }}
                disabled={!answered(index)}
                onPress={() => setStep(index + 1)}
                style={[styles.questionButtonPrimary, !answered(index) && styles.questionButtonDisabled]}
              >
                <Text style={styles.questionButtonPrimaryText}>下一题</Text>
              </Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoider>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // 组根：不画外框与底色，状态行与后续轨迹直接落在消息/实时时间线上。
  trace: { alignSelf: "flex-start", flexShrink: 1, maxWidth: "88%" },
  traceInline: { borderWidth: 0, borderRadius: 0, backgroundColor: "transparent" },
  // 层级由"各行的 paddingLeft + 节点容器宽度"共同决定，动其中一处要一起看。一档取 8：
  // 深一档只是"往里让一点"（20 太松、12 看着仍远），三级正文被推得太靠右时一条消息里显空。
  //   第一级（组头）     paddingLeft 0 + nodeSlotLead 14 ⇒ 文字 22
  //   第二级（思考/执行完成）paddingLeft 8 + nodeSlotChild 10 ⇒ 文字 26
  //   第三级（一次调用）  paddingLeft 16 + nodeSlotChild 10 ⇒ 文字 34
  // 三个节点标记：第一级实心稍大（兼状态）、第二级小实心点（只表示"这是一组"）、
  // 第三级空心圈（兼状态）。
  nodeSlotLead: { width: 14, alignItems: "center", justifyContent: "center" },
  nodeLead: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.primary },
  nodeSlotChild: { width: 10, alignItems: "center", justifyContent: "center" },
  nodeChild: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: colors.textMuted },
  nodeSlotGroup: { width: 10, height: 10, alignItems: "center", justifyContent: "center" },
  nodeGroup: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.textMuted },
  nodeGroupFailed: { backgroundColor: colors.danger },
  // 组头：节点左缘与正文左缘对齐（圆心 = 半径 7），所以左侧不留内边距。
  traceHeader: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  traceStatus: { flexShrink: 0, fontSize: 13, fontWeight: "700" },
  traceSpacer: { flex: 1 },
  traceElapsed: { flexShrink: 0, color: colors.textMuted, fontSize: 12 },
  events: {},
  // 第二级「执行完成」：与「思考过程」同一档缩进，差别是它下面还挂着第三级。
  groupHeader: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: 8,
    paddingVertical: spacing.xs,
  },
  groupTitle: { flexShrink: 1, color: colors.text, fontSize: 13 },
  collaborationNotice: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: "#E8F2EE",
  },
  collaborationText: { flex: 1, color: colors.primary, fontSize: 12, fontWeight: "600" },
  // 思考段：组内的一段，没有自己的折叠箭头；正文与子行文字同列，不再自成一块。
  reasoningSegment: { paddingHorizontal: 0 },
  reasoningSegmentHeader: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 42, paddingLeft: 8 },
  reasoningSegmentTitle: { color: colors.text, fontSize: 13 },
  reasoningSegmentTitleLive: { color: colors.primary },
  reasoningSegmentText: { color: colors.textMuted, fontSize: 13, lineHeight: 20 },
  reasoningSegmentBody: { marginTop: spacing.xs, paddingLeft: 26 },
  // 第三级：具体的一次调用。行高与上面两级一致，层级只靠缩进，不靠尺寸。
  eventHeader: {
    minHeight: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingLeft: 16,
    paddingVertical: spacing.xs,
  },
  eventCopy: { flexShrink: 1, minWidth: 0 },
  eventTitleLine: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  eventTitle: { flexShrink: 1, color: colors.text, fontSize: 13 },
  agentName: { flexShrink: 1, color: colors.textMuted, fontSize: 11 },
  eventDetail: { marginTop: 3, color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  // 「参数 / 结果」是第三级那一行的内容，与那一行的文字同列（+34 = 上面 paddingLeft 16 +
  // 节点 10 + 间隔 8）。不铺底色、不画线：等宽字体与两个标签已经说明它是数据，不是正文。
  payloads: { gap: spacing.sm, paddingLeft: 34, paddingBottom: spacing.sm },
  payload: { gap: spacing.xs },
  payloadLabel: { color: colors.textMuted, fontSize: 11, fontWeight: "700" },
  payloadText: { color: colors.text, fontSize: 12, lineHeight: 18, fontFamily: MONO_FONT },
  // 提问卡与写入确认卡同一套：浮在屏幕中间 + 遮罩 0.48，数值与全项目的居中卡一致。
  questionBackdrop: { flex: 1, justifyContent: "center", padding: spacing.lg, backgroundColor: colors.overlay },
  questionSheet: {
    maxHeight: "80%",
    borderRadius: radius.md,
    backgroundColor: colors.background,
    overflow: "hidden",
  },
  questionHeader: {
    // 标题原来顶到卡片上缘：这里原本只有一行 44 高、没有上下内边距，18 号标题几乎贴着卡边。
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.xs,
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  questionHeaderIcon: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
  },
  questionHeaderCopy: { flex: 1, minWidth: 0 },
  questionSheetTitle: { color: colors.text, fontSize: 18, fontWeight: "700" },
  questionProgress: { marginTop: 2, color: colors.textMuted, fontSize: 12 },
  closeButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  questions: { padding: spacing.lg, paddingBottom: spacing.lg, gap: spacing.lg },
  question: { gap: spacing.sm },
  questionIndex: { color: colors.primary, fontSize: 11, fontWeight: "700" },
  questionTitle: { color: colors.text, fontSize: 14, fontWeight: "700", lineHeight: 21 },
  questionDescription: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  options: { gap: spacing.sm, marginTop: spacing.xs },
  option: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
  },
  optionSelected: { borderColor: colors.primary, backgroundColor: colors.surfaceMuted },
  optionCopy: { flex: 1, minWidth: 0 },
  optionLabel: { color: colors.text, fontSize: 13, fontWeight: "600" },
  optionLabelSelected: { color: colors.primary },
  optionDescription: { marginTop: 3, color: colors.textMuted, fontSize: 11.5, lineHeight: 17 },
  customInput: {
    minHeight: 88,
    maxHeight: 160,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
    textAlignVertical: "top",
  },
  questionActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  questionButtonSecondary: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
  },
  questionButtonSecondaryText: { color: colors.text, fontSize: 13, fontWeight: "600" },
  questionButtonPrimary: {
    minHeight: 34,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
  },
  questionButtonDisabled: { opacity: 0.45 },
  questionButtonPrimaryText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
  });

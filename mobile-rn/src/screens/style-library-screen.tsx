import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { BottomSheet, Button, ConfirmDialog, EmptyState, ErrorNotice, ExpandableField, Field, Header, PlainScrollView, ScalePress, Screen } from "@/components/ui";
import {
  createStyleProfileVersion,
  deleteStyleProfile,
  getActiveStyleProfile,
  listStyleProfiles,
  listStyleProfilesForSource,
  listStyleSources,
  renameStyleSource,
  setActiveStyleProfile,
} from "@/data/style-repositories";
import { resolveModelSelection } from "@/llm/selection";
import { listChapters } from "@/data/repositories";
import type { RootStackParamList } from "@/navigation/types";
import {
  distillReferenceStyle,
  getStyleDistillationCheckpoint,
  getStyleDistillationCoverage,
  type StyleDistillationCheckpoint,
  type StyleDistillationCoverage,
} from "@/settings/lorn-style-plugin";
import { importStyleSource, deleteStyleSource } from "@/style/source-library";
import { useAppStore } from "@/store/app-store";
import { colors, radius, spacing, themedStyles } from "@/theme";
import { useAppearance } from "@/theme-context";
import type { StyleProfile, StyleSource } from "@/types";

function formatBytes(value: number): string {
  if (value < 1024) return String(value) + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

function formatName(source: StyleSource): string {
  if (source.format === "epub") return "EPUB";
  if (source.format === "docx") return "Word";
  return source.format === "markdown" ? "Markdown" : "TXT";
}

/**
 * 删除是不可逆的，走居中确认卡；与写作页、助手页用的是同一个组件。
 */
type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

export function StyleLibraryScreen() {
  // 订阅外观档位：样式表由 themedStyles 的 Proxy 在**读样式键时**才重建，而 StyleSheet.create
  // 的结果会随元素 props 一起固化 —— 屏组件不重渲染，它产出的元素就还带着上一档的 style 引用。
  // 外壳 Screen 订阅只能让外壳换色，屏内元素仍旧停在旧档（背景变了、正文没变）。
  useAppearance();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const projectId = useAppStore((state) => state.currentProjectId);
  const [sources, setSources] = useState<StyleSource[]>([]);
  const [profiles, setProfiles] = useState<StyleProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<StyleProfile | null>(null);
  const [selectedSource, setSelectedSource] = useState<StyleSource | null>(null);
  const [sourceProfiles, setSourceProfiles] = useState<StyleProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<StyleProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [distillationError, setDistillationError] = useState<string | null>(null);
  const [distillationProgress, setDistillationProgress] = useState("");
  const [distillationStep, setDistillationStep] = useState<{ stage: string; completed: number; total: number } | null>(null);
  /** 全流程进度：抽样 10% / 分析 70% / 汇总 15% / 保存 5%，避免条子在不同阶段来回跳。 */
  const distillationPercent = (() => {
    if (!distillationStep) return 0;
    const span: Record<string, [number, number]> = { sampling: [0, 10], analyzing: [10, 80], synthesizing: [80, 95], saving: [95, 100] };
    const [base, end] = span[distillationStep.stage] ?? [0, 100];
    const ratio = distillationStep.total > 0 ? Math.min(1, distillationStep.completed / distillationStep.total) : 0;
    return Math.round(base + (end - base) * ratio);
  })();
  const [distillationCheckpoint, setDistillationCheckpoint] = useState<StyleDistillationCheckpoint | null>(null);
  const [distillationCoverage, setDistillationCoverage] = useState<StyleDistillationCoverage | null>(null);
  const [distillationModelName, setDistillationModelName] = useState<string | null>(null);
  const [sourceTitle, setSourceTitle] = useState("");
  const [editingSource, setEditingSource] = useState(false);
  const [editingAuthorGuide, setEditingAuthorGuide] = useState(false);
  const [authorGuide, setAuthorGuide] = useState("");
  // 「作者文风指南」默认限高，点标签行右边的箭头摊平；指南通常很长，摊开交给弹层滚动。
  const [guideExpanded, setGuideExpanded] = useState(false);
  /** 章节 id → 章节名，用来把作者文风的来源章节显示成人能读的名字。 */
  const [chapterTitles, setChapterTitles] = useState<Map<string, string>>(new Map());

  const authorProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === "author"),
    [profiles],
  );
  const referenceProfiles = useMemo(
    () => profiles.filter((profile) => profile.kind === "reference"),
    [profiles],
  );
  /**
   * 作者文风的来源章节标题。没有来源（例如助手在对话里直接发起）不显示；
   * 章节已被删除时明确写出来，避免看起来像"没记录"。
   */
  const sourceLabelFor = (profile: StyleProfile | null): string | null => {
    if (!profile || profile.kind !== "author" || !profile.sourceChapterId || !projectId) return null;
    const chapterTitle = chapterTitles.get(profile.sourceChapterId);
    return chapterTitle ? "来自：" + chapterTitle : "来源章节已删除";
  };
  const coverageStarted = Boolean(distillationCoverage && distillationCoverage.coveredUntil > 0);
  const coverageFinished = Boolean(distillationCoverage
    && distillationCoverage.coveredUntil >= distillationCoverage.totalUnits);
  const coverageUnitName = distillationCoverage?.unitKind === "segment" ? "段" : "章";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextSources = await listStyleSources();
      const nextProfiles = await listStyleProfiles(projectId ?? "");
      const nextActive = projectId ? await getActiveStyleProfile(projectId) : null;
      const nextChapters = projectId ? await listChapters(projectId) : [];
      setSources(nextSources);
      setProfiles(nextProfiles);
      setChapterTitles(new Map(nextChapters.map((chapter) => [chapter.id, chapter.title])));
      setActiveProfile(nextActive);
      if (nextActive?.kind === "author") setAuthorGuide(nextActive.guide);
      // 蒸馏跟随全局默认模型，界面上要说清楚是哪一个。
      setDistillationModelName(await resolveModelSelection()
        .then((selection) => selection.model.name)
        .catch(() => null));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const openSource = async (source: StyleSource) => {
    setSelectedSource(source);
    setEditingSource(false);
    setSourceTitle(source.title);
    setError(null);
    setDistillationError(null);
    setDistillationProgress("");
    setDistillationStep(null);
    try {
      const [nextProfiles, checkpoint, coverage] = await Promise.all([
        listStyleProfilesForSource(source.id),
        getStyleDistillationCheckpoint(source.id),
        getStyleDistillationCoverage(source.id),
      ]);
      setSourceProfiles(nextProfiles);
      setDistillationCheckpoint(checkpoint);
      setDistillationCoverage(coverage?.contentHash === source.contentHash ? coverage : null);
    } catch (sourceError) {
      setError(sourceError instanceof Error ? sourceError.message : String(sourceError));
      setSourceProfiles([]);
    }
  };

  const closeSource = () => {
    if (busy) return;
    setSelectedSource(null);
    setSourceProfiles([]);
    setEditingSource(false);
    setDistillationError(null);
    setDistillationProgress("");
    setDistillationStep(null);
    setDistillationCheckpoint(null);
    setDistillationCoverage(null);
  };

  const importBook = async () => {
    setBusy(true);
    setError(null);
    try {
      const source = await importStyleSource();
      if (source) {
        await load();
        await openSource(source);
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setBusy(false);
    }
  };

  const openProfile = (profile: StyleProfile) => {
    setSelectedSource(null);
    setSourceProfiles([]);
    setSelectedProfile(profile);
    setEditingAuthorGuide(false);
    if (profile.kind === "author") setAuthorGuide(profile.guide);
  };

  const distill = async (restart = false) => {
    if (!selectedSource) return;
    setBusy(true);
    setError(null);
    setDistillationError(null);
    setDistillationProgress(restart ? "重新开始蒸馏章节样本" : "准备蒸馏章节样本");
    try {
      const selection = await resolveModelSelection();
      const result = await distillReferenceStyle({
        sourceId: selectedSource.id,
        selection,
        restart,
        onProgress: ({ stage, label, completed, total }) => {
          setDistillationStep({ stage, completed, total });
          setDistillationProgress(total > 1 ? `${label}（${completed}/${total}）` : label);
        },
      });
      setSourceProfiles((current) => [result.profile, ...current.filter((item) => item.id !== result.profile.id)]);
      setProfiles((current) => [result.profile, ...current.filter((item) => item.id !== result.profile.id)]);
      setDistillationCheckpoint(null);
      setDistillationCoverage(result.coverage);
      openProfile(result.profile);
    } catch (distillError) {
      const message = distillError instanceof Error ? distillError.message : String(distillError);
      setError(message);
      setDistillationError(message);
      const [checkpoint, coverage] = await Promise.all([
        getStyleDistillationCheckpoint(selectedSource.id).catch(() => null),
        getStyleDistillationCoverage(selectedSource.id).catch(() => null),
      ]);
      setDistillationCheckpoint(checkpoint);
      setDistillationCoverage(coverage?.contentHash === selectedSource.contentHash ? coverage : null);
    } finally {
      setBusy(false);
    }
  };

  const activate = async (profile: StyleProfile | null) => {
    if (!projectId) {
      setError("请先从书架打开一部作品，再选择创作文风");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setActiveStyleProfile(projectId, profile?.id ?? null);
      setActiveProfile(profile);
      if (profile) setSelectedProfile(profile);
    } catch (activateError) {
      setError(activateError instanceof Error ? activateError.message : String(activateError));
    } finally {
      setBusy(false);
    }
  };

  const saveSourceTitle = async () => {
    if (!selectedSource || !sourceTitle.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await renameStyleSource(selectedSource.id, sourceTitle);
      setSources((current) => current.map((source) => source.id === updated.id ? updated : source));
      setSelectedSource(updated);
      setEditingSource(false);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : String(renameError));
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteSource = () => {
    if (!selectedSource) return;
    setConfirmRequest({
      title: "删除参考书",
      message: "确定删除《" + selectedSource.title + "》及其全部参考文风版本？原文件只保存在本机。",
      confirmLabel: "删除",
      onConfirm: () => {
        setBusy(true);
        void deleteStyleSource(selectedSource.id)
          .then(async () => {
            setSelectedSource(null);
            setSourceProfiles([]);
            await load();
          })
          .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)))
          .finally(() => setBusy(false));
      },
    });
  };

  const saveAuthor = async () => {
    if (!projectId || !authorGuide.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const profile = await createStyleProfileVersion({
        projectId,
        kind: "author",
        name: "我的作者文风",
        guide: authorGuide,
        activateForProjectId: projectId,
      });
      setProfiles((current) => [profile, ...current.filter((item) => item.id !== profile.id)]);
      setActiveProfile(profile);
      setSelectedProfile(profile);
      setEditingAuthorGuide(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  const removeProfile = (profile: StyleProfile) => {
    setConfirmRequest({
      title: "删除文风版本",
      message: "确定删除“" + profile.name + " V" + profile.version + "”？",
      confirmLabel: "删除",
      onConfirm: () => {
        setBusy(true);
        void deleteStyleProfile(profile.id)
          .then(async () => {
            if (activeProfile?.id === profile.id) setActiveProfile(null);
            setSelectedProfile(null);
            await load();
          })
          .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)))
          .finally(() => setBusy(false));
      },
    });
  };

  if (loading) {
    return <Screen><Header title="文风书库" onBack={() => navigation.goBack()} /><View style={styles.loading}><ActivityIndicator color={colors.primary} /></View></Screen>;
  }

  return (
    <Screen>
      <Header
        title="文风书库"
        onBack={() => navigation.goBack()}
        action={(
          <ScalePress accessibilityLabel="导入参考小说" disabled={busy} onPress={() => void importBook()} style={styles.iconButton}>
            {busy ? <ActivityIndicator size="small" color={colors.primary} /> : <Ionicons name="add" size={26} color={colors.primary} />}
          </ScalePress>
        )}
      />
      {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void load()} /></View> : null}
      <FlatList
        data={sources}
        keyExtractor={(item) => item.id}
        contentContainerStyle={sources.length ? styles.list : styles.emptyList}
        ListHeaderComponent={(
          <View style={styles.headerContent}>
            <View style={styles.intro}>
              <View style={styles.introIcon}><Ionicons name="color-wand-outline" size={24} color={colors.primary} /></View>
              <View style={styles.introCopy}>
                <Text style={styles.introTitle}>参考文风与作者文风</Text>
                <Text style={styles.introText}>导入本机小说后，使用当前默认模型提取独立文风 Skill。原书不会自动上传，只有蒸馏时发送抽样文本。</Text>
              </View>
            </View>
            {projectId ? (
              <View style={styles.activeStrip}>
                <Ionicons name="checkmark-circle-outline" size={19} color={colors.primary} />
                <Text style={styles.activeStripText} numberOfLines={2}>
                  当前使用：{activeProfile ? activeProfile.name + " V" + activeProfile.version : "不使用文风"}
                </Text>
                {activeProfile ? <Pressable onPress={() => void activate(null)} disabled={busy} style={styles.clearActive}><Text style={styles.clearActiveText}>清除</Text></Pressable> : null}
              </View>
            ) : null}
            {authorProfiles.length ? (
              <View style={styles.sectionHeading}>
                <Text style={styles.sectionTitle}>我的作者文风</Text>
                <Text style={styles.sectionMeta}>{authorProfiles.length} 个版本</Text>
              </View>
            ) : null}
            {authorProfiles.map((profile) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                active={activeProfile?.id === profile.id}
                onPress={() => openProfile(profile)}
                onActivate={() => void activate(profile)}
                disabled={busy || !projectId}
                sourceLabel={sourceLabelFor(profile)}
                inset
              />
            ))}
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>参考小说</Text>
              <Text style={styles.sectionMeta}>{sources.length} 本</Text>
            </View>
          </View>
        )}
        ListEmptyComponent={(
          <EmptyState
            title="还没有参考小说"
            action={<Button label="导入 TXT / Markdown / EPUB / Word" onPress={() => void importBook()} disabled={busy} loading={busy} />}
          />
        )}
        renderItem={({ item }) => (
          <Pressable onPress={() => void openSource(item)} style={({ pressed }) => [styles.sourceRow, pressed && styles.sourceRowPressed]}>
            <View style={styles.bookIcon}><Ionicons name="book-outline" size={23} color={colors.primary} /></View>
            <View style={styles.sourceCopy}>
              <Text style={styles.sourceTitle} numberOfLines={1}>{item.title}</Text>
              <Text style={styles.sourceMeta} numberOfLines={1}>{formatName(item)} · {formatBytes(item.sizeBytes)} · {item.characterCount.toLocaleString()} 字</Text>
              <Text style={styles.sourceMeta} numberOfLines={1}>{referenceProfiles.some((profile) => profile.sourceId === item.id) ? "已生成参考文风" : "尚未蒸馏文风"}</Text>
            </View>
            <Ionicons name="chevron-forward" size={19} color={colors.textMuted} />
          </Pressable>
        )}
      />

      <BottomSheet
        visible={Boolean(selectedSource)}
        title={editingSource ? "编辑参考书" : (selectedSource?.title ?? "")}
        subtitle={selectedSource ? formatName(selectedSource) + " · " + formatBytes(selectedSource.sizeBytes) + " · " + selectedSource.characterCount.toLocaleString() + " 字" : ""}
        onClose={closeSource}
      >
          {editingSource ? (
            <View style={styleSheetPad}>
              <Field label="参考书名称" value={sourceTitle} onChangeText={setSourceTitle} autoFocus />
            </View>
          ) : null}
            <PlainScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
              {editingSource ? (
                <View style={styles.inlineActions}>
                  <Button label="取消" variant="secondary" onPress={() => setEditingSource(false)} />
                  <Button label="保存名称" onPress={() => void saveSourceTitle()} disabled={!sourceTitle.trim()} loading={busy} />
                </View>
              ) : (
                <View style={styles.inlineActions}>
                  <Button
                    label={coverageStarted ? "继续蒸馏" : "蒸馏文风"}
                    onPress={() => void distill()}
                    disabled={busy || coverageFinished}
                    loading={busy}
                  />
                  {coverageStarted || distillationCheckpoint ? (
                    <Button label="重新开始" variant="secondary" onPress={() => void distill(true)} disabled={busy} />
                  ) : null}
                  <ScalePress accessibilityLabel="重命名参考书" onPress={() => setEditingSource(true)} style={styles.secondaryIconAction}>
                    <Ionicons name="create-outline" size={21} color={colors.text} />
                  </ScalePress>
                  <ScalePress accessibilityLabel="删除参考书" onPress={confirmDeleteSource} style={styles.secondaryIconAction}>
                    <Ionicons name="trash-outline" size={21} color={colors.danger} />
                  </ScalePress>
                </View>
              )}
              {distillationError ? <ErrorNotice message={distillationError} onRetry={() => void distill()} /> : null}
              {distillationCoverage ? (
                <View style={styles.checkpointBox}>
                  <Text style={styles.checkpointTitle}>
                    {coverageFinished ? "已覆盖全书" : `已完成 ${distillationCoverage.rounds} 轮蒸馏`}
                  </Text>
                  <Text style={styles.checkpointText}>
                    覆盖到第 {distillationCoverage.coveredUntil}/{distillationCoverage.totalUnits} {coverageUnitName}。
                    {coverageFinished
                      ? "继续积累样本请点击“重新开始”重新扫描全书。"
                      : "点击“继续蒸馏”会向后随机跳到未读区域，再取一段连续样本并入现有指南。"}
                  </Text>
                </View>
              ) : null}
              {distillationCheckpoint ? (
                <View style={styles.checkpointBox}>
                  <Text style={styles.checkpointTitle}>检测到未完成的蒸馏任务</Text>
                  <Text style={styles.checkpointText}>
                    第 {distillationCheckpoint.windowStart + 1}-{distillationCheckpoint.windowStart + distillationCheckpoint.windowCount} {coverageUnitName}已完成 {Math.min(distillationCheckpoint.completedMemos.length, distillationCheckpoint.batchCount)}/{distillationCheckpoint.batchCount} 批。继续蒸馏会从断点接着跑，不会重复已完成批次。
                  </Text>
                </View>
              ) : null}
              {distillationProgress ? (
                <View style={styles.progressBox}>
                  <View style={styles.progressTrack}>
                    <View style={[styles.progressFill, { width: `${distillationPercent}%` }]} />
                  </View>
                  <Text style={styles.progressText}>{distillationProgress} · {distillationPercent}%</Text>
                </View>
              ) : (
                // 覆盖进度与「继续蒸馏会向后跳」由上方 checkpointBox 负责，
                // 这里只讲抽取方式，不重复同一件事。
                <Text style={styles.helperText}>
                  每轮抽取连续 24 {coverageUnitName}、分 4 批分析后并入文风指南，不会上传整本小说。
                </Text>
              )}
              <Text style={styles.helperText}>
                蒸馏使用当前默认模型：{distillationModelName ?? "尚未选择默认模型"}
              </Text>
              <Text style={styles.sheetSectionTitle}>参考文风版本</Text>
              {sourceProfiles.length ? sourceProfiles.map((profile) => (
                <ProfileRow
                  key={profile.id}
                  profile={profile}
                  active={activeProfile?.id === profile.id}
                  onPress={() => openProfile(profile)}
                  onActivate={() => void activate(profile)}
                  disabled={busy || !projectId}
                />
              )) : <Text style={styles.emptyHint}>还没有版本，点击“蒸馏文风”生成。</Text>}
            </PlainScrollView>
        </BottomSheet>

      <BottomSheet
        visible={Boolean(selectedProfile)}
        title={selectedProfile ? selectedProfile.name + " V" + selectedProfile.version : ""}
        subtitle={selectedProfile?.kind === "author"
          ? ["作者文风版本", sourceLabelFor(selectedProfile)].filter(Boolean).join(" · ")
          : "参考小说文风版本"}
        onClose={() => setSelectedProfile(null)}
      >
            <PlainScrollView style={styles.sheetScroll} contentContainerStyle={styles.profileContent}>
              {selectedProfile?.kind === "author" && editingAuthorGuide ? (
                <ExpandableField label="作者文风指南" value={authorGuide} onChangeText={setAuthorGuide} expanded={guideExpanded} onToggle={() => setGuideExpanded((value) => !value)} maxLength={100000} />
              ) : (
                <Text selectable style={styles.guideText}>{selectedProfile?.guide}</Text>
              )}
            </PlainScrollView>
            {/* 按钮钉在弹层底部：指南再长也不会把它顶出可视区。 */}
            <View style={styles.profileActionsBar}>
              <View style={styles.inlineActions}>
                {selectedProfile?.kind === "author" ? (
                  <Button
                    label={editingAuthorGuide ? "保存新版本" : "编辑指南"}
                    onPress={() => {
                      if (editingAuthorGuide) void saveAuthor();
                      else {
                        setGuideExpanded(false);
                        setEditingAuthorGuide(true);
                      }
                    }}
                    disabled={busy || (editingAuthorGuide && !authorGuide.trim())}
                    loading={busy}
                  />
                ) : null}
                <Button
                  label={activeProfile?.id === selectedProfile?.id ? "已在使用" : "用于创作"}
                  variant={activeProfile?.id === selectedProfile?.id ? "secondary" : "primary"}
                  onPress={() => void activate(selectedProfile)}
                  disabled={busy || !projectId || activeProfile?.id === selectedProfile?.id}
                />
                <ScalePress accessibilityLabel="删除文风版本" onPress={() => selectedProfile && removeProfile(selectedProfile)} style={styles.secondaryIconAction}>
                  <Ionicons name="trash-outline" size={21} color={colors.danger} />
                </ScalePress>
              </View>
            </View>
        </BottomSheet>

      {/* 先把卡收掉再执行动作：动作里可能开别的弹层，卡片留在上面会挡住新开的那一层。 */}
      <ConfirmDialog
        visible={Boolean(confirmRequest)}
        title={confirmRequest?.title ?? ""}
        message={confirmRequest?.message ?? ""}
        confirmLabel={confirmRequest?.confirmLabel}
        danger
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

function ProfileRow({
  profile,
  active,
  onPress,
  onActivate,
  disabled,
  sourceLabel = null,
  inset = false,
}: {
  profile: StyleProfile;
  active: boolean;
  onPress: () => void;
  onActivate: () => void;
  disabled: boolean;
  /** 作者文风的来源章节文案（「来自：第一章 残魂」）；没有来源时为 null。 */
  sourceLabel?: string | null;
  /** 列表页使用时补左右留白；弹层里的调用已有内边距，保持 false。 */
  inset?: boolean;
}) {
  return (
    <View style={[styles.profileRowWrap, inset && styles.profileRowInset]}>
      <View style={styles.profileRow}>
        <Pressable onPress={onPress} style={styles.profileMain}>
          <Ionicons name={active ? "checkmark-circle" : "document-text-outline"} size={20} color={active ? colors.primary : colors.textMuted} />
          <View style={styles.profileCopy}>
            <Text style={[styles.profileName, active && styles.profileNameActive]} numberOfLines={1}>{profile.name} V{profile.version}</Text>
            <Text style={styles.profileMeta} numberOfLines={2}>{profile.guide.slice(0, 120).replace(/\s+/g, " ")}</Text>
            {sourceLabel ? <Text style={styles.profileSource} numberOfLines={1}>{sourceLabel}</Text> : null}
          </View>
        </Pressable>
        <Pressable accessibilityLabel={active ? "当前使用的文风" : "使用这个文风"} onPress={onActivate} disabled={disabled || active} style={styles.useButton}>
          <Text style={[styles.useButtonText, active && styles.useButtonTextActive, disabled && !active && styles.useButtonTextDisabled]}>{active ? "使用中" : "使用"}</Text>
        </Pressable>
      </View>
      {/* 按钮被禁用时把原因写在行下：原先点了没反应，也不说为什么。 */}
      {disabled && !active ? (
        <Text style={styles.profileDisabledHint}>请先从书架打开一部作品</Text>
      ) : null}
    </View>
  );
}

// 顶部面板里只包一块表单时的留白。
const styleSheetPad = { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm } as const;

const styles = themedStyles((colors, shadow) => StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  errorWrap: { padding: spacing.lg, paddingBottom: 0 },
  list: { paddingBottom: spacing.xl },
  emptyList: { flexGrow: 1, paddingBottom: spacing.xl },
  headerContent: { padding: spacing.lg, paddingBottom: spacing.sm },
  intro: { flexDirection: "row", gap: spacing.md, paddingBottom: spacing.lg },
  introIcon: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.primarySoft },
  introCopy: { flex: 1, gap: spacing.xs },
  introTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
  introText: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  activeStrip: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, backgroundColor: colors.primarySoft },
  activeStripText: { flex: 1, color: colors.primary, fontSize: 13, fontWeight: "600" },
  clearActive: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.sm },
  clearActiveText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: spacing.xl, paddingBottom: spacing.sm },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  sheetSectionTitle: { marginTop: spacing.sm, color: colors.text, fontSize: 16, fontWeight: "700" },
  sectionMeta: { color: colors.textMuted, fontSize: 12 },
  sourceRow: { minHeight: 84, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  sourceRowPressed: { backgroundColor: colors.surfaceMuted },
  bookIcon: { width: 48, height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.teal },
  sourceCopy: { flex: 1, minWidth: 0, gap: 3 },
  sourceTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
  sourceMeta: { color: colors.textMuted, fontSize: 12 },
  // 行内左侧留 12dp：图标与文字的起点，与其它页的列表行一致。
  // 底部外边距放在外层：行下面还要跟一行禁用说明，两行一起参与行间距。
  profileRowWrap: { marginBottom: spacing.sm },
  profileRowInset: { marginHorizontal: spacing.lg },
  profileRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingLeft: spacing.md },
  profileMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm },
  profileCopy: { flex: 1, minWidth: 0, gap: 3 },
  profileName: { color: colors.text, fontSize: 14, fontWeight: "700" },
  // 当前生效只用绿色勾与绿色标题表示，不再铺底色与边框。
  profileNameActive: { color: colors.primary },
  profileMeta: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  profileSource: { color: colors.textMuted, fontSize: 11 },
  profileDisabledHint: { color: colors.textMuted, fontSize: 12, lineHeight: 18, paddingLeft: spacing.md, paddingTop: 2 },
  useButton: { minWidth: 54, minHeight: 44, alignItems: "center", justifyContent: "center", marginRight: spacing.xs },
  useButtonText: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  useButtonTextActive: { color: colors.textMuted },
  useButtonTextDisabled: { color: colors.textMuted },
  // 父层只有 maxHeight，ScrollView 默认不收缩会把超出部分顶出可视区且滚不动，必须允许它收缩。
  sheetScroll: { flexShrink: 1 },
  sheetContent: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  profileContent: { gap: spacing.lg, paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
  inlineActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  secondaryIconAction: { width: 46, height: 46, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.surface },
  helperText: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  progressBox: { gap: 6 },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceMuted, overflow: "hidden" },
  progressFill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  progressText: { color: colors.primary, fontSize: 13, lineHeight: 19, fontWeight: "600" },
  checkpointBox: { gap: spacing.xs, padding: spacing.md, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.sm, backgroundColor: colors.primarySoft },
  checkpointTitle: { color: colors.primary, fontSize: 13, fontWeight: "700" },
  checkpointText: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  emptyHint: { color: colors.textMuted, fontSize: 14, lineHeight: 21, paddingVertical: spacing.md },
  guideText: { color: colors.text, fontSize: 14, lineHeight: 21 },
  // 按钮行已挪出滚动区，底部留白改由它自己承担（另一处 inlineActions 不受影响）。
  profileActionsBar: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, marginTop: spacing.sm },
}));

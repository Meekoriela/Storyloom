// 本文件基于 OpenFicM（Apache-2.0）修改
// 改动说明见仓库根目录 docs/上游来源与改动清单.md
import { Ionicons } from "@expo/vector-icons";
import { createBottomTabNavigator, type BottomTabBarButtonProps } from "@react-navigation/bottom-tabs";
import { NavigationContainer, DarkTheme, DefaultTheme } from "@react-navigation/native";
import { PlatformPressable } from "@react-navigation/elements";
import { appendBreadcrumb } from "@/lib/crash-log";
import { checkAppUpdate, downloadAndInstallUpdate, getAutoCheckUpdate, setAutoCheckUpdate, type AppUpdateInfo } from "@/settings/app-update";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { AdaptiveScroll } from "@/components/ui";
import { installCrashLogger } from "@/lib/crash-log";
import type { RootStackParamList, RootTabParamList } from "@/navigation/types";
import { CharactersScreen } from "@/screens/characters-screen";
import { AssistantScreen } from "@/screens/assistant-screen";
import { ProjectsScreen } from "@/screens/projects-screen";
import { SettingsScreen } from "@/screens/settings-screen";
import { StyleLibraryScreen } from "@/screens/style-library-screen";
import { WritingScreen } from "@/screens/writing-screen";
import { NotesScreen } from "@/screens/notes-screen";
import { WorldInfoScreen } from "@/screens/world-info-screen";
import { colors, themedStyles } from "@/theme";
import { AppearanceProvider, useAppearance } from "@/theme-context";
import { getRuntimeResourceState, type RuntimeResourceState } from "@/settings/remote-resources";
import { warmUpLocalModels } from "@/search/local-models";

// 在渲染任何界面之前挂载全局错误处理，保证最早发生的异常也能被记录。
installCrashLogger();

const Tab = createBottomTabNavigator<RootTabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * 底部 tab 的按压反馈：按下去整体轻微缩小，松手弹回。
 *
 * 库默认用的是 Android 无边界水波纹（颜色固定 32% 黑），从手指处扩散出一整个
 * 灰圆压在图标上。把波纹色设为透明关掉它，改用缩放 —— 有"按下去"的实体感，
 * 且不溢出按钮范围。
 */
function TabPressButton({ style, ...props }: BottomTabBarButtonProps) {
  const scale = useRef(new Animated.Value(1)).current;
  return (
    <PlatformPressable
      {...props}
      android_ripple={{ color: "transparent" }}
      onPressIn={(event) => {
        Animated.spring(scale, { toValue: 0.94, speed: 40, useNativeDriver: true }).start();
        props.onPressIn?.(event);
      }}
      onPressOut={(event) => {
        Animated.spring(scale, { toValue: 1, friction: 4, useNativeDriver: true }).start();
        props.onPressOut?.(event);
      }}
      style={[style, { transform: [{ scale }] }]}
    />
  );
}

function MainTabs() {
  const insets = useSafeAreaInsets();

  return (
    <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textMuted,
          // 只留图标：文字标签去掉后整栏能矮一截。title 仍留着 —— 它同时是无障碍标签，
          // 屏幕阅读器靠它念出「书架 / 写作 / 助手 / 设置」。
          tabBarShowLabel: false,
          tabBarStyle: {
            backgroundColor: colors.background,
            borderTopColor: colors.border,
            // 56：去掉文字之后比原来那版（58）略矮一档。
            height: 56 + insets.bottom,
            // 上下留白 11 / 15：栏高去掉文字后要重新分配，这 12dp 起初全给了上方（14 / 12），
            // 结果图标偏下。线性图形的描边重心本就略高于几何中心，留白差正好抵掉那一点偏上，
            // 于是上少下多 —— 11 给上方，15 留给下方（下方还叠着 insets.bottom，更不会被察觉）。
            paddingBottom: Math.max(insets.bottom, 15),
            paddingTop: 11,
          },
          tabBarHideOnKeyboard: true,
          tabBarButton: (props) => <TabPressButton {...props} />,
          tabBarIcon: ({ color, size }) => {
            const icons: Record<keyof RootTabParamList, keyof typeof Ionicons.glyphMap> = {
              Projects: "library-outline",
              Writing: "create-outline",
              Assistant: "sparkles-outline",
              Settings: "settings-outline",
            };
            return <Ionicons name={icons[route.name]} color={color} size={size} />;
          },
        })}
      >
        <Tab.Screen name="Projects" component={ProjectsScreen} options={{ title: "书架" }} />
        <Tab.Screen name="Writing" component={WritingScreen} options={{ title: "写作" }} />
        <Tab.Screen name="Assistant" component={AssistantScreen} options={{ title: "助手" }} />
        <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: "设置" }} />
    </Tab.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppearanceProvider>
        <KeyboardProvider preserveEdgeToEdge>
          <RuntimeResourceGate />
        </KeyboardProvider>
      </AppearanceProvider>
    </SafeAreaProvider>
  );
}

function RuntimeResourceGate() {
  const [state, setState] = useState<RuntimeResourceState | null>(null);
  const [checking, setChecking] = useState(true);
  const [skipped, setSkipped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 导航容器自己的底色与卡片色要跟着档位走：它默认是白底，深色档下转场与手势返回会闪一下白。
  const { scheme } = useAppearance();
  const navTheme = useMemo(
    () =>
      scheme === "dark"
        ? {
            ...DarkTheme,
            colors: {
              ...DarkTheme.colors,
              background: colors.background,
              card: colors.surface,
              text: colors.text,
              border: colors.border,
              primary: colors.primary,
            },
          }
        : {
            ...DefaultTheme,
            colors: {
              ...DefaultTheme.colors,
              background: colors.background,
              card: colors.surface,
              text: colors.text,
              border: colors.border,
              primary: colors.primary,
            },
          },
    [scheme],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await getRuntimeResourceState();
        if (!cancelled) setState(next);
      } catch (checkError) {
        if (!cancelled) setError(checkError instanceof Error ? checkError.message : String(checkError));
      } finally {
        if (!cancelled) setChecking(false);
      }
      // 本地检索模型改为后台静默预热：即便失败也不影响进入应用。
      void warmUpLocalModels().catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (checking) {
    return (
      <View style={styles.resourceLoading}>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.resourceProgress}>正在准备…</Text>
      </View>
    );
  }

  // 只有「必需」内容缺失才拦人 —— 而且必须留一条退路，绝不把用户锁死在启动页。
  // 可选资源（检索模型、进阶内容包）缺失一律不阻塞，进应用后在设置里按需补齐。
  if (state && !state.ready && !skipped) {
    return (
      <View style={styles.resourceGate}>
        <StatusBar style={scheme === "dark" ? "light" : "dark"} />
        <Text style={styles.resourceTitle}>缺少必需内容</Text>
        <Text style={styles.resourceSubtitle}>以下内容为助手运行所需。缺失部分仅影响对应功能，可先进入应用，稍后在设置中处理。</Text>
        <View style={styles.resourceList}>
          {state.missing.map((item) => (
            <View key={item.id} style={styles.resourceRow}>
              <View style={styles.resourceDot} />
              <View style={styles.resourceCopy}>
                <Text style={styles.resourceLabel}>{item.label}</Text>
                <Text style={styles.resourceDetail}>{item.detail}</Text>
              </View>
            </View>
          ))}
        </View>
        {error ? <Text style={styles.resourceProgress}>{error}</Text> : null}
        <Pressable accessibilityRole="button" onPress={() => setSkipped(true)} style={styles.downloadButton}>
          <Text style={styles.downloadButtonText}>跳过并进入应用</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <>
    <NavigationContainer
      theme={navTheme}
      onStateChange={(state) => {
        try {
          // 递归下钻嵌套导航状态，取当前最深层路由名（Stack → Tab → 页面）
          type NavNode = { index?: number; routes?: NavNode[]; name?: string; state?: NavNode };
          let node = state as unknown as NavNode | undefined;
          while (node?.routes?.length) {
            const next = node.routes[node.index ?? 0];
            if (!next) break;
            if (next.state) { node = next.state; continue; }
            appendBreadcrumb(`进入「${next.name ?? "未知"}」`);
            return;
          }
        } catch {}
      }}
    >
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Main" component={MainTabs} />
        <Stack.Screen name="Characters" component={CharactersScreen} />
        <Stack.Screen name="WorldInfo" component={WorldInfoScreen} />
        <Stack.Screen name="Notes" component={NotesScreen} />
        <Stack.Screen name="StyleLibrary" component={StyleLibraryScreen} />
      </Stack.Navigator>
    </NavigationContainer>
    <AppUpdatePopup />
    </>
  );
}

const styles = themedStyles((colors) => StyleSheet.create({
  updateBackdrop: { flex: 1, backgroundColor: colors.overlay, alignItems: "center", justifyContent: "center", padding: 28 },
  updateCard: { alignSelf: "stretch", backgroundColor: colors.surface, borderRadius: 16, padding: 18 },
  updateTitle: { fontSize: 17, fontWeight: "700", color: colors.text },
  updateHint: { marginTop: 8, fontSize: 13, color: colors.textMuted, lineHeight: 19 },
  updateNotesScroll: { maxHeight: 260, marginTop: 10 },
  updateNoteSection: { marginTop: 8, marginBottom: 2, fontSize: 13, fontWeight: "700", color: colors.text },
  updateNoteRow: { flexDirection: "row", gap: 6, marginTop: 4 },
  updateNoteBullet: { color: colors.primary, fontSize: 13, lineHeight: 20 },
  updateNoteText: { flex: 1, fontSize: 13, lineHeight: 20, color: colors.textFaint },
  // 更新弹窗的四个动作竖排、贴右下角（对照参考图）：关闭自动更新 / 稍后 / 查看详情 / 立即更新。
  // 「立即更新」是唯一的主操作，其余三项都是文字动作，不做成色块 —— 竖排时色块会喧宾夺主。
  updateActions: { alignItems: "flex-end", marginTop: 14 },
  updateAction: { paddingVertical: 7 },
  updateActionText: { fontSize: 14, fontWeight: "600", color: colors.text },
  updateNowBusy: { opacity: 0.6 },
  updateNowText: { fontSize: 14, fontWeight: "700", color: colors.accent },
  resourceGate: { flex: 1, justifyContent: "center", padding: 28, backgroundColor: colors.background },
  resourceLoading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, backgroundColor: colors.background },
  resourceTitle: { color: colors.text, fontSize: 28, fontWeight: "800" },
  resourceSubtitle: { marginTop: 10, color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  resourceList: { marginTop: 28, gap: 14 },
  resourceRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  resourceDot: { width: 9, height: 9, marginTop: 6, borderRadius: 5, backgroundColor: colors.primary },
  resourceCopy: { flex: 1, gap: 2 },
  resourceLabel: { color: colors.text, fontSize: 15, fontWeight: "700" },
  resourceDetail: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  resourceProgress: { marginTop: 24, color: colors.textMuted, fontSize: 13, lineHeight: 20 },
  downloadButton: { minHeight: 50, alignItems: "center", justifyContent: "center", marginTop: 20, borderRadius: 8, backgroundColor: colors.primary },
  downloadButtonDisabled: { opacity: 0.55 },
  downloadButtonText: { color: colors.onPrimary, fontSize: 15, fontWeight: "700" },
  retryResourceButton: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: 8 },
  retryResourceText: { color: colors.primary, fontSize: 14, fontWeight: "700" },
}));

/** 把 Release 说明（Markdown）拆成弹窗里的行：标题行与条目行。 */
const parseUpdateNotes = (notes: string): Array<{ kind: "section" | "item"; text: string }> =>
  (notes || "")
    .split("\n")
    .map((raw) => raw.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      if (/^#{1,6}\s/.test(line)) return { kind: "section" as const, text: line.replace(/^#{1,6}\s*/, "") };
      const item = line.replace(/^[-*]\s*/, "").replace(/\*\*/g, "");
      return item.length ? { kind: "item" as const, text: item } : null;
    })
    .filter((entry): entry is { kind: "section" | "item"; text: string } => entry !== null);


/** 启动自动检查更新的提示弹窗：10 秒自动关闭，可直接下载并安装。 */
function AppUpdatePopup() {
  const [info, setInfo] = useState<AppUpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [countdown, setCountdown] = useState(10);

  useEffect(() => {
    void (async () => {
      try {
        if (!(await getAutoCheckUpdate())) return;
        const result = await checkAppUpdate();
        if (result?.hasUpdate) { setInfo(result); setCountdown(10); }
      } catch {}
    })();
  }, []);

  useEffect(() => {
    if (!info || busy) return;
    const timer = setInterval(() => setCountdown((value) => value - 1), 1000);
    return () => clearInterval(timer);
  }, [info, busy]);

  useEffect(() => {
    if (info && !busy && countdown <= 0) setInfo(null);
  }, [info, busy, countdown]);

  if (!info) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => { if (!busy) setInfo(null); }}>
      <View style={styles.updateBackdrop}>
        <View style={styles.updateCard}>
          <Text style={styles.updateTitle}>发现新版本 {info.latestVersion}</Text>
          {busy ? <Text style={styles.updateHint}>{progress || "正在下载…"}</Text> : null}
          <AdaptiveScroll maxHeight={260} style={styles.updateNotesScroll}>
            {parseUpdateNotes(info.notes).map((line, index) =>
              line.kind === "section" ? (
                <Text key={index} style={styles.updateNoteSection}>{line.text}</Text>
              ) : (
                <View key={index} style={styles.updateNoteRow}>
                  <Text style={styles.updateNoteBullet}>·</Text>
                  <Text style={styles.updateNoteText}>{line.text}</Text>
                </View>
              ),
            )}
          </AdaptiveScroll>
          <View style={styles.updateActions}>
            <Pressable
              disabled={busy}
              onPress={() => {
                void setAutoCheckUpdate(false);
                setInfo(null);
              }}
              style={styles.updateAction}
            >
              <Text style={styles.updateActionText}>关闭自动更新</Text>
            </Pressable>
            <Pressable disabled={busy} onPress={() => setInfo(null)} style={styles.updateAction}>
              <Text style={styles.updateActionText}>稍后</Text>
            </Pressable>
            <Pressable disabled={busy} onPress={() => void Linking.openURL(info.releaseUrl)} style={styles.updateAction}>
              <Text style={styles.updateActionText}>查看详情</Text>
            </Pressable>
            <Pressable
              disabled={busy || !info.apkUrl}
              onPress={() => {
                void (async () => {
                  if (!info.apkUrl) return;
                  setBusy(true);
                  try {
                    await downloadAndInstallUpdate(info.apkUrl, setProgress);
                    setInfo(null);
                  } catch (updateError) {
                    setProgress(updateError instanceof Error ? updateError.message : String(updateError));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
              style={[styles.updateAction, busy && styles.updateNowBusy]}
            >
              <Text style={styles.updateNowText}>{busy ? "更新中…" : "立即更新"}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

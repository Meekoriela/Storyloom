// 本文件基于 OpenFicM（Apache-2.0）修改
// 改动说明见仓库根目录 docs/上游来源与改动清单.md
import * as ImagePicker from "expo-image-picker";
import { Directory, File, Paths } from "expo-file-system";
import type { BottomTabNavigationProp } from "@react-navigation/bottom-tabs";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Dimensions, FlatList, Image, ImageBackground, Modal, Pressable, StyleSheet, TextInput, Text, View } from "react-native";
import { appendBreadcrumb } from "@/lib/crash-log";
import { importProjectFromFile } from "@/lib/doc-import";
import { downsampleToFile } from "@/lib/media-downsample";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { BottomSheet, Button, ConfirmDialog, EmptyState, ErrorNotice, Field, Header, PlainScrollView, ScalePress, Screen, TopSheet } from "@/components/ui";
import { createCategory, createProject, deleteCategory, deleteProject, getProjectStats, getProjectStatsMap, getSetting, listCategories, listProjects, renameCategory, setProjectCategory, setSetting, updateProjectCover, updateProjectInfo, type ProjectStats } from "@/data/repositories";
import type { RootStackParamList, RootTabParamList } from "@/navigation/types";
import { PROJECT_FORMS, projectFormAgentId, projectFormLabel } from "@/settings/storyloom-presets";
import { useAppStore } from "@/store/app-store";
import { colors, radius, shadow, spacing, themedStyles } from "@/theme";
import { useAppearance } from "@/theme-context";
import type { Category, Project, ProjectForm } from "@/types";

/** 书架样式：网格（书封朝上）／列表（书封朝左）／书脊（只看书脊，竖排书名）。 */
type ShelfViewMode = "grid" | "list" | "spine";

const SHELF_VIEW_LABELS: Record<ShelfViewMode, string> = {
  grid: "网格",
  list: "列表",
  spine: "书脊",
};

const SHELF_VIEW_ICONS: Record<ShelfViewMode, keyof typeof Ionicons.glyphMap> = {
  grid: "list-outline",
  list: "bookmark-outline",
  spine: "library-outline",
};

/**
 * 要人拿主意的动作（删除分类、删除作品这类）走居中确认卡。
 * 与写作页、助手页用的是同一个 `ConfirmDialog`，所以全项目观感一致。
 */
type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  danger?: boolean;
};

// 书脊视图的基准尺寸：宽度按字数缩放（spineThickness），高度同理（spineHeight）。
const SPINE_BASE_WIDTH = 48;
const SPINE_BASE_HEIGHT = 180;
/** 书脊单本的宽度上限按此本数均分：一行实际站几本由书的宽度决定，不写死。 */
const SPINE_MAX_PER_ROW = 5;
/** 书与书之间的基准间距（歪出去的书会把那一侧占掉一部分）。 */
const SPINE_GAP = 4;

/**
 * 书底距贴图底边的比例（该图 3322×383；板上棱高光线在 y=246，恰好距底边 0.36）。
 *
 * 贴图整高铺在行底部，书底抬到这条比例上：越往上，书越往书架深处坐、背后露出的背墙
 * 越多；越往下，书越靠板的前沿。0.52 让书底落在棱线上方一点，板的前立面与一小段背墙
 * 都露在书的下方。
 */
const PLANK_FOOT_RATIO = 0.52;

const PLANK_IMAGE = require("../../assets/images/shelf-plank.png");

export function ProjectsScreen() {
  // 订阅外观档位：样式表由 themedStyles 的 Proxy 在**读样式键时**才重建，而 StyleSheet.create
  // 的结果会随元素 props 一起固化 —— 屏组件不重渲染，它产出的元素就还带着上一档的 style 引用。
  // 外壳 Screen 订阅只能让外壳换色，屏内元素仍旧停在旧档（背景变了、正文没变）。
  useAppearance();
  const navigation = useNavigation<BottomTabNavigationProp<RootTabParamList>>();
  const rootNavigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState<Record<string, ProjectStats>>({});
  // 书架视图：网格（封面墙）/ 列表（信息行），选择存进设置，重启保留
  const [viewMode, setViewMode] = useState<ShelfViewMode>("grid");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  /** 操作面板对应的作品；null 表示面板未打开 */
  const [menuProject, setMenuProject] = useState<Project | null>(null);
  const [shelfMenuVisible, setShelfMenuVisible] = useState(false);
  const [importing, setImporting] = useState(false);
  /** 书架一行的可用宽度（onLayout 实测；初值用屏宽兜底）。 */
  const [shelfInnerWidth, setShelfInnerWidth] = useState(() => Dimensions.get("window").width);
  /** 分类与排序 */
  const [categories, setCategories] = useState<Category[]>([]);
  const [shelfSort, setShelfSort] = useState<"recent" | "created" | "words">("recent");
  /** 当前显示的分组；null = 全部。存设置时用 "all" 表示全部 */
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [categoryPanelVisible, setCategoryPanelVisible] = useState(false);
  const [shelfMenuView, setShelfMenuView] = useState<"main" | "sort">("main");
  const [categoryManagerVisible, setCategoryManagerVisible] = useState(false);
  const [assignTarget, setAssignTarget] = useState<Project | null>(null);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [renamingCategory, setRenamingCategory] = useState<{ id: string; name: string } | null>(null);
  /** 「编辑信息」面板 */
  const [infoProject, setInfoProject] = useState<Project | null>(null);
  const [infoTitle, setInfoTitle] = useState("");
  const [infoDescription, setInfoDescription] = useState("");
  const [infoStats, setInfoStats] = useState<ProjectStats | null>(null);
  const [infoSaving, setInfoSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  /** 新建作品时选定的写作形式；未选时「创建」不可用。 */
  const [createForm, setCreateForm] = useState<ProjectForm | null>(null);
  const [formPickerVisible, setFormPickerVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const setCurrentProject = useAppStore((state) => state.setCurrentProject);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProjects(await listProjects());
      setStats(await getProjectStatsMap());
      setCategories(await listCategories());
      void getSetting("general.shelfView")
        .then((value) => setViewMode(value === "list" ? "list" : value === "spine" ? "spine" : "grid"))
        .catch(() => {});
      void getSetting("general.shelfSort")
        .then((value) => setShelfSort(value === "created" || value === "words" ? value : "recent"))
        .catch(() => {});
      void getSetting("general.shelfCategory")
        .then((value) => setSelectedCategoryId(value && value !== "all" ? value : null))
        .catch(() => {});
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void loadProjects();
  }, [loadProjects]));

  /** 网格 / 列表切换：选择写进设置，重启保留。 */
  const toggleViewMode = () => {
    const next: ShelfViewMode = viewMode === "grid" ? "list" : viewMode === "list" ? "spine" : "grid";
    setViewMode(next);
    void setSetting("general.shelfView", next);
  };

  const openProject = (project: Project) => {
    appendBreadcrumb(`书架点开作品「${project.title}」`);
    setCurrentProject(project.id);
    navigation.navigate("Writing");
  };

  /** 排序：改设置即生效；分类开关同理。 */
  const applyShelfSort = (rule: "recent" | "created" | "words") => {
    setShelfSort(rule);
    setShelfMenuView("main");
    void setSetting("general.shelfSort", rule);
  };
  /** 选择书架当前显示的分组（持久化；分类被删时回落「全部」）。 */
  const selectShelfCategory = (categoryId: string | null) => {
    setSelectedCategoryId(categoryId);
    setCategoryPanelVisible(false);
    void setSetting("general.shelfCategory", categoryId ?? "all");
  };
  const closeCategoryManager = () => { setCategoryManagerVisible(false); setRenamingCategory(null); };
  const addCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) return;
    await createCategory(name);
    setNewCategoryName("");
    setCategories(await listCategories());
  };
  const saveCategoryRename = async () => {
    if (!renamingCategory || !renamingCategory.name.trim()) return;
    await renameCategory(renamingCategory.id, renamingCategory.name.trim());
    setRenamingCategory(null);
    setCategories(await listCategories());
  };
  const removeCategory = (category: Category) => {
    setConfirmRequest({
      title: "删除分类",
      message: `删除「${category.name}」？名下作品将回到未分类。`,
      confirmLabel: "删除",
      danger: true,
      onConfirm: () => {
        void (async () => {
          await deleteCategory(category.id);
          setCategories(await listCategories());
          await loadProjects();
        })();
      },
    });
  };
  const assignToCategory = async (categoryId: string | null) => {
    if (!assignTarget) return;
    await setProjectCategory(assignTarget.id, categoryId);
    setCategoryManagerVisible(false);
    setAssignTarget(null);
    await loadProjects();
  };

  /** 排序后的作品列表。 */
  const sortedProjects = useMemo(() => {
    const list = [...projects];
    if (shelfSort === "created") list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    else if (shelfSort === "words") list.sort((a, b) => (stats[b.id]?.characters ?? 0) - (stats[a.id]?.characters ?? 0));
    else list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return list;
  }, [projects, shelfSort, stats]);

  /** 渲染条目：只显示当前选中的分组；「全部」平铺。 */
  const currentCategoryName = selectedCategoryId
    ? categories.find((category) => category.id === selectedCategoryId)?.name ?? "全部"
    : "全部";
  const hasUncategorized = projects.some((project) => !project.categoryId || !categories.some((category) => category.id === project.categoryId));
  const shelfItems = useMemo(() => {
    const visible = !selectedCategoryId
      ? sortedProjects
      : sortedProjects.filter((project) => selectedCategoryId === "uncategorized"
        ? !project.categoryId || !categories.some((category) => category.id === project.categoryId)
        : project.categoryId === selectedCategoryId);
    const items: Array<{ kind: "row"; row: Project[] } | { kind: "project"; project: Project }> = [];
    // 网格每行 4 本（等宽铺满）；书脊按实际宽度装箱，一行塞到放不下才换行。两者都是"一行一条层板"。
    if (viewMode === "list") {
      for (const project of visible) items.push({ kind: "project", project });
      return items;
    }
    const rows = viewMode === "grid"
      ? chunkProjects(visible, 4)
      : packSpineRows(visible, shelfInnerWidth, (project) => stats[project.id]?.characters ?? 0);
    for (const row of rows) items.push({ kind: "row", row });
    return items;
  }, [projects, sortedProjects, categories, selectedCategoryId, viewMode, shelfInnerWidth, stats]);

  const submit = async () => {
    if (!title.trim() || !createForm) return;
    setSaving(true);
    setError(null);
    try {
      const project = await createProject(title, description, createForm);
      // 形式决定这部作品用哪个智能体：写作品级键，别的作品不受影响；
      // 没写过键的作品（老作品、助手自建的「未命名」）仍落回设置里的全局默认。
      const agentId = projectFormAgentId(createForm);
      if (agentId) await setSetting(`assistant.activeAgent.${project.id}`, agentId);
      setTitle("");
      setDescription("");
      setCreateForm(null);
      setShowCreate(false);
      setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
      openProject(project);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSaving(false);
    }
  };

  /** 打开「编辑信息」面板，顺带载入作品规模统计。 */
  const openProjectInfo = (project: Project) => {
    setMenuProject(null);
    setInfoProject(project);
    setInfoTitle(project.title);
    setInfoDescription(project.description);
    setInfoStats(null);
    void getProjectStats(project.id).then(setInfoStats).catch(() => setInfoStats(null));
  };

  const saveProjectInfo = async () => {
    if (!infoProject || !infoTitle.trim()) return;
    setInfoSaving(true);
    try {
      await updateProjectInfo(infoProject.id, infoTitle, infoDescription);
      setProjects((current) => current.map((item) => (
        item.id === infoProject.id
          ? { ...item, title: infoTitle.trim(), description: infoDescription.trim() }
          : item
      )));
      setInfoProject(null);
    } catch (infoError) {
      setError(infoError instanceof Error ? infoError.message : String(infoError));
    } finally {
      setInfoSaving(false);
    }
  };

  /** 打开作品操作面板（封面与删除统一收在这里，避免误触直接删）。 */
  const runShelfImport = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const project = await importProjectFromFile();
      setShelfMenuVisible(false);
      if (!project) return;
      await loadProjects();
      openProject(project);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    } finally {
      setImporting(false);
    }
  };

  const openProjectMenu = (project: Project) => setMenuProject(project);

/** 网格：把作品按每行 4 本分块，行下面渲染整条书架板。 */
function chunkProjects(list: Project[], size: number): Project[][] {
  const rows: Project[][] = [];
  for (let index = 0; index < list.length; index += size) rows.push(list.slice(index, index + size));
  return rows;
}

/** 书脊单本的宽度上限：按行宽均分若干份，再厚的书也占不满整行。 */
function spineMaxWidthFor(shelfInnerWidth: number): number {
  return Math.max(
    SPINE_BASE_WIDTH,
    Math.floor((shelfInnerWidth - SPINE_GAP * (SPINE_MAX_PER_ROW - 1)) / SPINE_MAX_PER_ROW),
  );
}

/** 书脊单本的实际宽度：字数定厚薄，再压到上限以内。装箱与渲染共用，两处宽度必须一致。 */
function spineBookWidth(characters: number, title: string, maxWidth: number): number {
  return Math.min(maxWidth, Math.round(SPINE_BASE_WIDTH * spineThickness(characters, title)));
}

/**
 * 一排书脊里第 index 本的落位：宽、高、倾角、左侧间距。
 *
 * 书脊和它正下方的标签各渲染一遍，两处要用同一份结果 —— 一排书宽窄不一，标签若按行内
 * 均分就会跟书错开。间距里要扣掉相邻两本歪出去占掉的那部分：书顶偏过来多少，缝就窄多少。
 */
function spineLayoutAt(
  row: Project[],
  index: number,
  charactersOf: (project: Project) => number,
  maxWidth: number,
): { width: number; height: number; lean: number; marginLeft: number } {
  const project = row[index];
  const characters = charactersOf(project);
  const lean = spineLean(project.title);
  const height = Math.round(SPINE_BASE_HEIGHT * spineHeight(characters, project.title));
  const previous = index > 0 ? row[index - 1] : null;
  const previousLean = previous ? spineLean(previous.title) : 0;
  const previousShift = previous
    ? spineLeanShift(previousLean, Math.round(SPINE_BASE_HEIGHT * spineHeight(charactersOf(previous), previous.title)))
    : 0;
  const used = (previousLean > 0 ? previousShift : 0) + (lean < 0 ? spineLeanShift(lean, height) : 0);
  return {
    width: spineBookWidth(characters, project.title, maxWidth),
    height,
    lean,
    marginLeft: index === 0 ? 0 : Math.max(1, Math.round(SPINE_GAP - used)),
  };
}

/**
 * 书脊一行站几本，由书的实际宽度决定，不写死本数。
 *
 * 每本宽度按字数算（与渲染同一套），从行左往右塞、塞不下就换行：书薄的一行能站十本，
 * 书厚的一行只站得下六七本。行宽要减掉 `spineShelfRow` 的左右各 6；间距一律按
 * `SPINE_GAP` 的上界计入（渲染时歪书的间距只会更小），这样装箱结果不会超出行宽。
 */
function packSpineRows(
  list: Project[],
  shelfInnerWidth: number,
  charactersOf: (project: Project) => number,
): Project[][] {
  const rowWidth = Math.max(0, shelfInnerWidth - 12);
  const maxWidth = spineMaxWidthFor(shelfInnerWidth);
  const rows: Project[][] = [];
  let current: Project[] = [];
  let used = 0;
  for (const project of list) {
    const width = spineBookWidth(charactersOf(project), project.title, maxWidth);
    const step = current.length ? SPINE_GAP + width : width;
    if (current.length && used + step > rowWidth) {
      rows.push(current);
      current = [project];
      used = width;
    } else {
      current.push(project);
      used += step;
    }
  }
  if (current.length) rows.push(current);
  return rows;
}

/** 无封面书封的书名排版：按长度拆成两行。 */
function bookTitleLines(title: string): string[] {
  const clean = title.trim();
  if (clean.length <= 4) return [clean];
  const half = Math.ceil(clean.length / 2);
  return [clean.slice(0, half), clean.slice(half)];
}

/**
 * 由书名决定的固定扰动（0~1）。
 *
 * 只按字数映射时，"零字"的书会全部落到下限、一整排长得一模一样。再按书名取一个
 * 固定值叠上去，宽窄与高矮才错得开；同一本书每次进来一致，不会刷新一次变个样。
 * 哈希取满 32 位再归一 —— 只取低位时短书名之间会挤在同一小段里，扰动等于没有。
 */
function spineJitter(title: string, salt: number): number {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) hash = (hash * 31 + title.charCodeAt(index) + salt) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 2246822507) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909) >>> 0;
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

/**
 * 书脊的尺寸映射。
 *
 * 真实书柜里每本书厚薄高矮都不同，一排书等高等宽就成了复制粘贴。所以按
 * **字数取对数**再归一：十万字的书脊明显厚于一万字，差距随字数放缓，不会出现
 * 一本撑破整排。取对数而不是线性，是因为字数跨两个数量级时线性映射会让
 * 小书完全看不见。零字的书再叠一层书名扰动，一排才参差。
 */
function spineThickness(characters: number, title: string): number {
  const ratio = Math.min(1, Math.log2(characters / 8000 + 1) / 4);
  return (0.72 + ratio * 0.28) * (0.7 + spineJitter(title, 7) * 0.6);
}

function spineHeight(characters: number, title: string): number {
  const ratio = Math.min(1, Math.log2(characters / 8000 + 1) / 4);
  return (0.74 + ratio * 0.26) * (0.86 + spineJitter(title, 23) * 0.28);
}

/**
 * 竖排书名要显示的字符。
 *
 * 原生没有 `writing-mode: vertical-rl`，所以书名按字拆开、一字一行地渲染。
 * 超过能放下的字数就截断 —— 窄书脊放不下十四个字，再多也是看不清。
 */
function spineTitleChars(title: string): string[] {
  const clean = title.trim();
  return (clean.length > 8 ? clean.slice(0, 8) : clean).split("");
}

/**
 * 由书名决定这本书歪不歪。
 *
 * 真实书架上整排书是笔直的，偶尔一本没靠稳才微微外倾；整排都歪看着像被推过。
 * 所以先摇一个 0~1 的值，约五分之一的书中签（向右 1.5~2.5° 或向左 1~2°），
 * 其余保持笔直。同一本书每次进来一致，不会刷新一次变一次。
 */
function spineLean(title: string): number {
  const roll = spineJitter(title, 53);
  if (roll < 0.14) return 1.5 + spineJitter(title, 61);
  if (roll < 0.22) return -(1 + spineJitter(title, 67));
  return 0;
}

/** 倾角换算成书顶的横向偏移：绕书底旋转时，偏移量 = 书高 × sin(角度)。 */
function spineLeanShift(lean: number, height: number): number {
  return Math.abs(Math.sin((lean * Math.PI) / 180)) * height;
}

/**
 * 书架封面卡：无封面时按书名哈希取低饱和底色 + 首字水印，同一批作品颜色分散开。
 *
 * 色板随档位切换：深色档那一套是同样五个色相整体压暗的版本 —— 原来的亮度放在深底上会发灰，
 * 看着像褪色而不是低饱和。
 */
function coverColor(title: string): string {
  let hash = 0;
  for (let index = 0; index < title.length; index += 1) hash = (hash * 31 + title.charCodeAt(index)) >>> 0;
  const palette = colors.coverPalette;
  return palette[hash % palette.length];
}

  /**
   * 从相册选图作为作品封面。
   *
   * 每次用**唯一文件名**：旧实现固定写成 `<作品id>.<扩展名>`，第二次换封面时文件内容确实换了、
   * 但路径（URI）没变，图片组件按 URI 缓存 → 界面上「没反应」。路径一变，缓存自然失效。
   */
  const pickProjectCover = async (project: Project) => {
    setMenuProject(null);
    let picked: ImagePicker.ImagePickerAsset | null = null;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [3, 4],
        quality: 0.9,
      });
      if (result.canceled || !result.assets[0]) return;
      picked = result.assets[0];
    } catch (pickError) {
      setError(pickError instanceof Error ? pickError.message : String(pickError));
      return;
    }

    const directory = new Directory(Paths.document, "project-covers");
    let target: File;
    try {
      directory.create({ intermediates: true, idempotent: true });
      const extension = (picked.fileName?.split(".").pop() ?? "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      target = new File(directory, `${project.id}-${Date.now()}.${extension}`);
      await new File(picked.uri).copy(target);
      // 降采样只是省内存：压成功了就换用压小的那份，失败继续用原图，两种都不作提示。
      const resizedUri = await downsampleToFile(target.uri, 1080);
      if (resizedUri) {
        try {
          if (target.exists) target.delete();
        } catch {
          // 原图没删掉只是多占一点空间，不影响显示。
        }
        target = new File(resizedUri);
      }
      void appendBreadcrumb(`封面已保存（降采样）`);
    } catch (copyError) {
      setError(`图片已选中，但写入本地目录失败：${copyError instanceof Error ? copyError.message : String(copyError)}`);
      return;
    }

    try {
      await updateProjectCover(project.id, target.uri);
    } catch (dbError) {
      setError(`图片已复制，但写入作品记录失败：${dbError instanceof Error ? dbError.message : String(dbError)}`);
      return;
    }

    // 记录写成功后再清理旧封面；清理失败不影响本次结果。
    if (project.coverPath) {
      try {
        const previous = new File(project.coverPath);
        if (previous.exists) previous.delete();
      } catch {
        // 旧文件可能正被系统占用，下次覆盖时再清理
      }
    }
    setProjects((current) => current.map((item) => (item.id === project.id ? { ...item, coverPath: target.uri } : item)));
  };

  /** 移除封面：清空记录并删掉本地图片文件。 */
  const removeProjectCover = async (project: Project) => {
    setMenuProject(null);
    try {
      if (project.coverPath) {
        const file = new File(project.coverPath);
        if (file.exists) file.delete();
      }
      await updateProjectCover(project.id, null);
      setProjects((current) => current.map((item) => (item.id === project.id ? { ...item, coverPath: null } : item)));
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    }
  };

  const confirmDelete = (project: Project) => {
    setConfirmRequest({
      title: "删除作品",
      message: `确定删除《${project.title}》及全部本地数据？`,
      confirmLabel: "删除",
      danger: true,
      onConfirm: () => {
        void deleteProject(project.id)
          .then(() => {
            setProjects((current) => current.filter((item) => item.id !== project.id));
            if (currentProjectId === project.id) setCurrentProject(null);
          })
          .catch((deleteError) => setError(deleteError instanceof Error ? deleteError.message : String(deleteError)));
      },
    });
  };

  return (
    <Screen>
      <Header
        title={
          categories.length ? (
            <ScalePress accessibilityLabel="选择分组" onPress={() => setCategoryPanelVisible((value) => !value)} style={styles.shelfTitleButton}>
              <Text style={styles.shelfTitleText}>{currentCategoryName}</Text>
              <Ionicons name={categoryPanelVisible ? "chevron-up" : "chevron-down"} size={16} color={colors.text} />
            </ScalePress>
          ) : (
            "全部"
          )
        }
        action={
          <View style={styles.headerActions}>
            <ScalePress accessibilityLabel="新建作品" onPress={() => setShowCreate(true)} style={styles.iconButton}>
              <Ionicons name="add" size={26} color={colors.primary} />
            </ScalePress>
            <ScalePress accessibilityLabel="书架菜单" onPress={() => setShelfMenuVisible(true)} style={styles.iconButton}>
              <Ionicons name="ellipsis-horizontal" size={22} color={colors.primary} />
            </ScalePress>
          </View>
        }
      />
      {categoryPanelVisible ? (
        <>
          <Pressable accessibilityLabel="关闭分组面板" onPress={() => setCategoryPanelVisible(false)} style={styles.shelfMenuBackdrop} />
          <View style={styles.categoryPanel}>
            <ScalePress onPress={() => selectShelfCategory(null)} style={[styles.shelfChip, !selectedCategoryId && styles.shelfChipActive]}>
              <Text style={[styles.shelfChipText, !selectedCategoryId && styles.shelfChipTextActive]}>全部</Text>
            </ScalePress>
            {categories.map((category) => (
              <ScalePress key={category.id} onPress={() => selectShelfCategory(category.id)} style={[styles.shelfChip, selectedCategoryId === category.id && styles.shelfChipActive]}>
                <Text style={[styles.shelfChipText, selectedCategoryId === category.id && styles.shelfChipTextActive]}>{category.name}</Text>
              </ScalePress>
            ))}
            {hasUncategorized ? (
              <ScalePress onPress={() => selectShelfCategory("uncategorized")} style={[styles.shelfChip, selectedCategoryId === "uncategorized" && styles.shelfChipActive]}>
                <Text style={[styles.shelfChipText, selectedCategoryId === "uncategorized" && styles.shelfChipTextActive]}>未分类</Text>
              </ScalePress>
            ) : null}
          </View>
        </>
      ) : null}
      {shelfMenuVisible && shelfMenuView === "main" ? (
        <>
          <Pressable accessibilityLabel="关闭书架菜单" onPress={() => setShelfMenuVisible(false)} style={styles.shelfMenuBackdrop} />
          <View style={styles.shelfMenuCard}>
            <Pressable
              accessibilityLabel="本机导入"
              disabled={importing}
              onPress={() => void runShelfImport()}
              style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
            >
              {importing
                ? <ActivityIndicator size={20} color={colors.primary} />
                : <Ionicons name="document-outline" size={20} color={colors.primary} />}
              <Text style={styles.menuRowText}>本机导入</Text>
            </Pressable>
            <Pressable
              accessibilityLabel={`书架样式：当前为${SHELF_VIEW_LABELS[viewMode]}，点击切换`}
              onPress={() => { toggleViewMode(); setShelfMenuVisible(false); }}
              style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
            >
              <Ionicons name={SHELF_VIEW_ICONS[viewMode]} size={20} color={colors.primary} />
              <Text style={styles.menuRowText}>书架样式</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="分类管理"
              onPress={() => { setShelfMenuVisible(false); setCategoryManagerVisible(true); }}
              style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
            >
              <Ionicons name="folder-open-outline" size={20} color={colors.primary} />
              <Text style={styles.menuRowText}>分类管理</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="书架排序"
              onPress={() => setShelfMenuView("sort")}
              style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
            >
              <Ionicons name="swap-vertical-outline" size={20} color={colors.primary} />
              <Text style={styles.menuRowText}>书架排序</Text>
            </Pressable>
          </View>
        </>
      ) : null}
      {shelfMenuVisible && shelfMenuView === "sort" ? (
        <>
          <Pressable accessibilityLabel="关闭排序选择" onPress={() => { setShelfMenuView("main"); setShelfMenuVisible(false); }} style={styles.shelfMenuBackdrop} />
          <View style={styles.shelfMenuCard}>
            <Text style={styles.menuTitle}>书架排序</Text>
            {([
              { id: "recent", label: "最近更新" },
              { id: "created", label: "创建时间" },
              { id: "words", label: "字数" },
            ] as const).map((option) => (
              <Pressable
                key={option.id}
                accessibilityLabel={`排序方式：${option.label}`}
                onPress={() => applyShelfSort(option.id)}
                style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
              >
                <Text style={styles.menuRowText}>{option.label}</Text>
                {shelfSort === option.id ? <Ionicons name="checkmark" size={20} color={colors.primary} /> : null}
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      <FlatList
        key={viewMode}
        data={shelfItems}
        keyExtractor={(item, index) => (item.kind === "row" ? `row-${index}` : item.project.id)}
        contentContainerStyle={projects.length ? styles.list : styles.emptyList}
        ItemSeparatorComponent={viewMode === "list" ? () => <View style={styles.separator} /> : () => null}
        ListHeaderComponent={
          <View>
            <View style={styles.quickActions}>
              <Pressable
                disabled={!currentProjectId}
                onPress={() => rootNavigation.navigate("Characters")}
                style={[styles.quickAction, !currentProjectId && styles.quickActionDisabled]}
              >
                <Ionicons name="people-outline" size={22} color={currentProjectId ? colors.primary : colors.textMuted} />
                <Text style={styles.quickActionText}>角色</Text>
              </Pressable>
              <Pressable
                disabled={!currentProjectId}
                onPress={() => rootNavigation.navigate("WorldInfo")}
                style={[styles.quickAction, !currentProjectId && styles.quickActionDisabled]}
              >
                <Ionicons name="globe-outline" size={22} color={currentProjectId ? colors.primary : colors.textMuted} />
                <Text style={styles.quickActionText}>世界书</Text>
              </Pressable>
              <Pressable
                disabled={!currentProjectId}
                onPress={() => rootNavigation.navigate("Notes")}
                style={[styles.quickAction, !currentProjectId && styles.quickActionDisabled]}
              >
                <Ionicons name="reader-outline" size={22} color={currentProjectId ? colors.primary : colors.textMuted} />
                <Text style={styles.quickActionText}>笔记</Text>
              </Pressable>
              <Pressable
                onPress={() => rootNavigation.navigate("StyleLibrary")}
                style={styles.quickAction}
              >
                <Ionicons name="color-wand-outline" size={22} color={colors.primary} />
                <Text style={styles.quickActionText}>文风库</Text>
              </Pressable>
            </View>
            {categories.length ? (
              <PlainScrollView horizontal keyboardShouldPersistTaps="handled" style={styles.shelfChipsRow} contentContainerStyle={styles.shelfChipsContent}>
                <ScalePress onPress={() => selectShelfCategory(null)} style={({ pressed }) => [styles.shelfChip, !selectedCategoryId && styles.shelfChipActive]}>
                  <Text style={[styles.shelfChipText, !selectedCategoryId && styles.shelfChipTextActive]}>全部</Text>
                </ScalePress>
                {categories.map((category) => (
                  <ScalePress key={category.id} onPress={() => selectShelfCategory(category.id)} style={({ pressed }) => [styles.shelfChip, selectedCategoryId === category.id && styles.shelfChipActive]}>
                    <Text style={[styles.shelfChipText, selectedCategoryId === category.id && styles.shelfChipTextActive]}>{category.name}</Text>
                  </ScalePress>
                ))}
                {hasUncategorized ? (
                  <ScalePress onPress={() => selectShelfCategory("uncategorized")} style={({ pressed }) => [styles.shelfChip, selectedCategoryId === "uncategorized" && styles.shelfChipActive]}>
                    <Text style={[styles.shelfChipText, selectedCategoryId === "uncategorized" && styles.shelfChipTextActive]}>未分类</Text>
                  </ScalePress>
                ) : null}
              </PlainScrollView>
            ) : null}
            {error ? <View style={styles.errorWrap}><ErrorNotice message={error} onRetry={() => void loadProjects()} /></View> : null}
          </View>
        }
        ListEmptyComponent={loading ? <ActivityIndicator color={colors.primary} /> : <EmptyState title="还没有作品" action={<Button label="新建作品" onPress={() => setShowCreate(true)} />} />}
        renderItem={({ item }) => {
          if (viewMode === "grid") {
            const row = item.kind === "row" ? item.row : [];
            // 书架 = 一行的背景层（照书架类应用的画法）：层板贴图铺在行底部、全宽贯通，
            // 书格底坐在板上棱线；与本书数无关——1 本书板也贯通。
            // 4 格 + 3 个间隙，宽度里要扣掉行内左右各 14（shelfRow）与 6（shelfBooks）；
            // 少扣一项，最后一格就会被屏幕右缘切掉。
            const cellGap = 6;
            const cellWidth = Math.max(60, Math.floor((shelfInnerWidth - 28 - 12 - 3 * cellGap) / 4));
            const plankStrip = Math.round(shelfInnerWidth / (3322 / 383));
            const plankBelow = Math.round(plankStrip * PLANK_FOOT_RATIO);
            const rowHeight = Math.round((cellWidth * 4) / 3) + plankBelow;
            return (
              <View
                style={styles.shelfRow}
                onLayout={(event) => {
                  const width = event.nativeEvent.layout.width;
                  if (Math.abs(width - shelfInnerWidth) > 1) setShelfInnerWidth(width);
                }}
              >
                <View style={{ height: rowHeight, justifyContent: "flex-end" }}>
                {/* 层板整高铺在行底部、画在书之前：书坐在板上，板的前立面与一小段背墙留在书的下方。 */}
                <ImageBackground
                  source={PLANK_IMAGE}
                  resizeMode="stretch"
                  style={{ position: "absolute", left: -60, right: -60, bottom: 0, height: plankStrip }}
                >
                  {/* 层板的木纹亮度是烘进 PNG 像素的（浅木色，深色档下也不变暗），
                      所以在它上面叠一层档位色罩：浅色档这层近乎透明，深色档压暗木纹。
                      不换资源文件 —— 换一张就要同时接进备份，且木纹的高光会一并丢掉。 */}
                  <View style={styles.plankShade} />
                </ImageBackground>
                <View style={[styles.shelfBooks, { paddingBottom: plankBelow, gap: cellGap }]}>
                  {row.map((project) => {
                    const lines = bookTitleLines(project.title);
                    return (
                      <Pressable key={project.id} onPress={() => openProject(project)} onLongPress={() => openProjectMenu(project)} style={({ pressed }) => [styles.shelfCell, { width: cellWidth }, pressed && styles.rowPressed]}>
                        <View style={[styles.bookObject, { backgroundColor: coverColor(project.title) }]}>
                          <View style={styles.bookSpine} />
                          {project.coverPath ? (
                            <Image source={{ uri: project.coverPath }} style={styles.gridCoverImage} resizeMethod="resize" />
                          ) : (
                            <View style={styles.bookCoverTextWrap}>
                              {lines.map((line, index) => (
                                <Text key={index} style={[styles.bookCoverLine, index === 0 && lines.length > 1 && styles.bookCoverLineLead]} numberOfLines={1}>{line}</Text>
                              ))}
                            </View>
                          )}
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
                </View>
                <View style={[styles.shelfLabels, { gap: cellGap }]}>
                  {row.map((project) => {
                    const st = stats[project.id];
                    // 网格不写字数：这一格只有四分之一栏宽，字数跟在卷章后面必然被截成「0.4…」。
                    // 只留作品名与卷章数；要精确字数切到列表视图。
                    const statsLine = st ? `${st.volumes} 卷 · ${st.chapters} 章` : "…";
                    return (
                      <View key={project.id} style={[styles.shelfLabelCell, { width: cellWidth }]}>
                        <Text style={styles.gridName} numberOfLines={1}>{project.title}</Text>
                        <Text style={styles.gridStats} numberOfLines={1}>{statsLine}</Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            );
          }
          // 书脊视图：一整排立着的书脊，竖排书名，厚薄高矮按字数来。
          if (viewMode === "spine") {
            const row = item.kind === "row" ? item.row : [];
            const spinePlankHeight = Math.max(10, Math.round(shelfInnerWidth / (3322 / 383)));
            const spinePlankTop = Math.round(spinePlankHeight * PLANK_FOOT_RATIO);
            // 单本宽度上限：与装箱用同一个函数，两处宽度必须一致。
            const spineMaxWidth = spineMaxWidthFor(shelfInnerWidth);
            const spineCharacters = (item: Project) => stats[item.id]?.characters ?? 0;
            return (
              <View
                style={styles.spineShelfRow}
                onLayout={(event) => {
                  const width = event.nativeEvent.layout.width;
                  if (Math.abs(width - shelfInnerWidth) > 1) setShelfInnerWidth(width);
                }}
              >
                <View style={{ height: SPINE_BASE_HEIGHT + spinePlankTop, justifyContent: "flex-end", paddingBottom: spinePlankTop }}>
                  {/* 与网格同一套：层板整高铺在行底部、画在书之前。层板按行宽折算，写死 14 会在宽行上被拉扁。 */}
                  <ImageBackground
                    source={PLANK_IMAGE}
                    resizeMode="stretch"
                    style={{ position: "absolute", left: -60, right: -60, bottom: 0, height: spinePlankHeight }}
                  >
                    {/* 与网格同一套色罩，理由见网格那处。 */}
                    <View style={styles.plankShade} />
                  </ImageBackground>
                  <View style={styles.spineBooks}>
                    {row.map((project, index) => {
                      const { width, height, lean, marginLeft } = spineLayoutAt(row, index, spineCharacters, spineMaxWidth);
                      return (
                        <Pressable
                          key={project.id}
                          accessibilityLabel={`打开《${project.title}》`}
                          onPress={() => openProject(project)}
                          onLongPress={() => openProjectMenu(project)}
                          style={({ pressed }) => [
                            styles.spineBook,
                            {
                              marginLeft,
                              width,
                              height,
                              backgroundColor: coverColor(project.title),
                              transform: lean ? [{ rotate: `${lean}deg` }] : undefined,
                              zIndex: lean ? 1 : 0,
                            },
                            pressed && styles.rowPressed,
                          ]}
                        >
                          {/* 书脊右缘一道淡暗：光从左侧来。 */}
                          <View style={styles.spineShade} />
                          <View style={styles.spineTitleWrap}>
                            {spineTitleChars(project.title).map((char, index) => (
                              <Text key={index} style={styles.spineTitle}>{char}</Text>
                            ))}
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
                <View style={styles.spineLabels}>
                  {row.map((project, index) => {
                    // 标签跟着各自那本书的宽度和左侧间距走：一排里书宽窄不一，标签也宽窄不一才对得上。
                    const { width, marginLeft } = spineLayoutAt(row, index, spineCharacters, spineMaxWidth);
                    return (
                      <View key={project.id} style={[styles.spineLabelCell, { width, marginLeft }]}>
                        <Text style={styles.spineLabel} numberOfLines={1}>{project.title}</Text>
                        {/* 书脊不写字数：书脊的厚薄高矮本来就按字数缩放，字数再写一遍是同一件事说两遍，
                            而且窄书脊放不下「12.3 万字」这一串。 */}
                        <Text style={styles.spineStats} numberOfLines={1}>
                          {stats[project.id] ? `${stats[project.id].chapters} 章` : "…"}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            );
          }

          const project = item.kind === "project" ? item.project : (item as unknown as Project);
          const statsLine = (() => { const st = stats[project.id]; return st ? `${st.volumes} 卷 · ${st.chapters} 章 · ${(st.characters / 10000).toFixed(1)} 万字` : "…"; })();
          const progress = Math.min(100, Math.round(((stats[project.id]?.characters ?? 0) / 100000) * 100));
          const coverNode = (
            <View style={[styles.cover, { backgroundColor: coverColor(project.title) }]}>
              {project.coverPath ? (
                <Image source={{ uri: project.coverPath }} style={styles.coverImage} resizeMethod="resize" />
              ) : (
                <Text style={styles.coverText}>{project.title.slice(0, 1)}</Text>
              )}
            </View>
          );
          const menu = (
            <Pressable accessibilityLabel={`《${project.title}》的操作`} onPress={(event) => { event.stopPropagation(); openProjectMenu(project); }} hitSlop={8} style={styles.rowAction}>
              <Ionicons name="ellipsis-horizontal" size={20} color={colors.textMuted} />
            </Pressable>
          );
          return (
            <Pressable onPress={() => openProject(project)} onLongPress={() => openProjectMenu(project)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
              {coverNode}
              <View style={styles.rowText}>
                <Text style={styles.title} numberOfLines={1}>{project.title}</Text>
                <Text style={styles.description} numberOfLines={1}>{project.description || "暂无简介"}</Text>
                <View style={styles.statsRow}>
                  <View style={styles.meter}>
                    <View style={[styles.meterFill, { width: `${progress}%` }]} />
                  </View>
                  <Text style={styles.statsText}>{statsLine}</Text>
                </View>
              </View>
              {menu}
            </Pressable>
          );
        }}
      />

      <Modal visible={infoProject !== null} transparent animationType="slide" onRequestClose={() => setInfoProject(null)}>
        <KeyboardAvoidingView style={styles.menuBackdrop} behavior="height" automaticOffset>
          <View style={styles.infoSheet}>
            <Text style={styles.menuTitle}>编辑信息</Text>
            <Field label="作品名" value={infoTitle} onChangeText={setInfoTitle} autoFocus />
            <Field label="简介" value={infoDescription} onChangeText={setInfoDescription} multiline style={styles.infoDescription} />
            <Text style={styles.infoStats}>
              {infoStats
                ? `${infoStats.volumes} 卷 · ${infoStats.chapters} 章 · ${infoStats.characters.toLocaleString()} 字`
                : "正在统计作品规模…"}
            </Text>
            <View style={styles.infoActions}>
              <Button label="取消" variant="secondary" onPress={() => setInfoProject(null)} />
              <Button label={infoSaving ? "保存中" : "保存"} onPress={() => void saveProjectInfo()} disabled={!infoTitle.trim()} loading={infoSaving} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <BottomSheet
        visible={menuProject !== null}
        title={menuProject?.title ?? ""}
        subtitle="作品操作"
        onClose={() => setMenuProject(null)}
      >
          <View style={menuSheetBody}>
            <Pressable
              accessibilityLabel="编辑信息"
              onPress={() => { if (menuProject) openProjectInfo(menuProject); }}
              style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
            >
              <Ionicons name="create-outline" size={20} color={colors.primary} />
              <Text style={styles.menuRowText}>编辑信息</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="上传封面"
              onPress={() => { if (menuProject) void pickProjectCover(menuProject); }}
              style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
            >
              <Ionicons name="image-outline" size={20} color={colors.primary} />
              <Text style={styles.menuRowText}>{menuProject?.coverPath ? "更换封面" : "上传封面"}</Text>
            </Pressable>
            {menuProject?.coverPath ? (
              <Pressable
                accessibilityLabel="移除封面"
                onPress={() => { if (menuProject) void removeProjectCover(menuProject); }}
                style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
              >
                <Ionicons name="close-circle-outline" size={20} color={colors.textMuted} />
                <Text style={styles.menuRowText}>移除封面</Text>
              </Pressable>
            ) : null}
            {categories.length ? (
              <Pressable
                accessibilityLabel="归入分类"
                onPress={() => {
                  const target = menuProject;
                  setMenuProject(null);
                  if (target) { setAssignTarget(target); setCategoryManagerVisible(true); }
                }}
                style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
              >
                <Ionicons name="folder-outline" size={20} color={colors.primary} />
                <Text style={styles.menuRowText}>归入分类…</Text>
                <Text style={styles.menuRowHint}>{categories.find((category) => category.id === menuProject?.categoryId)?.name ?? "未分类"}</Text>
              </Pressable>
            ) : null}
            <Pressable
              accessibilityLabel="删除作品"
              onPress={() => {
                const target = menuProject;
                setMenuProject(null);
                if (target) confirmDelete(target);
              }}
              style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
            >
              <Ionicons name="trash-outline" size={20} color={colors.danger} />
              <Text style={[styles.menuRowText, styles.menuRowDanger]}>删除作品</Text>
            </Pressable>
          </View>
        </BottomSheet>

      <Modal visible={categoryManagerVisible} transparent animationType="fade" onRequestClose={closeCategoryManager}>
        <TopSheet
        title={assignTarget ? "归入分类" : "分类管理"}
        subtitle={assignTarget ? "归入后可按分类筛选书架" : "分类用于书架筛选，每部作品只归一个"}
        onClose={closeCategoryManager}
        avoidKeyboard
        >

          <PlainScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetScrollContent} keyboardShouldPersistTaps="handled">
            {assignTarget ? (
              <>
                <Text style={styles.sheetSectionTitle}>归入</Text>
                <Text style={styles.categorySectionHint}>将《{assignTarget.title}》归入：</Text>
                <Pressable
                  accessibilityLabel="归入未分类"
                  onPress={() => void assignToCategory(null)}
                  style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
                >
                  <Ionicons name="albums-outline" size={20} color={colors.textMuted} />
                  <Text style={styles.menuRowText}>未分类</Text>
                </Pressable>
                {categories.map((category) => (
                  <Pressable
                    key={category.id}
                    accessibilityLabel={`归入${category.name}`}
                    onPress={() => void assignToCategory(category.id)}
                    style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
                  >
                    <Ionicons name="folder-outline" size={20} color={colors.primary} />
                    <Text style={styles.menuRowText}>{category.name}</Text>
                    {assignTarget.categoryId === category.id ? <Ionicons name="checkmark" size={20} color={colors.primary} /> : null}
                  </Pressable>
                ))}
              </>
            ) : (
              <>
                <Text style={styles.sheetSectionTitle}>新建分类</Text>
                <Field label="分类名" value={newCategoryName} onChangeText={setNewCategoryName} />
                <Button label="创建分类" onPress={() => void addCategory()} disabled={!newCategoryName.trim()} />
                <Text style={styles.sheetSectionTitle}>已有分类</Text>
                {categories.length ? categories.map((category) => {
                  const count = projects.filter((project) => project.categoryId === category.id).length;
                  const renaming = renamingCategory?.id === category.id;
                  return renaming ? (
                    <View key={category.id} style={styles.categoryEditRow}>
                      <Field label="分类名" value={renamingCategory.name} onChangeText={(value) => setRenamingCategory({ id: category.id, name: value })} />
                      <View style={styles.categoryActions}>
                        <Button label="取消" variant="secondary" onPress={() => setRenamingCategory(null)} />
                        <Button label="保存" onPress={() => void saveCategoryRename()} disabled={!renamingCategory.name.trim()} />
                      </View>
                    </View>
                  ) : (
                    <View key={category.id} style={styles.categoryRow}>
                      <View style={[styles.categoryRow, { flex: 1 }]}>
                        <Text style={[styles.title, { fontSize: 14 }]}>{category.name}</Text>
                        <Text style={styles.categoryMeta}>{count} 部作品</Text>
                      </View>
                      <ScalePress accessibilityLabel={`重命名 ${category.name}`} onPress={() => setRenamingCategory({ id: category.id, name: category.name })} style={styles.iconButton}>
                        <Ionicons name="create-outline" size={19} color={colors.textMuted} />
                      </ScalePress>
                      <ScalePress accessibilityLabel={`删除 ${category.name}`} onPress={() => removeCategory(category)} style={styles.iconButton}>
                        <Ionicons name="trash-outline" size={19} color={colors.textMuted} />
                      </ScalePress>
                    </View>
                  );
                }) : <Text style={styles.categorySectionHint}>还没有分类，先创建一个。</Text>}
              </>
            )}
          </PlainScrollView>
        </TopSheet>
      </Modal>

      <Modal visible={showCreate} transparent animationType="fade" onRequestClose={() => setShowCreate(false)}>
        <KeyboardAvoidingView style={styles.modalBackdrop} behavior="height" automaticOffset>
          <View style={styles.modalBody}>
            <Text style={styles.modalTitle}>新建作品</Text>
            <Field label="书名" value={title} onChangeText={setTitle} autoFocus />
            <Field label="简介" value={description} onChangeText={setDescription} multiline />
            {/* 形式决定这部作品用哪个体裁智能体，必须选。点开选而不摊在面板上：
                形式以后变多时，这一行的高度与面板尺寸都不变。 */}
            <View style={styles.formField}>
              <Text style={styles.formLabel}>写作形式</Text>
              <Pressable
                accessibilityLabel="写作形式"
                onPress={() => setFormPickerVisible(true)}
                style={styles.formSelect}
              >
                <Text numberOfLines={1} style={[styles.formSelectValue, !createForm && styles.formSelectPlaceholder]}>
                  {projectFormLabel(createForm) ?? "请选择"}
                </Text>
                <Ionicons name="chevron-down" size={17} color={colors.textMuted} />
              </Pressable>
            </View>
            <View style={styles.modalActions}>
              <Button label="取消" variant="secondary" onPress={() => setShowCreate(false)} />
              <Button label="创建" onPress={() => void submit()} disabled={!title.trim() || !createForm} loading={saving} />
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <BottomSheet visible={formPickerVisible} title="选择写作形式" onClose={() => setFormPickerVisible(false)}>
        {PROJECT_FORMS.map((item) => {
          const selected = createForm === item.id;
          return (
            <Pressable
              key={item.id}
              accessibilityLabel={item.label}
              onPress={() => { setCreateForm(item.id); setFormPickerVisible(false); }}
              style={({ pressed }) => [styles.menuRow, (pressed || selected) && styles.menuRowPressed]}
            >
              <Ionicons name={selected ? "radio-button-on" : "radio-button-off"} size={20} color={selected ? colors.primary : colors.textMuted} />
              <Text style={styles.menuRowText}>{item.label}</Text>
            </Pressable>
          );
        })}
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
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  quickActions: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  quickAction: { flex: 1, minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.background },
  quickActionDisabled: { opacity: 0.48 },
  quickActionText: { color: colors.text, fontSize: 15, fontWeight: "700" },
  errorWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  list: { paddingVertical: spacing.sm },
  emptyList: { flexGrow: 1 },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 88 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.sm, paddingVertical: 8, marginBottom: 2 },
  rowPressed: { backgroundColor: colors.surfaceMuted },
  cover: { width: 52, height: 70, borderRadius: 2, alignItems: "flex-end", justifyContent: "center", overflow: "hidden" },
  coverImage: { width: 52, height: 70 },
  coverText: { color: "rgba(255,255,255,0.85)", fontSize: 34, fontWeight: "800", lineHeight: 40, marginBottom: 2 },
  statsRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 6 },
  meter: { width: 56, height: 4, borderRadius: 99, backgroundColor: colors.surfaceMuted, overflow: "hidden" },
  meterFill: { height: 4, borderRadius: 99, backgroundColor: colors.primary },
  statsText: { flex: 1, color: colors.textMuted, fontSize: 10.5 },
  headerActions: { flexDirection: "row", alignItems: "center" },
  shelfRow: { paddingHorizontal: 14, marginBottom: 2 },
  /**
   * 层板色罩：**只在深色档压暗**那张浅木色的贴图，浅色档透明（贴图原色本来就是对的）。
   * 用的是 `plankShade` 这个专用键而不是 `overlaySoft` —— 后者浅色档也压，压下去浅木色就成深棕。
   * 必须绝对定位铺满，自身不参与布局。
   */
  plankShade: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, backgroundColor: colors.plankShade },
  shelfBooks: { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 6 },
  shelfCell: { alignItems: "center" },
  bookObject: { width: "100%", aspectRatio: 3 / 4, borderRadius: 2, overflow: "hidden", justifyContent: "center" },
  bookSpine: { position: "absolute", left: 0, top: 0, bottom: 0, width: "9%", backgroundColor: colors.cream, borderRightWidth: 1, borderRightColor: colors.border },
  bookCoverTextWrap: { alignSelf: "stretch", alignItems: "center", gap: 2, paddingHorizontal: 18 },
  bookCoverLine: { color: "rgba(255,255,255,0.95)", fontSize: 16, fontWeight: "800", letterSpacing: 1 },
  bookCoverLineLead: { fontSize: 20 },
  shelfLabels: { flexDirection: "row", marginTop: 8 },
  // 书脊视图：一行 = 一条全宽层板 + 上面立着的若干书脊。
  spineShelfRow: { paddingLeft: 6, paddingRight: 6, paddingBottom: 10 },
  spineBooks: { flexDirection: "row", alignItems: "flex-end" },
  spineBook: {
    overflow: "hidden",
    borderTopLeftRadius: 1,
    borderTopRightRadius: 1,
    justifyContent: "center",
    // 绕书底旋转：歪出去的是书顶，书底始终踩在板上棱线上。
    transformOrigin: "bottom",
  },
  // 只留右缘一道很淡的暗（宽 20%），表示光从左侧来。原先的四层叠加（黑 0.22 / 白 0.22 /
  // 白 0.06 / 黑 0.24）里段与左段亮度差太大，看着是三条硬色带，没有弧面的过渡。
  spineShade: { position: "absolute", right: 0, top: 0, bottom: 0, width: "20%", backgroundColor: "rgba(0,0,0,0.12)" },
  // 竖排书名：逐字一行，读起来就是书脊上竖着印的字。
  spineTitleWrap: { width: "100%", alignItems: "center", overflow: "hidden" },
  spineTitle: { color: "rgba(255,255,255,0.96)", fontSize: 11, fontWeight: "700", lineHeight: 13, height: 13, textAlign: "center" },
  spineLabels: { flexDirection: "row", marginTop: 8 },
  // 宽度与左侧间距由 spineLayoutAt 按各自那本书给（不再 flex 均分），这里只兜住窄书的收缩。
  spineLabelCell: { minWidth: 0 },
  spineLabel: { color: colors.text, fontSize: 11, fontWeight: "600", textAlign: "center" },
  spineStats: { marginTop: 2, color: colors.textMuted, fontSize: 10, textAlign: "center" },
  shelfLabelCell: { alignItems: "center" },
  gridCover: { width: "100%", aspectRatio: 3 / 4, borderRadius: 10, alignItems: "flex-end", justifyContent: "center", overflow: "hidden" },
  gridCoverImage: { width: "100%", height: "100%" },
  gridCoverText: { color: "rgba(255,255,255,0.85)", fontSize: 40, fontWeight: "800", lineHeight: 46, marginBottom: 2 },
  gridName: { alignSelf: "stretch", fontSize: 12, fontWeight: "600", textAlign: "center" },
  gridStats: { alignSelf: "stretch", fontSize: 10, color: colors.textMuted, textAlign: "center" },
  shelfMenuBackdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 9 },
  shelfMenuCard: { position: "absolute", top: 100, right: 18, width: 176, backgroundColor: colors.background, borderRadius: 12, borderWidth: 1, borderColor: colors.border, paddingVertical: 4, zIndex: 10, elevation: 8, shadowColor: "#000", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 10 },
  menuBackdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay },
  sheetScroll: { flexShrink: 1 },
  sheetScrollContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.lg, gap: spacing.sm },
  sheetSectionTitle: { marginTop: spacing.xs, color: colors.textMuted, fontSize: 12, fontWeight: "700" },
  menuTitle: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xs, color: colors.textMuted, fontSize: 13 },
  menuRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 52, paddingHorizontal: spacing.lg },
  menuRowPressed: { backgroundColor: colors.surfaceMuted },
  menuRowDisabled: { opacity: 0.55 },
  shelfTitleButton: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  shelfTitleText: { color: colors.text, fontSize: 16, fontWeight: "700" },
  categoryPanel: { position: "absolute", top: 104, left: 16, right: 16, backgroundColor: colors.background, borderRadius: 12, borderWidth: 1, borderColor: colors.border, padding: spacing.sm, flexDirection: "row", flexWrap: "wrap", gap: 8, zIndex: 10, elevation: 8, shadowColor: "#000", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 10 },
  shelfChipsRow: { marginTop: 2 },
  shelfChipsContent: { flexDirection: "row", gap: 8, paddingHorizontal: 14, paddingVertical: 4 },
  shelfChip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border },
  shelfChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  shelfChipText: { color: colors.text, fontSize: 13 },
  shelfChipTextActive: { color: colors.onPrimary },
  categoryRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 10},
  categoryEditRow: { paddingVertical: spacing.sm },
  categoryHint: { marginLeft: "auto", color: colors.textMuted, fontSize: 12 },
  categorySectionHint: { color: colors.textMuted, fontSize: 13, lineHeight: 20, paddingVertical: 6 },
  categoryActions: { flexDirection: "row", gap: 10, marginTop: 8 },
  categoryMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  menuRowHint: { marginLeft: "auto", color: colors.textMuted, fontSize: 12 },
  menuRowText: { color: colors.text, fontSize: 15, fontWeight: "600" },
  menuRowDanger: { color: colors.danger },
  infoSheet: { maxHeight: "80%", padding: spacing.lg, gap: spacing.sm, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, backgroundColor: colors.background },
  infoDescription: { minHeight: 96 },
  infoStats: { color: colors.textMuted, fontSize: 13 },
  infoActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
  rowText: { flex: 1, gap: spacing.xs },
  rowAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { color: colors.text, fontSize: 17, fontWeight: "700" },
  description: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  modalBackdrop: { flex: 1, justifyContent: "center", padding: spacing.lg, backgroundColor: colors.overlay },
  modalBody: { gap: spacing.lg, padding: spacing.xl, borderRadius: radius.md, backgroundColor: colors.background },
  modalTitle: { color: colors.text, fontSize: 20, fontWeight: "700" },
  /**
   * 写作形式这一行的取值照 `components/ui.tsx` 的 field / label / input 三个样式来。
   * 它和上面的书名、简介在同一个字段列里，尺寸与描边要和它们一致，所以不另起一套数。
   */
  formField: { gap: spacing.sm },
  formLabel: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  formSelect: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
  formSelectValue: { flexShrink: 1, minWidth: 0, color: colors.text, fontSize: 16 },
  formSelectPlaceholder: { color: colors.textMuted },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm },
}));

// 作品菜单进顶部面板后的容器：行自带左右内边距，这里只补行距与底部留白。
const menuSheetBody = { gap: 2 } as const;

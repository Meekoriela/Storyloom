import { Platform } from "react-native";

/**
 * 主题档位：跟随系统 / 常亮 / 常暗。
 * 常暗是给夜里写长篇用的 —— 长时间盯着白底眼睛疲劳，跟随系统之外的显式选择是刚需。
 */
export type AppearanceMode = "system" | "light" | "dark";

/**
 * 全部色值集中在这里，且只在这里。
 *
 * 档位切换的实现：`colors` 与 `shadow` 是**活的**可变对象，切换档位时原地替换内容；
 * 各屏的样式对象由 `themedStyles` 生成，它在档位变化时整体重建（React Native 的
 * StyleSheet.create 会把颜色值固化，所以必须重建，不能靠换引用）。
 *
 * ⇒ **任何硬编码色值都是错的** —— 新增颜色一律加进下面两套里，
 * 否则切到深色时那些地方会露出浅色块。
 */
const lightColors = {
  background: "#F7F7F5",
  surface: "#FFFFFF",
  surfaceMuted: "#EFEFEC",
  text: "#20211F",
  /** 次级文字里较浅的一档，用于标签式内容（App 更新说明的补充行）。 */
  textFaint: "#3B3C3A",
  textMuted: "#696B66",
  border: "#D9DAD5",
  primary: "#176B57",
  primaryPressed: "#0F5444",
  /** 选中态底色：设置页的选中行、筛选 chip 选中态都用它。 */
  primarySoft: "#E6F3EF",
  /** 压在 primary 色块上的文字与图标。深色档下 primary 变亮，这一档必须跟着变深才读得清。 */
  onPrimary: "#FFFFFF",
  accent: "#D95D39",
  /** 差异与增量的「+」号用色，与 primary 同族但更亮一档。 */
  success: "#1B7F4D",
  danger: "#B42318",
  dangerSoft: "#FDECEA",
  dangerSoftStrong: "#FCEBEB",
  dangerBorder: "#E4B4AE",
  /** danger 的兜底值（仅当 colors.danger 缺失时启用，实际不生效）。 */
  dangerFallback: "#A32D2D",
  overlay: "rgba(20, 21, 19, 0.48)",
  overlaySoft: "rgba(20, 21, 19, 0.25)",
  /**
   * 书架层板的压暗罩。**只在深色档生效**，浅色档透明。
   *
   * 为什么不复用 `overlaySoft`：那个 token 的语义是「半透明黑压暗」，两档都有值。
   * 层板要的却只是深色档压暗 —— 浅木色的层板贴图（中部亮度 246）在浅色档本来就是对的颜色，
   * 盖一层 0.25 的近黑会把它变成深棕。深色档下那张贴图又会发白，所以要压。
   */
  plankShade: "transparent",
  /** 米色：书架书脊的底。 */
  cream: "#EDE6D8",
  /** 青灰：文风库书籍图标底。 */
  teal: "#DCECE6",
  /** 薄荷：助手页协作提示条的底。 */
  mint: "#E8F2EE",
  /** 暖白：助手页失败卡的底。 */
  sand: "#FFF4F2",
  /** 无封面时按 id 哈希取色用的装饰色板，深色档整体降亮度。 */
  coverPalette: ["#2E6B5A", "#8A5A4A", "#4A5B8A", "#7A6A4A", "#5F4A6B"],
} as const;

const darkColors = {
  background: "#141512",
  surface: "#1E1F1B",
  surfaceMuted: "#282A25",
  text: "#ECEDE8",
  textFaint: "#B8BAB0",
  textMuted: "#9A9C93",
  border: "#34362F",
  primary: "#4FBE9A",
  primaryPressed: "#63CBA8",
  primarySoft: "#1E3A31",
  onPrimary: "#0E1512",
  accent: "#E8825F",
  success: "#5FCB92",
  danger: "#F07870",
  dangerSoft: "#3A1E1B",
  dangerSoftStrong: "#46211E",
  dangerBorder: "#6B322C",
  dangerFallback: "#F07870",
  overlay: "rgba(0, 0, 0, 0.6)",
  overlaySoft: "rgba(0, 0, 0, 0.35)",
  /** 浅木色层板在深色档下会发白，压一层黑；浅色档见同键的注释。 */
  plankShade: "rgba(0, 0, 0, 0.35)",
  cream: "#2E2A20",
  teal: "#1F2E29",
  mint: "#1B2A26",
  sand: "#2E2320",
  coverPalette: ["#2E4A40", "#4A3830", "#33405A", "#443C2E", "#3E2E42"],
} as const;

export type ThemeColors = {
  readonly [K in keyof typeof lightColors]: (typeof lightColors)[K] extends string
    ? string
    : readonly string[];
};

export const PALETTES: Record<"light" | "dark", ThemeColors> = {
  light: lightColors,
  dark: darkColors,
};

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 14, lg: 20, /** 底部弹层顶角，Material 3 规范值 */ sheet: 28 } as const;

/** 等宽字体：参数与结果区用它，靠字体本身说明「这是数据不是正文」。 */
export const FONT_MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

type ShadowToken = {
  shadowColor: string;
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffset: { width: number; height: number };
  elevation: number;
};

/**
 * 卡片阴影：Android 走 elevation，iOS 走四件套。只用于可点卡片与浮层，标题栏/ tab 栏保持扁平。
 *
 * 深色档换了两件事：阴影色改纯黑（浅色档的墨色在深底上等于没有），并把不透明度与半径一起
 * 调高 —— 深底上的投影本身对比低，只调黑会让卡片显得是浮空的而不是抬起的。
 */
function buildShadow(dark: boolean): { card: ShadowToken } {
  return {
    card: dark
      ? {
          shadowColor: "#000000",
          shadowOpacity: 0.55,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 4 },
          elevation: 6,
        }
      : {
          shadowColor: lightColors.text,
          shadowOpacity: 0.07,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 3 },
          elevation: 2,
        },
  };
}

/** 生效中的色板与阴影。可变对象：切换档位时原地替换内容，引用不变。 */
export const colors = { ...lightColors } as ThemeColors;
export const shadow: { card: ShadowToken } = buildShadow(false);

/** 每次换档位自增，供 themedStyles 判断是否需要重建样式。 */
let paletteVersion = 0;
let appliedKind: "light" | "dark" = "light";

export function currentPaletteVersion(): number {
  return paletteVersion;
}

/**
 * 把某一套色板就地写进 colors / shadow。
 *
 * 必须**在渲染之前**调用：React 的渲染先于 effect，若等到 effect 才换，
 * 那一次渲染拿到的仍是旧样式，界面会停在旧配色，直到下一次重渲染才对。
 * 幂等 —— 同一套重复应用不会推进版本号，避免白白让所有样式表重建。
 */
export function applyPalette(kind: "light" | "dark") {
  if (appliedKind === kind) return;
  appliedKind = kind;
  const next = PALETTES[kind];
  for (const key of Object.keys(next) as Array<keyof ThemeColors>) {
    // 逐键赋值而不是换引用：各屏已经 import 了这个对象，换引用会让他们读到旧值。
    (colors as Record<string, unknown>)[key] = next[key];
  }
  Object.assign(shadow.card, buildShadow(kind === "dark").card);
  paletteVersion += 1;
}

export function currentScheme(): "light" | "dark" {
  return appliedKind;
}

/**
 * 生成一份随档位重建的样式表。
 *
 * 用法：把原来每个文件顶部的
 *     const styles = StyleSheet.create({ ... });
 * 改成
 *     const styles = themedStyles((colors, shadow) => StyleSheet.create({ ... }));
 * 工厂函数体里的 `colors` / `shadow` 是形参，会遮蔽模块导入的同名对象，
 * **所以样式体一行都不用改**。读取某个样式键时按当前档位惰性重建并缓存，
 * 档位切换后第一次访问即拿到新的一套。
 */
export function themedStyles<T extends Record<string, unknown>>(
  factory: (colors: ThemeColors, shadow: { card: ShadowToken }) => T,
): T {
  const cache = new Map<number, T>();
  return new Proxy({} as T, {
    get(_target, key: string) {
      let sheet = cache.get(paletteVersion);
      if (!sheet) {
        sheet = factory(colors, shadow);
        cache.clear();
        cache.set(paletteVersion, sheet);
      }
      return sheet[key];
    },
  }) as T;
}

/** 读取偏好里的档位；未设置或值非法时回落到「跟随系统」。 */
export function normalizeAppearanceMode(value: string | null | undefined): AppearanceMode {
  return value === "light" || value === "dark" ? value : "system";
}

/** 存储键。沿用 settings 一贯的 `general.` 前缀。 */
export const APPEARANCE_MODE_KEY = "general.appearanceMode";
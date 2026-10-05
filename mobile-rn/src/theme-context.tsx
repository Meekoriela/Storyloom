import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";

import { getSetting, setSetting } from "@/data/repositories";
import {
  APPEARANCE_MODE_KEY,
  applyPalette,
  normalizeAppearanceMode,
  type AppearanceMode,
} from "@/theme";

/**
 * 外观档位的唯一来源。
 *
 * 三档：`system` 跟随系统、`light` 常亮、`dark` 常暗。写长篇常在夜里写，
 * 所以显式的常暗是刚需，不交给系统决定。
 */
interface AppearanceValue {
  mode: AppearanceMode;
  /** 实际生效的档位（mode 为 system 时由系统决定）。 */
  scheme: "light" | "dark";
  setMode: (mode: AppearanceMode) => void;
}

const AppearanceContext = createContext<AppearanceValue>({
  mode: "system",
  scheme: "light",
  setMode: () => undefined,
});

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<AppearanceMode>("system");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await getSetting(APPEARANCE_MODE_KEY);
        if (!cancelled) setModeState(normalizeAppearanceMode(stored));
      } catch {
        // 读失败就按「跟随系统」起步：外观偏好不值得阻断启动。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const scheme: "light" | "dark" =
    mode === "system" ? (systemScheme === "dark" ? "dark" : "light") : mode;

  // 渲染期就换色板，而不是放进 useEffect：React 先渲染再跑 effect，
  // 放进 effect 会让「切档位」那一次渲染读到旧色板，界面要等下一次重渲染才对。
  // applyPalette 内部幂等，同一套重复调用不会推进版本号。
  applyPalette(scheme);

  const setMode = useCallback((next: AppearanceMode) => {
    setModeState(next);
    void setSetting(APPEARANCE_MODE_KEY, next);
  }, []);

  const value = useMemo<AppearanceValue>(() => ({ mode, scheme, setMode }), [mode, scheme, setMode]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceValue {
  return useContext(AppearanceContext);
}
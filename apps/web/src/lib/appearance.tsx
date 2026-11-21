import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Theme } from "@astryxdesign/core/theme";
import { createContext, type ReactNode, use, useState } from "react";
import { defaultThemeSlug, themes } from "../astryx-themes.ts";

type Appearance = "system" | "light" | "dark";

const theme = themes[defaultThemeSlug];
const AppearanceContext = createContext<
  [mode: Appearance, setMode: (mode: Appearance) => void] | null
>(null);

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const appearance = useState<Appearance>(() => {
    // index.html applies any saved override before the first paint.
    const initial = document.documentElement.dataset.theme;
    return initial === "light" || initial === "dark" ? initial : "system";
  });

  return (
    <AppearanceContext value={appearance}>
      <Theme theme={theme} mode={appearance[0]}>
        {children}
      </Theme>
    </AppearanceContext>
  );
}

export function AppearancePicker() {
  const appearance = use(AppearanceContext);
  if (appearance === null) throw new Error("AppearancePicker requires AppearanceProvider.");
  const [mode, setMode] = appearance;

  function select(value: string) {
    if (value !== "light" && value !== "dark" && value !== "system") return;
    setMode(value);
    try {
      if (value === "system") window.localStorage.removeItem("orrery.appearance");
      else window.localStorage.setItem("orrery.appearance", value);
    } catch {
      // The current tab can still change appearance when storage is unavailable.
    }
  }

  return (
    <section className="appearance-picker">
      <Theme theme={theme} mode="dark">
        <SegmentedControl label="Appearance" size="sm" value={mode} onChange={select}>
          <SegmentedControlItem value="system" label="System" />
          <SegmentedControlItem value="light" label="Light" />
          <SegmentedControlItem value="dark" label="Dark" />
        </SegmentedControl>
      </Theme>
    </section>
  );
}

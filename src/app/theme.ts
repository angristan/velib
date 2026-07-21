import type { MapBackground } from "./types"

export interface ThemeChange {
  readonly colorScheme: MapBackground
  readonly mapBackground: MapBackground
}

// The map must switch in the same render as the application theme.
export const themeChangeFor = (colorScheme: MapBackground): ThemeChange => ({
  colorScheme,
  mapBackground: colorScheme,
})

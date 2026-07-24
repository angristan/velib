import "@fontsource-variable/nunito/index.css"
import "@fontsource-variable/red-hat-display/index.css"
import "@mantine/core/styles.css"
import "@mantine/charts/styles.css"
import "maplibre-gl/dist/maplibre-gl.css"
import "./styles.css"

import { createTheme, MantineProvider, type MantineColorsTuple } from "@mantine/core"
import { QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { I18nProvider } from "./i18n"
import { createAppQueryClient } from "./query-client"

const blue: MantineColorsTuple = [
  "#eef6ff", "#dcecff", "#b9d8ff", "#8fc0ff", "#5da2f5",
  "#2f85ea", "#1473e6", "#0d61c6", "#0b50a3", "#0b4385",
]
const green: MantineColorsTuple = [
  "#e9faf5", "#d1f4e8", "#a6e8d4", "#76d8bd", "#43c4a3",
  "#1aaf8b", "#0a9a79", "#087c64", "#096451", "#095143",
]
const red: MantineColorsTuple = [
  "#fff1ef", "#ffe0dc", "#ffc0ba", "#f99c93", "#ee746b",
  "#df5b52", "#cf4d45", "#ae3d37", "#903530", "#772f2b",
]

const theme = createTheme({
  colors: { blue, green, red },
  primaryColor: "blue",
  primaryShade: { light: 6, dark: 5 },
  defaultRadius: "xs",
  radius: { xs: "3px", sm: "5px", md: "8px", lg: "10px", xl: "999px" },
  shadows: {
    xs: "0 1px 2px rgba(15, 31, 52, 0.08)",
    sm: "0 4px 12px rgba(15, 31, 52, 0.10)",
    md: "0 10px 28px rgba(15, 31, 52, 0.14)",
    lg: "0 18px 46px rgba(15, 31, 52, 0.18)",
    xl: "0 24px 64px rgba(15, 31, 52, 0.22)",
  },
  autoContrast: true,
  cursorType: "pointer",
  respectReducedMotion: true,
  fontFamily: '"Nunito Variable", Nunito, ui-sans-serif, system-ui, sans-serif',
  headings: {
    fontFamily: '"Red Hat Display Variable", "Nunito Variable", ui-sans-serif, system-ui, sans-serif',
    fontWeight: "700",
    textWrap: "balance",
  },
})

const queryClient = createAppQueryClient()

const root = document.getElementById("root")
if (!root) throw new Error("Point de montage React introuvable")

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MantineProvider defaultColorScheme="auto" theme={theme}>
          <App />
        </MantineProvider>
      </I18nProvider>
    </QueryClientProvider>
  </StrictMode>,
)

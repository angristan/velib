import "@fontsource-variable/nunito/index.css"
import "@fontsource-variable/red-hat-display/index.css"
import "@mantine/core/styles.css"
import "@mantine/charts/styles.css"
import "maplibre-gl/dist/maplibre-gl.css"
import "./styles.css"

import { createTheme, MantineProvider } from "@mantine/core"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"

const theme = createTheme({
  primaryColor: "blue",
  primaryShade: 8,
  defaultRadius: "md",
  fontFamily: '"Nunito Variable", Nunito, ui-sans-serif, system-ui, sans-serif',
  headings: {
    fontFamily: '"Red Hat Display Variable", "Nunito Variable", ui-sans-serif, system-ui, sans-serif',
    fontWeight: "700",
  },
})

const root = document.getElementById("root")
if (!root) throw new Error("Point de montage React introuvable")

createRoot(root).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="auto" theme={theme}>
      <App />
    </MantineProvider>
  </StrictMode>,
)

/** @vitest-environment jsdom */

import { MantineProvider } from "@mantine/core"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

import { Header } from "./components/Header"
import { I18nProvider } from "./i18n"

beforeEach(() => {
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage })
  document.head.querySelector('meta[name="description"]')?.remove()
  const description = document.createElement("meta")
  description.name = "description"
  document.head.appendChild(description)
  window.localStorage.clear()
  window.localStorage.setItem("velib:locale", "fr")
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      matches: false,
      media: query,
      removeEventListener: vi.fn(),
    })),
  })
})

afterEach(cleanup)

it("switches the interface to English and persists the preference", async () => {
  const user = userEvent.setup()
  render(
    <I18nProvider>
      <MantineProvider>
        <Header
          colorScheme="light"
          data={null}
          loading={false}
          onColorSchemeChange={vi.fn()}
          onRefresh={vi.fn()}
        />
      </MantineProvider>
    </I18nProvider>,
  )

  await user.click(screen.getByRole("button", { name: "Switch to English" }))

  expect(screen.getByText("Network observatory")).toBeTruthy()
  expect(screen.getByRole("button", { name: "Passer en français" })).toBeTruthy()
  expect(screen.getByRole("group", { name: "Mechanical bikes: 0" })).toBeTruthy()
  expect(document.documentElement.lang).toBe("en")
  expect(document.title).toBe("Vélib’ Pulse — Live availability")
  expect(window.localStorage.getItem("velib:locale")).toBe("en")
  await waitFor(() => {
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content"))
      .toBe("Live Vélib’ availability and one year of history.")
  })
})

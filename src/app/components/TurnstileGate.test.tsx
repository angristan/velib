/** @vitest-environment jsdom */

import { MantineProvider } from "@mantine/core"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, assert, beforeEach, it, vi } from "vitest"

import { TurnstileGate } from "./TurnstileGate"

beforeEach(() => {
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

it("keeps keyboard focus inside the mandatory verification dialog", async () => {
  const user = userEvent.setup()
  render(
    <MantineProvider>
      <button type="button">Application control</button>
      <TurnstileGate
        checked
        error="La vérification est indisponible"
        onRetry={vi.fn()}
        onToken={vi.fn().mockResolvedValue(false)}
        siteKey="test-site-key"
      />
    </MantineProvider>,
  )

  const dialog = screen.getByRole("dialog")
  await waitFor(() => assert.isTrue(dialog.contains(document.activeElement)))

  await user.tab()
  assert.isTrue(dialog.contains(document.activeElement))
  await user.tab()
  assert.isTrue(dialog.contains(document.activeElement))

  await user.keyboard("{Escape}")
  assert.isNotNull(screen.getByRole("dialog"))
})

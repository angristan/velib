/** @vitest-environment jsdom */

import { MantineProvider } from "@mantine/core"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, assert, beforeEach, it, vi } from "vitest"

import { ReplayControls } from "./ReplayControls"

const latestAt = 1_784_625_060_000

const renderControls = (timelineMode: "explore" | "compare", compact = false) => {
  const onTimelineModeChange = vi.fn()

  render(
    <MantineProvider>
      <ReplayControls
        compact={compact}
        comparison={timelineMode === "compare" ? [latestAt - 900_000, latestAt] : null}
        frameCount={12}
        latestAt={latestAt}
        loading={false}
        mapMode="stations"
        mode="replay"
        onComparisonChange={vi.fn()}
        onMapModeChange={vi.fn()}
        onModeChange={vi.fn()}
        onPlayingChange={vi.fn()}
        onSelectedAtChange={vi.fn()}
        onShare={vi.fn()}
        onSpeedChange={vi.fn()}
        onTimelineModeChange={onTimelineModeChange}
        playing={false}
        selectedAt={latestAt}
        shareConfirmed={false}
        speed={1}
        timelineMode={timelineMode}
      />
    </MantineProvider>,
  )

  return { onTimelineModeChange }
}

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

it("offers one seven-day scale and commits comparison mode", async () => {
  const user = userEvent.setup()
  const handlers = renderControls("explore")

  assert.isNotNull(screen.getByRole("slider", { name: "Instant affiché sur la carte" }))
  assert.isNotNull(screen.getByText("−7 j"))
  assert.isNotNull(screen.getByText("−15 min"))
  assert.isAtLeast(screen.getAllByText("Maintenant").length, 1)
  assert.isNull(screen.queryByRole("button", { name: "7 j" }))
  assert.isNull(screen.queryByRole("button", { name: "Afficher les variations" }))

  await user.click(screen.getByRole("button", { name: "Comparer" }))
  assert.deepEqual(handlers.onTimelineModeChange.mock.calls, [["compare"]])
})

it("labels comparison endpoints outside plain slider handles", () => {
  renderControls("compare")

  assert.isNotNull(screen.getByRole("slider", { name: "Instant avant" }))
  assert.isNotNull(screen.getByRole("slider", { name: "Instant après" }))
  assert.isNotNull(screen.getByText("Avant"))
  assert.isNotNull(screen.getByText("Après"))
  assert.isNotNull(screen.getByText(/montre automatiquement la variation/))
})

it("keeps readable temporal context while station details are open", () => {
  renderControls("compare", true)

  assert.isNotNull(screen.getByLabelText("Contexte temporel de la station"))
  assert.isNull(screen.queryByRole("slider"))
})

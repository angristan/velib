/** @vitest-environment jsdom */

import { MantineProvider } from "@mantine/core"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, assert, beforeEach, it, vi } from "vitest"

import { ReplayControls } from "./ReplayControls"

const latestAt = 1_784_625_060_000

const renderControls = (timelineMode: "explore" | "compare", compact = false) => {
  const onTimelineModeChange = vi.fn()
  const onTimelineRangeChange = vi.fn()

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
        onTimelineRangeChange={onTimelineRangeChange}
        playing={false}
        selectedAt={latestAt}
        shareConfirmed={false}
        speed={1}
        timelineMode={timelineMode}
        timelineRange="1h"
      />
    </MantineProvider>,
  )

  return { onTimelineModeChange, onTimelineRangeChange }
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

it("offers semantic zoom ranges and commits mode changes", async () => {
  const user = userEvent.setup()
  const handlers = renderControls("explore")

  assert.isNotNull(screen.getByRole("slider", { name: "Instant affiché sur la carte" }))
  await user.click(screen.getByRole("button", { name: "Comparer" }))
  await user.click(screen.getByRole("button", { name: "7 j" }))

  assert.deepEqual(handlers.onTimelineModeChange.mock.calls, [["compare"]])
  assert.deepEqual(handlers.onTimelineRangeChange.mock.calls, [["7d"]])
})

it("labels both comparison endpoints for keyboard and touch users", () => {
  renderControls("compare")

  assert.isNotNull(screen.getByRole("slider", { name: "Instant de départ A" }))
  assert.isNotNull(screen.getByRole("slider", { name: "Instant d’arrivée B" }))
  assert.isNotNull(screen.getByText(/Variation nette entre A et B/))
})

it("collapses to temporal context while station details are open", () => {
  renderControls("compare", true)

  assert.isNotNull(screen.getByLabelText("Contexte temporel de la station"))
  assert.isNull(screen.queryByRole("slider"))
})

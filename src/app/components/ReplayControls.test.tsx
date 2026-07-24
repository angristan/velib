/** @vitest-environment jsdom */

import { MantineProvider } from "@mantine/core"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, assert, beforeEach, it, vi } from "vitest"

import { ReplayControls } from "./ReplayControls"

const latestAt = 1_784_625_060_000

const renderControls = (
  timelineMode: "explore" | "compare",
  compact = false,
  playbackLoading = false,
  mode: "live" | "replay" = "replay",
) => {
  const onModeChange = vi.fn()
  const onTimelineModeChange = vi.fn()

  render(
    <MantineProvider>
      <ReplayControls
        compact={compact}
        comparison={timelineMode === "compare" ? [latestAt - 900_000, latestAt] : null}
        frameCount={12}
        latestAt={latestAt}
        loading={false}
        mode={mode}
        onComparisonChange={vi.fn()}
        onModeChange={onModeChange}
        onPlayingChange={vi.fn()}
        onSelectedAtChange={vi.fn()}
        onShare={vi.fn()}
        onSpeedChange={vi.fn()}
        onTimelineModeChange={onTimelineModeChange}
        playbackLoading={playbackLoading}
        playing={playbackLoading}
        selectedAt={latestAt}
        shareConfirmed={false}
        speed={1}
        timelineMode={timelineMode}
      />
    </MantineProvider>,
  )

  return { onModeChange, onTimelineModeChange }
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

it("keeps the live toolbar focused on archives and sharing", () => {
  renderControls("explore", false, false, "live")

  assert.isNotNull(screen.getByText("Archives"))
  assert.isNotNull(screen.getByText("Partager"))
  assert.isNull(screen.queryByText("Variations"))
})

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

  await user.click(screen.getByRole("button", { name: "Fermer les archives" }))
  assert.deepEqual(handlers.onModeChange.mock.calls, [["live"]])
})

it("shows cancellable feedback while preparing one-hour playback", () => {
  renderControls("explore", false, true)

  assert.isNotNull(screen.getByText("Préparation de la relecture…"))
  assert.isNotNull(screen.getByRole("button", { name: "Annuler la préparation de la relecture" }))
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

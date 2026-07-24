/** @vitest-environment jsdom */

import { MantineProvider } from "@mantine/core"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, assert, beforeEach, it, vi } from "vitest"

import type { Station } from "../types"
import { StationDetails } from "./StationDetails"

const station: Station = {
  capacity: 20,
  code: "1001",
  docks: 7,
  electric: 4,
  id: "1001",
  isInstalled: true,
  isRenting: true,
  isReturning: true,
  latitude: 48.856,
  longitude: 2.342,
  mechanical: 9,
  name: "Quai de l’Horloge",
  unavailable: 0,
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      matches: query.includes("max-width"),
      media: query,
      removeEventListener: vi.fn(),
    })),
  })
})

afterEach(cleanup)

it("renders the Drawer immediately and returns mobile focus visibly", async () => {
  const user = userEvent.setup()
  const onClose = vi.fn()
  let returnTarget: HTMLButtonElement | null = null

  render(
    <MantineProvider>
      <button ref={(node) => { returnTarget = node }} type="button">
        Carte
      </button>
      <StationDetails
        history={null}
        historyEnabled={false}
        historyError={null}
        historyLoading={false}
        nearby={[]}
        onClose={onClose}
        onMobileCloseFocus={() => returnTarget?.focus()}
        onRangeChange={vi.fn()}
        onSelect={vi.fn()}
        range="3h"
        station={station}
        trend={{ deltas: [], points: [] }}
        variation={null}
        variationLabel="Variation en direct"
      />
    </MantineProvider>,
  )

  assert.isNotNull(screen.getByRole("dialog"))
  assert.isNull(document.querySelector(".station-detail-panel"))

  const closeButton = screen.getAllByRole("button").find((button) => button !== returnTarget)
  assert.isDefined(closeButton)
  await user.click(closeButton)

  assert.strictEqual(onClose.mock.calls.length, 1)
  await waitFor(() => assert.strictEqual(document.activeElement, returnTarget))
})

import type { Station } from "./types"

type StationAvailability = Pick<
  Station,
  "capacity" | "mechanical" | "electric" | "docks"
>

export interface AvailabilityBins {
  readonly mechanical: number
  readonly electric: number
  readonly docks: number
  readonly unavailable: number
}

export const availabilityBins = (station: StationAvailability): AvailabilityBins => {
  // A malformed feed total must not create an impossible marker with more than ten parts.
  const capacity = Math.max(
    1,
    station.capacity,
    station.mechanical + station.electric + station.docks,
  )
  const exactMechanical = Math.max(0, station.mechanical / capacity * 10)
  const exactElectric = Math.max(0, station.electric / capacity * 10)
  const exactDocks = Math.max(0, station.docks / capacity * 10)
  let mechanical = Math.floor(exactMechanical)
  let electric = Math.floor(exactElectric)
  let docks = Math.floor(exactDocks)
  const target = Math.min(10, Math.round(exactMechanical + exactElectric + exactDocks))
  const remainders = [
    { part: "mechanical", value: exactMechanical - mechanical },
    { part: "electric", value: exactElectric - electric },
    { part: "docks", value: exactDocks - docks },
  ].sort((left, right) => right.value - left.value)

  const remainderCount = target - mechanical - electric - docks
  for (let index = 0; index < remainderCount; index += 1) {
    const part = remainders[index]?.part
    if (part === "mechanical") mechanical += 1
    else if (part === "electric") electric += 1
    else docks += 1
  }

  return {
    mechanical,
    electric,
    docks,
    unavailable: 10 - mechanical - electric - docks,
  }
}

export const availabilityMarkerKey = (station: StationAvailability): string => {
  const bins = availabilityBins(station)
  return `availability-${bins.mechanical}-${bins.electric}-${bins.docks}`
}

import { Aggregate, NetworkRollup, SnapshotRecord, StationMetadata, StationRollup } from "./domain"

interface TimedStation {
  readonly observedAt: number
  readonly mechanical: number
  readonly electric: number
  readonly docks: number
  readonly unavailable: number
  readonly operative: number
}

interface NetworkSample {
  readonly mechanical: number
  readonly electric: number
  readonly docks: number
  readonly unavailable: number
  readonly operativeStations: number
  readonly emptyStations: number
  readonly fullStations: number
}

const aggregate = (values: ReadonlyArray<number>): Aggregate => {
  if (values.length === 0) {
    return Aggregate.make({ min: 0, max: 0, avg: 0 })
  }

  const total = values.reduce((sum, value) => sum + value, 0)
  return Aggregate.make({
    min: Math.min(...values),
    max: Math.max(...values),
    avg: total / values.length
  })
}

const movements = (
  samples: ReadonlyArray<TimedStation>,
  field: "mechanical" | "electric"
): { readonly removed: number; readonly returned: number } => {
  let removed = 0
  let returned = 0

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    if (current.observedAt - previous.observedAt !== 60) {
      continue
    }

    const delta = current[field] - previous[field]
    if (delta < 0) {
      removed += -delta
    } else {
      returned += delta
    }
  }

  return { removed, returned }
}

export const deriveRollups = (
  bucketAt: number,
  snapshots: ReadonlyArray<SnapshotRecord>,
  metadata: ReadonlyArray<StationMetadata>
): { readonly stations: ReadonlyArray<StationRollup>; readonly network: NetworkRollup } => {
  const capacities = new Map<number, number>()
  for (const station of metadata) {
    capacities.set(station.stationCode, station.capacity)
  }

  const samplesByStation = new Map<number, Array<TimedStation>>()
  const networkSamples: Array<NetworkSample> = []

  for (const snapshot of snapshots) {
    let mechanical = 0
    let electric = 0
    let docks = 0
    let unavailable = 0
    let operativeStations = 0
    let emptyStations = 0
    let fullStations = 0

    for (const station of snapshot.snapshot.s) {
      const capacity = capacities.get(station.c) ?? station.m + station.e + station.d
      const unavailableDocks = Math.max(0, capacity - station.m - station.e - station.d)
      const stationSamples = samplesByStation.get(station.c) ?? []

      stationSamples.push({
        observedAt: snapshot.observedAt,
        mechanical: station.m,
        electric: station.e,
        docks: station.d,
        unavailable: unavailableDocks,
        operative: station.o
      })
      samplesByStation.set(station.c, stationSamples)

      mechanical += station.m
      electric += station.e
      docks += station.d
      unavailable += unavailableDocks
      operativeStations += station.o
      if (station.o === 1 && station.m + station.e === 0) {
        emptyStations += 1
      }
      if (station.o === 1 && station.d === 0) {
        fullStations += 1
      }
    }

    networkSamples.push({
      mechanical,
      electric,
      docks,
      unavailable,
      operativeStations,
      emptyStations,
      fullStations
    })
  }

  const stationRollups: Array<StationRollup> = []
  for (const [code, samples] of samplesByStation) {
    const mechanicalMovement = movements(samples, "mechanical")
    const electricMovement = movements(samples, "electric")

    stationRollups.push({
      stationCode: code,
      bucketAt,
      sampleCount: samples.length,
      mechanical: aggregate(samples.map((sample) => sample.mechanical)),
      mechanicalRemoved: mechanicalMovement.removed,
      mechanicalReturned: mechanicalMovement.returned,
      electric: aggregate(samples.map((sample) => sample.electric)),
      electricRemoved: electricMovement.removed,
      electricReturned: electricMovement.returned,
      docks: aggregate(samples.map((sample) => sample.docks)),
      unavailable: aggregate(samples.map((sample) => sample.unavailable)),
      operativeSamples: samples.reduce((sum, sample) => sum + sample.operative, 0)
    })
  }

  return {
    stations: stationRollups,
    network: NetworkRollup.make({
      sampleCount: networkSamples.length,
      mechanical: aggregate(networkSamples.map((sample) => sample.mechanical)),
      electric: aggregate(networkSamples.map((sample) => sample.electric)),
      docks: aggregate(networkSamples.map((sample) => sample.docks)),
      unavailable: aggregate(networkSamples.map((sample) => sample.unavailable)),
      operativeStations: aggregate(networkSamples.map((sample) => sample.operativeStations)),
      emptyStations: aggregate(networkSamples.map((sample) => sample.emptyStations)),
      fullStations: aggregate(networkSamples.map((sample) => sample.fullStations))
    })
  }
}

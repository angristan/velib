import {
  LiveUpdateEvent,
  ReplayBaseline,
  ReplayResponse,
  ReplayWindowMinutes,
  SnapshotRecord
} from "./domain"
import { deriveLiveUpdate } from "./live-update"

export const deriveReplayFromUpdates = (
  baseline: SnapshotRecord,
  frames: ReadonlyArray<LiveUpdateEvent>,
  minutes: ReplayWindowMinutes,
  generatedAt: number
): ReplayResponse | null => {
  let previousObservedAt = baseline.observedAt
  let previousSourceUpdatedAt = baseline.sourceUpdatedAt
  for (const frame of frames) {
    if (
      frame.observedAt <= previousObservedAt ||
      frame.previousSourceUpdatedAt !== previousSourceUpdatedAt ||
      frame.sourceUpdatedAt <= previousSourceUpdatedAt
    ) return null
    previousObservedAt = frame.observedAt
    previousSourceUpdatedAt = frame.sourceUpdatedAt
  }

  return ReplayResponse.make({
    v: 1,
    minutes,
    generatedAt,
    from: baseline.observedAt,
    to: frames.at(-1)?.observedAt ?? baseline.observedAt,
    baseline: ReplayBaseline.make({
      observedAt: baseline.observedAt,
      sourceUpdatedAt: baseline.sourceUpdatedAt,
      stations: baseline.snapshot.s
    }),
    frames
  })
}

/**
 * Stale cron observations can repeat an upstream source timestamp. Replay keeps
 * only advancing source states so every frame is sequential and meaningful.
 */
export const deriveReplay = (
  snapshots: ReadonlyArray<SnapshotRecord>,
  minutes: ReplayWindowMinutes,
  generatedAt: number
): ReplayResponse | null => {
  const advancing: Array<SnapshotRecord> = []
  for (const snapshot of snapshots) {
    const previous = advancing.at(-1)
    if (previous === undefined || snapshot.sourceUpdatedAt > previous.sourceUpdatedAt) {
      advancing.push(snapshot)
    }
  }

  const first = advancing[0]
  const last = advancing.at(-1)
  if (first === undefined || last === undefined) {
    return null
  }

  const frames = advancing.slice(1).map((snapshot, index) =>
    deriveLiveUpdate(advancing[index] ?? first, snapshot)
  )

  return deriveReplayFromUpdates(first, frames, minutes, generatedAt)
}

import {
  ReplayBaseline,
  ReplayResponse,
  ReplayWindowMinutes,
  SnapshotRecord
} from "./domain"
import { deriveLiveUpdate } from "./live-update"

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

  return ReplayResponse.make({
    v: 1,
    minutes,
    generatedAt,
    from: first.observedAt,
    to: last.observedAt,
    baseline: ReplayBaseline.make({
      observedAt: first.observedAt,
      sourceUpdatedAt: first.sourceUpdatedAt,
      stations: first.snapshot.s
    }),
    frames
  })
}

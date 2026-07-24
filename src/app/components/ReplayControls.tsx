import { RangeSlider, Slider } from "@mantine/core"
import {
  IconArrowsDiff,
  IconFlame,
  IconHistory,
  IconMap,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconShare3,
  IconTimeline,
  IconWifi,
} from "@tabler/icons-react"
import { useEffect, useMemo, useState } from "react"
import {
  ARCHIVE_SCALE_MAX,
  archiveScaleLandmarks,
  archiveScalePosition,
  archiveTimestampAtScale,
  clampTimelineAt,
  defaultComparison,
} from "../archive"
import type {
  DataMode,
  MapMode,
  PlaybackSpeed,
  TimelineMode,
} from "../types"
import {
  formatArchiveClock,
  formatArchiveDate,
  formatArchiveDistance,
  formatArchiveDuration,
  formatArchiveTimestamp,
} from "../utils"

interface ReplayControlsProps {
  readonly mode: DataMode
  readonly mapMode: MapMode
  readonly timelineMode: TimelineMode
  readonly speed: PlaybackSpeed
  readonly frameCount: number
  readonly latestAt: number | null
  readonly selectedAt: number | null
  readonly comparison: readonly [number, number] | null
  readonly compact: boolean
  readonly playing: boolean
  readonly loading: boolean
  readonly playbackLoading: boolean
  readonly shareConfirmed: boolean
  readonly onModeChange: (mode: DataMode) => void
  readonly onMapModeChange: (mode: MapMode) => void
  readonly onTimelineModeChange: (mode: TimelineMode) => void
  readonly onSelectedAtChange: (timestamp: number) => void
  readonly onComparisonChange: (value: readonly [number, number]) => void
  readonly onSpeedChange: (speed: PlaybackSpeed) => void
  readonly onPlayingChange: (playing: boolean) => void
  readonly onShare: () => void
}

const speeds: readonly PlaybackSpeed[] = [1, 2, 4]
const sevenDayRange = "7d" as const

export const ReplayControls = ({
  mode,
  mapMode,
  timelineMode,
  speed,
  frameCount,
  latestAt,
  selectedAt,
  comparison,
  compact,
  playing,
  loading,
  playbackLoading,
  shareConfirmed,
  onModeChange,
  onMapModeChange,
  onTimelineModeChange,
  onSelectedAtChange,
  onComparisonChange,
  onSpeedChange,
  onPlayingChange,
  onShare,
}: ReplayControlsProps) => {
  const committedAt = latestAt === null
    ? 0
    : clampTimelineAt(selectedAt ?? latestAt, latestAt, sevenDayRange)
  const committedComparison = latestAt === null
    ? [0, 0] as const
    : comparison ?? defaultComparison(committedAt, latestAt, sevenDayRange)
  const committedPosition = latestAt === null ? 0 : archiveScalePosition(committedAt, latestAt)
  const committedComparisonPositions = latestAt === null
    ? [0, 0] as const
    : [
      archiveScalePosition(committedComparison[0], latestAt),
      archiveScalePosition(committedComparison[1], latestAt),
    ] as const
  const [draftPosition, setDraftPosition] = useState(committedPosition)
  const [draftComparisonPositions, setDraftComparisonPositions] = useState<[number, number]>([
    committedComparisonPositions[0],
    committedComparisonPositions[1],
  ])

  useEffect(() => {
    setDraftPosition(committedPosition)
  }, [committedPosition])

  useEffect(() => {
    setDraftComparisonPositions([
      committedComparisonPositions[0],
      committedComparisonPositions[1],
    ])
  }, [committedComparisonPositions[0], committedComparisonPositions[1]])

  const landmarks = useMemo(
    () => latestAt === null ? [] : archiveScaleLandmarks(latestAt),
    [latestAt],
  )
  const disabled = loading || latestAt === null
  const draftAt = latestAt === null ? 0 : archiveTimestampAtScale(draftPosition, latestAt)
  const draftComparison = latestAt === null
    ? [0, 0] as const
    : [
      archiveTimestampAtScale(draftComparisonPositions[0], latestAt),
      archiveTimestampAtScale(draftComparisonPositions[1], latestAt),
    ] as const
  const minimumComparisonRange = latestAt === null
    ? 1
    : ARCHIVE_SCALE_MAX - archiveScalePosition(latestAt - 60_000, latestAt)
  const formatScaleValue = (position: number) => latestAt === null
    ? ""
    : formatArchiveTimestamp(archiveTimestampAtScale(position, latestAt))

  const liveToolbar = mode === "live" && (
    <div className="replay-toolbar">
      <button
        className="replay-mode-button"
        onClick={() => onModeChange("replay")}
        type="button"
      >
        <IconHistory size={18} />
        Archives
      </button>
      <button
        aria-label={mapMode === "stations" ? "Afficher les variations" : "Afficher les stations"}
        aria-pressed={mapMode === "heatmap"}
        className="replay-tool-button"
        onClick={() => onMapModeChange(mapMode === "stations" ? "heatmap" : "stations")}
        title={mapMode === "stations" ? "Afficher les zones de variation" : "Afficher les stations"}
        type="button"
      >
        {mapMode === "stations" ? <IconFlame size={18} /> : <IconMap size={18} />}
        <span>{mapMode === "stations" ? "Variations" : "Stations"}</span>
      </button>
      <button
        aria-label={shareConfirmed ? "Lien copié" : "Partager cette vue"}
        className="replay-tool-button replay-share-button"
        onClick={onShare}
        title="Partager cette vue"
        type="button"
      >
        <IconShare3 size={18} />
        <span>{shareConfirmed ? "Lien copié" : "Partager"}</span>
      </button>
    </div>
  )

  return (
    <section
      aria-busy={mode === "replay" && (loading || playbackLoading)}
      aria-label="Outils temporels de la carte"
      className="replay-controls"
      data-mode={mode}
    >
      {liveToolbar}

      {mode === "replay" && latestAt !== null && (
        <div
          className="replay-deck"
          data-compact={compact || undefined}
          data-loading={loading || undefined}
        >
          <header className="archive-primary-head">
            <div className="archive-title">
              <IconHistory aria-hidden="true" size={22} />
              <span>
                <strong>Historique du réseau</strong>
                <small>7 jours · minutes détaillées, jours condensés</small>
              </span>
            </div>

            {!compact && (
              <div className="archive-mode-group" aria-label="Mode des archives" role="group">
                <button
                  aria-pressed={timelineMode === "explore"}
                  data-active={timelineMode === "explore" || undefined}
                  onClick={() => onTimelineModeChange("explore")}
                  type="button"
                >
                  <IconTimeline size={17} /> Parcourir
                </button>
                <button
                  aria-pressed={timelineMode === "compare"}
                  data-active={timelineMode === "compare" || undefined}
                  onClick={() => onTimelineModeChange("compare")}
                  type="button"
                >
                  <IconArrowsDiff size={17} /> Comparer
                </button>
              </div>
            )}

            <div className="archive-head-actions">
              <button onClick={() => onModeChange("live")} type="button">
                <IconWifi size={17} /> Direct
              </button>
              <button
                aria-label={shareConfirmed ? "Lien copié" : "Partager cette vue"}
                onClick={onShare}
                title="Partager cette vue"
                type="button"
              >
                <IconShare3 size={17} />
                <span>{shareConfirmed ? "Copié" : "Partager"}</span>
              </button>
            </div>
          </header>

          <div
            aria-label={compact ? "Contexte temporel de la station" : undefined}
            className="archive-selection-summary"
            data-mode={timelineMode}
          >
            {timelineMode === "explore" ? (
              <time dateTime={new Date(draftAt).toISOString()}>
                <span>Instant affiché</span>
                <strong>{formatArchiveClock(draftAt)}</strong>
                <small>{formatArchiveDate(draftAt)} · {formatArchiveDistance(draftAt, latestAt)}</small>
              </time>
            ) : (
              <>
                <time data-endpoint="before" dateTime={new Date(draftComparison[0]).toISOString()}>
                  <span>Avant</span>
                  <strong>{formatArchiveClock(draftComparison[0])}</strong>
                  <small>{formatArchiveDate(draftComparison[0])}</small>
                </time>
                <div className="archive-comparison-duration">
                  <span>Intervalle</span>
                  <strong>{formatArchiveDuration(draftComparison[0], draftComparison[1])}</strong>
                </div>
                <time data-endpoint="after" dateTime={new Date(draftComparison[1]).toISOString()}>
                  <span>Après</span>
                  <strong>{formatArchiveClock(draftComparison[1])}</strong>
                  <small>{formatArchiveDate(draftComparison[1])}</small>
                </time>
              </>
            )}
          </div>

          {!compact && (
            <div className="archive-scale" data-mode={timelineMode}>
              <div className="archive-scale-rail">
                {timelineMode === "explore" ? (
                  <Slider
                    className="archive-slider"
                    disabled={disabled}
                    label={formatScaleValue}
                    max={ARCHIVE_SCALE_MAX}
                    min={0}
                    onChange={setDraftPosition}
                    onChangeEnd={(position) => onSelectedAtChange(archiveTimestampAtScale(position, latestAt))}
                    step={1}
                    thumbLabel="Instant affiché sur la carte"
                    thumbValueText={formatScaleValue}
                    value={draftPosition}
                  />
                ) : (
                  <RangeSlider
                    className="archive-slider archive-range-slider"
                    disabled={disabled}
                    label={formatScaleValue}
                    max={ARCHIVE_SCALE_MAX}
                    min={0}
                    minRange={minimumComparisonRange}
                    onChange={setDraftComparisonPositions}
                    onChangeEnd={(positions) => onComparisonChange([
                      archiveTimestampAtScale(positions[0], latestAt),
                      archiveTimestampAtScale(positions[1], latestAt),
                    ])}
                    step={1}
                    thumbFromLabel="Instant avant"
                    thumbToLabel="Instant après"
                    thumbValueText={formatScaleValue}
                    value={draftComparisonPositions}
                  />
                )}
                <div className="archive-scale-landmarks" aria-hidden="true">
                  {landmarks.map((landmark) => (
                    <span
                      data-edge={landmark.position === 0
                        ? "start"
                        : landmark.position === ARCHIVE_SCALE_MAX ? "end" : undefined}
                      key={landmark.label}
                      style={{ left: `${landmark.position / 100}%` }}
                    >
                      {landmark.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          <footer className="archive-primary-foot">
            {timelineMode === "explore" ? (
              <>
                <button
                  aria-label={playbackLoading
                    ? "Annuler la préparation de la relecture"
                    : playing ? "Mettre la relecture en pause" : "Lire l’heure précédant cet instant"}
                  className="replay-play-button"
                  disabled={disabled || frameCount === 0}
                  onClick={() => onPlayingChange(!playing)}
                  type="button"
                >
                  {playing ? <IconPlayerPauseFilled size={17} /> : <IconPlayerPlayFilled size={17} />}
                </button>
                <span className="archive-playback-label">
                  {playbackLoading ? "Préparation de la relecture…" : "Rejouer l’heure précédant cet instant"}
                </span>
                <div className="replay-speed-group" aria-label="Vitesse de lecture" role="group">
                  {speeds.map((value) => (
                    <button
                      aria-pressed={speed === value}
                      data-active={speed === value || undefined}
                      key={value}
                      onClick={() => onSpeedChange(value)}
                      type="button"
                    >
                      {value}×
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <span className="archive-delta-key"><i data-tone="gain" /> Gain de vélos</span>
                <span className="archive-delta-key"><i data-tone="loss" /> Perte de vélos</span>
                <small>La carte montre automatiquement la variation entre Avant et Après.</small>
              </>
            )}
          </footer>

          {loading && <span className="archive-loading" role="status">Actualisation…</span>}
        </div>
      )}
    </section>
  )
}

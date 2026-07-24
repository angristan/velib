import { RangeSlider, Slider } from "@mantine/core"
import {
  IconArrowRight,
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
  clampTimelineAt,
  defaultComparison,
  timelineBounds,
  timelineRanges,
  timelineTicks,
} from "../archive"
import type {
  DataMode,
  MapMode,
  PlaybackSpeed,
  TimelineMode,
  TimelineRange,
} from "../types"
import {
  formatArchiveClock,
  formatArchiveDate,
  formatArchiveDistance,
  formatArchiveDuration,
  formatArchiveTick,
  formatArchiveTimestamp,
} from "../utils"

interface ReplayControlsProps {
  readonly mode: DataMode
  readonly mapMode: MapMode
  readonly timelineMode: TimelineMode
  readonly timelineRange: TimelineRange
  readonly speed: PlaybackSpeed
  readonly frameCount: number
  readonly latestAt: number | null
  readonly selectedAt: number | null
  readonly comparison: readonly [number, number] | null
  readonly compact: boolean
  readonly playing: boolean
  readonly loading: boolean
  readonly shareConfirmed: boolean
  readonly onModeChange: (mode: DataMode) => void
  readonly onMapModeChange: (mode: MapMode) => void
  readonly onTimelineModeChange: (mode: TimelineMode) => void
  readonly onTimelineRangeChange: (range: TimelineRange) => void
  readonly onSelectedAtChange: (timestamp: number) => void
  readonly onComparisonChange: (value: readonly [number, number]) => void
  readonly onSpeedChange: (speed: PlaybackSpeed) => void
  readonly onPlayingChange: (playing: boolean) => void
  readonly onShare: () => void
}

const speeds: readonly PlaybackSpeed[] = [1, 2, 4]

export const ReplayControls = ({
  mode,
  mapMode,
  timelineMode,
  timelineRange,
  speed,
  frameCount,
  latestAt,
  selectedAt,
  comparison,
  compact,
  playing,
  loading,
  shareConfirmed,
  onModeChange,
  onMapModeChange,
  onTimelineModeChange,
  onTimelineRangeChange,
  onSelectedAtChange,
  onComparisonChange,
  onSpeedChange,
  onPlayingChange,
  onShare,
}: ReplayControlsProps) => {
  const bounds = useMemo(
    () => latestAt === null ? null : timelineBounds(latestAt, timelineRange),
    [latestAt, timelineRange],
  )
  const committedAt = bounds === null
    ? 0
    : clampTimelineAt(selectedAt ?? bounds.max, bounds.max, timelineRange)
  const committedComparison = bounds === null
    ? [0, 0] as const
    : comparison ?? defaultComparison(committedAt, bounds.max, timelineRange)
  const [draftAt, setDraftAt] = useState(committedAt)
  const [draftComparison, setDraftComparison] = useState<[number, number]>([
    committedComparison[0],
    committedComparison[1],
  ])

  useEffect(() => {
    setDraftAt(committedAt)
  }, [committedAt])

  useEffect(() => {
    setDraftComparison([committedComparison[0], committedComparison[1]])
  }, [committedComparison[0], committedComparison[1]])

  const disabled = loading || bounds === null
  const formatValue = (value: number) => formatArchiveTimestamp(value)
  const ticks = bounds === null ? [] : timelineTicks(bounds.min, bounds.max)
  const tickIncludesDay = timelineRange === "7d"
  const variationLabel = mapMode === "stations"
    ? timelineMode === "compare" && mode === "replay" ? "Delta" : "Variations"
    : "Stations"

  return (
    <section
      aria-busy={mode === "replay" && loading}
      aria-label="Outils temporels de la carte"
      className="replay-controls"
      data-mode={mode}
    >
      <div className="replay-toolbar">
        <button
          aria-pressed={mode === "replay"}
          className="replay-mode-button"
          onClick={() => onModeChange(mode === "live" ? "replay" : "live")}
          type="button"
        >
          {mode === "live" ? <IconHistory size={17} /> : <IconWifi size={17} />}
          {mode === "live" ? "Archives" : "Revenir au direct"}
        </button>
        <button
          aria-label={mapMode === "stations" ? variationLabel : "Afficher les stations"}
          aria-pressed={mapMode === "heatmap"}
          className="replay-tool-button"
          onClick={() => onMapModeChange(mapMode === "stations" ? "heatmap" : "stations")}
          title={mapMode === "stations" ? "Afficher les zones de variation" : "Afficher les stations"}
          type="button"
        >
          {mapMode === "stations" ? <IconFlame size={17} /> : <IconMap size={17} />}
          <span>{variationLabel}</span>
        </button>
        <button
          aria-label={shareConfirmed ? "Lien copié" : "Partager cette vue"}
          className="replay-tool-button replay-share-button"
          onClick={onShare}
          title="Partager cette vue"
          type="button"
        >
          <IconShare3 size={17} />
          <span>{shareConfirmed ? "Lien copié" : "Partager"}</span>
        </button>
      </div>

      {mode === "replay" && bounds !== null && (
        <div
          className="replay-deck"
          data-compact={compact || undefined}
          data-loading={loading || undefined}
        >
          <header className="archive-strip-head">
            <div className="archive-wordmark">
              <IconHistory size={16} />
              <span><b>Archives</b><small>Vélib’ Métropole</small></span>
            </div>

            {!compact && (
              <>
                <div className="archive-mode-group" aria-label="Mode des archives" role="group">
                  <button
                    aria-pressed={timelineMode === "explore"}
                    data-active={timelineMode === "explore" || undefined}
                    onClick={() => onTimelineModeChange("explore")}
                    type="button"
                  >
                    <IconTimeline size={14} /> Explorer
                  </button>
                  <button
                    aria-pressed={timelineMode === "compare"}
                    data-active={timelineMode === "compare" || undefined}
                    onClick={() => onTimelineModeChange("compare")}
                    type="button"
                  >
                    <IconArrowsDiff size={14} /> Comparer
                  </button>
                </div>
                <div className="replay-window-group" aria-label="Échelle de la chronologie" role="group">
                  {timelineRanges.map((option) => (
                    <button
                      aria-pressed={timelineRange === option.value}
                      data-active={timelineRange === option.value || undefined}
                      key={option.value}
                      onClick={() => onTimelineRangeChange(option.value)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </header>

          {compact ? (
            <div className="archive-compact-summary" aria-label="Contexte temporel de la station">
              {timelineMode === "compare" ? (
                <>
                  <span><b>A</b>{formatArchiveClock(draftComparison[0])}</span>
                  <IconArrowRight aria-hidden="true" size={16} />
                  <span><b>B</b>{formatArchiveClock(draftComparison[1])}</span>
                  <small>{formatArchiveDuration(draftComparison[0], draftComparison[1])}</small>
                </>
              ) : (
                <>
                  <span><b>B</b>{formatArchiveClock(draftAt)}</span>
                  <small>{formatArchiveDate(draftAt)}</small>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="archive-rail-meta">
                {timelineMode === "explore" ? (
                  <time dateTime={new Date(draftAt).toISOString()}>
                    <span>B</span>
                    <strong>{formatArchiveClock(draftAt)}</strong>
                    <small>{formatArchiveDate(draftAt)} · {formatArchiveDistance(draftAt, bounds.max)}</small>
                  </time>
                ) : (
                  <>
                    <time dateTime={new Date(draftComparison[0]).toISOString()}>
                      <span>A</span><strong>{formatArchiveClock(draftComparison[0])}</strong>
                      <small>{formatArchiveDate(draftComparison[0])}</small>
                    </time>
                    <div className="archive-interval">
                      <i aria-hidden="true" />
                      <span>{formatArchiveDuration(draftComparison[0], draftComparison[1])}</span>
                      <i aria-hidden="true" />
                    </div>
                    <time dateTime={new Date(draftComparison[1]).toISOString()}>
                      <span>B</span><strong>{formatArchiveClock(draftComparison[1])}</strong>
                      <small>{formatArchiveDate(draftComparison[1])}</small>
                    </time>
                  </>
                )}
              </div>

              <div className="archive-transit-rail" data-mode={timelineMode}>
                {timelineMode === "explore" ? (
                  <Slider
                    className="archive-slider"
                    disabled={disabled}
                    label={formatValue}
                    max={bounds.max}
                    min={bounds.min}
                    onChange={setDraftAt}
                    onChangeEnd={onSelectedAtChange}
                    step={bounds.step}
                    thumbChildren={<span>B</span>}
                    thumbLabel="Instant affiché sur la carte"
                    thumbValueText={formatValue}
                    value={draftAt}
                  />
                ) : (
                  <RangeSlider
                    className="archive-slider archive-range-slider"
                    disabled={disabled}
                    label={formatValue}
                    max={bounds.max}
                    min={bounds.min}
                    minRange={bounds.step}
                    onChange={setDraftComparison}
                    onChangeEnd={(value) => onComparisonChange(value)}
                    step={bounds.step}
                    thumbChildren={[<span key="a">A</span>, <span key="b">B</span>]}
                    thumbFromLabel="Instant de départ A"
                    thumbToLabel="Instant d’arrivée B"
                    thumbValueText={formatValue}
                    value={draftComparison}
                  />
                )}
                <div className="archive-ticks" aria-hidden="true">
                  {ticks.map((tick, index) => (
                    <span key={tick}>
                      {index === ticks.length - 1
                        ? "Maintenant"
                        : formatArchiveTick(tick, tickIncludesDay)}
                    </span>
                  ))}
                </div>
              </div>

              <footer className="archive-strip-foot">
                {timelineMode === "explore" ? (
                  <>
                    <button
                      aria-label={playing ? "Mettre la relecture en pause" : "Lire l’heure précédant cet instant"}
                      className="replay-play-button"
                      disabled={disabled || frameCount === 0}
                      onClick={() => onPlayingChange(!playing)}
                      type="button"
                    >
                      {playing ? <IconPlayerPauseFilled size={15} /> : <IconPlayerPlayFilled size={15} />}
                    </button>
                    <span className="archive-playback-label">Rejouer l’heure avant B</span>
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
                    <span className="archive-delta-key"><i data-tone="gain" /> Gain</span>
                    <span className="archive-delta-key"><i data-tone="loss" /> Perte</span>
                    <small>Variation nette entre A et B</small>
                  </>
                )}
              </footer>

              {loading && <span className="archive-loading" role="status">Actualisation…</span>}
            </>
          )}
        </div>
      )}
    </section>
  )
}

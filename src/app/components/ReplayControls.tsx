import { Menu } from "@mantine/core"
import {
  IconFlame,
  IconHistory,
  IconLayersLinked,
  IconMap,
  IconMoonStars,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconShare3,
  IconSun,
  IconWifi,
} from "@tabler/icons-react"
import type {
  DataMode,
  MapBackground,
  MapMode,
  PlaybackSpeed,
  ReplayWindowMinutes,
} from "../types"
import { formatTimestamp } from "../utils"

interface ReplayControlsProps {
  readonly mode: DataMode
  readonly mapMode: MapMode
  readonly mapBackground: MapBackground
  readonly minutes: ReplayWindowMinutes
  readonly speed: PlaybackSpeed
  readonly cursor: number
  readonly frameCount: number
  readonly timestamp: number | null
  readonly playing: boolean
  readonly loading: boolean
  readonly shareConfirmed: boolean
  readonly onModeChange: (mode: DataMode) => void
  readonly onMapModeChange: (mode: MapMode) => void
  readonly onMapBackgroundChange: (background: MapBackground) => void
  readonly onMinutesChange: (minutes: ReplayWindowMinutes) => void
  readonly onSpeedChange: (speed: PlaybackSpeed) => void
  readonly onCursorChange: (cursor: number) => void
  readonly onPlayingChange: (playing: boolean) => void
  readonly onShare: () => void
}

const windows: readonly ReplayWindowMinutes[] = [15, 30, 60]
const speeds: readonly PlaybackSpeed[] = [1, 2, 4]

export const ReplayControls = ({
  mode,
  mapMode,
  mapBackground,
  minutes,
  speed,
  cursor,
  frameCount,
  timestamp,
  playing,
  loading,
  shareConfirmed,
  onModeChange,
  onMapModeChange,
  onMapBackgroundChange,
  onMinutesChange,
  onSpeedChange,
  onCursorChange,
  onPlayingChange,
  onShare,
}: ReplayControlsProps) => (
  <section
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
        {mode === "live" ? "Relecture" : "Revenir au direct"}
      </button>
      <button
        aria-pressed={mapMode === "heatmap"}
        className="replay-tool-button"
        onClick={() => onMapModeChange(mapMode === "stations" ? "heatmap" : "stations")}
        title={mapMode === "stations" ? "Afficher les zones de variation" : "Afficher les stations"}
        type="button"
      >
        {mapMode === "stations" ? <IconFlame size={17} /> : <IconMap size={17} />}
        <span>{mapMode === "stations" ? "Variations" : "Stations"}</span>
      </button>
      <Menu position="bottom-end" shadow="md" width={178}>
        <Menu.Target>
          <button
            aria-label="Choisir le fond de carte"
            className="replay-tool-button"
            type="button"
          >
            <IconLayersLinked size={17} />
            <span>Fond</span>
          </button>
        </Menu.Target>
        <Menu.Dropdown className="map-style-menu">
          <Menu.Label>Fond de carte</Menu.Label>
          <Menu.Item
            data-active={mapBackground === "light" || undefined}
            leftSection={<IconSun size={16} />}
            onClick={() => onMapBackgroundChange("light")}
          >
            Plan clair
          </Menu.Item>
          <Menu.Item
            data-active={mapBackground === "dark" || undefined}
            leftSection={<IconMoonStars size={16} />}
            onClick={() => onMapBackgroundChange("dark")}
          >
            Plan sombre
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <button
        className="replay-tool-button replay-share-button"
        onClick={onShare}
        title="Partager cette vue"
        type="button"
      >
        <IconShare3 size={17} />
        <span>{shareConfirmed ? "Lien copié" : "Partager"}</span>
      </button>
    </div>

    {mode === "replay" && (
      <div className="replay-deck">
        <div className="replay-window-group" aria-label="Durée de la relecture" role="group">
          {windows.map((window) => (
            <button
              aria-pressed={minutes === window}
              data-active={minutes === window || undefined}
              key={window}
              onClick={() => onMinutesChange(window)}
              type="button"
            >
              {window} min
            </button>
          ))}
        </div>

        <button
          aria-label={playing ? "Mettre la relecture en pause" : "Lire la relecture"}
          className="replay-play-button"
          disabled={loading || frameCount === 0}
          onClick={() => onPlayingChange(!playing)}
          type="button"
        >
          {playing ? <IconPlayerPauseFilled size={16} /> : <IconPlayerPlayFilled size={16} />}
        </button>

        <input
          aria-label="Position dans la relecture"
          aria-valuetext={timestamp ? formatTimestamp(timestamp) : "Indisponible"}
          className="replay-slider"
          disabled={loading || frameCount === 0}
          max={frameCount}
          min={0}
          onChange={(event) => onCursorChange(Number(event.currentTarget.value))}
          step={1}
          type="range"
          value={Math.min(cursor, frameCount)}
        />

        <time className="replay-time" dateTime={timestamp ? new Date(timestamp).toISOString() : undefined}>
          {loading ? "Chargement…" : timestamp ? formatTimestamp(timestamp) : "Aucune donnée"}
        </time>

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
      </div>
    )}
  </section>
)

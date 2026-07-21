import { Group, Text } from "@mantine/core"
import {
  IconCloudOff,
  IconHistory,
  IconMapPinFilled,
} from "@tabler/icons-react"
import { memo, useEffect, useState } from "react"
import type {
  DataMode,
  LiveConnectionStatus,
  MapMode,
} from "../types"
import { formatFreshnessCompact, formatTimestamp } from "../utils"

type StatusTone = "live" | "stale" | "replay" | "waiting"

interface MapDataStatusProps {
  readonly activityCount: number
  readonly connection: LiveConnectionStatus
  readonly error: string | null
  readonly mapMode: MapMode
  readonly mode: DataMode
  readonly sourceUpdatedAt: number | null
  readonly stationCount: number
}

interface StatusPresentation {
  readonly icon: React.ReactNode
  readonly label: string
  readonly tone: StatusTone
}

const presentationFor = (
  sourceUpdatedAt: number | null,
  now: number,
  error: string | null,
  connection: LiveConnectionStatus,
  mode: DataMode,
): StatusPresentation => {
  if (sourceUpdatedAt === null) {
    return {
      icon: <IconCloudOff size={13} />,
      label: "En attente",
      tone: "waiting",
    }
  }

  if (mode === "replay") {
    return {
      icon: <IconHistory size={13} />,
      label: `Relecture · ${formatTimestamp(sourceUpdatedAt)}`,
      tone: "replay",
    }
  }

  const isCurrent = now - sourceUpdatedAt < 3 * 60_000 && error === null
  if (isCurrent && connection === "live") {
    return {
      icon: <span className="map-data-status__dot" />,
      label: `À jour · ${formatFreshnessCompact(sourceUpdatedAt, now)}`,
      tone: "live",
    }
  }

  const connectionLabel = connection === "reconnecting" ? "Reconnexion" : "Connexion"
  return {
    icon: <IconCloudOff size={13} />,
    label: `${isCurrent ? connectionLabel : "Archive"} · ${formatFreshnessCompact(sourceUpdatedAt, now)}`,
    tone: "stale",
  }
}

export const MapDataStatus = memo(function MapDataStatus({
  activityCount,
  connection,
  error,
  mapMode,
  mode,
  sourceUpdatedAt,
  stationCount,
}: MapDataStatusProps) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(interval)
  }, [])

  const status = presentationFor(sourceUpdatedAt, now, error, connection, mode)
  const mapTitle = mapMode === "heatmap" ? "Variations de disponibilité" : "Stations Vélib’"
  const mapSummary = mapMode === "heatmap"
    ? `${activityCount} stations avec variation`
    : `${stationCount} affichées`

  return (
    <>
      <div className="map-caption">
        <Group gap={10} wrap="nowrap">
          <IconMapPinFilled size={22} />
          <div>
            <Text className="map-caption__title" fw={800}>{mapTitle}</Text>
            <div className="map-caption__meta">
              <span className="map-caption__status" data-tone={status.tone}>
                {status.icon}
                {status.label}
              </span>
              <span aria-hidden="true">·</span>
              <span>{mapSummary}</span>
            </div>
          </div>
        </Group>
      </div>
      <div
        aria-label={`État des données : ${status.label}`}
        className="map-data-status"
        data-tone={status.tone}
      >
        {status.icon}
        <span>{status.label}</span>
      </div>
    </>
  )
})

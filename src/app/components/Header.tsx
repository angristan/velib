import {
  ActionIcon,
  Badge,
  Group,
  Skeleton,
  Text,
  Tooltip,
} from "@mantine/core"
import {
  IconBike,
  IconBolt,
  IconCloudOff,
  IconHistory,
  IconParking,
  IconRefresh,
} from "@tabler/icons-react"
import { memo, useEffect, useRef, useState } from "react"
import type { DataMode, LiveConnectionStatus, LiveData } from "../types"
import { formatFreshness, formatNumber, formatTimestamp } from "../utils"

interface HeaderProps {
  readonly data: LiveData | null
  readonly loading: boolean
  readonly error: string | null
  readonly connection: LiveConnectionStatus
  readonly mode: DataMode
  readonly onRefresh: () => void
}

interface KpiProps {
  readonly icon: React.ReactNode
  readonly label: string
  readonly value: number
  readonly tone: "green" | "blue" | "navy"
  readonly pulse: boolean
}

const Kpi = ({ icon, label, value, tone, pulse }: KpiProps) => (
  <div className={`network-kpi network-kpi--${tone}`}>
    <span className="network-kpi__icon" aria-hidden="true">{icon}</span>
    <span>
      <strong className={pulse ? "network-kpi__value--pulse" : undefined} key={value}>
        {formatNumber(value)}
      </strong>
      <small>{label}</small>
    </span>
  </div>
)

export const Header = memo(function Header({
  data,
  loading,
  error,
  connection,
  mode,
  onRefresh,
}: HeaderProps) {
  const totals = (data?.stations ?? []).reduce(
    (current, station) => ({
      mechanical: current.mechanical + station.mechanical,
      electric: current.electric + station.electric,
      docks: current.docks + station.docks,
    }),
    { mechanical: 0, electric: 0, docks: 0 },
  )
  const previousTotalsRef = useRef<typeof totals | null>(null)
  const previousTotals = previousTotalsRef.current
  useEffect(() => {
    previousTotalsRef.current = totals
  }, [totals.mechanical, totals.electric, totals.docks])

  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(interval)
  }, [])

  const isCurrent = Boolean(data && now - data.sourceUpdatedAt < 3 * 60_000 && !error)
  const isLive = mode === "live" && isCurrent && connection === "live"
  const disconnectedLabel = connection === "reconnecting" ? "Reconnexion" : "Connexion"
  let statusClass = "stale-badge"
  let statusIcon: React.ReactNode = <IconCloudOff size={13} />
  let statusLabel = data
    ? `${isCurrent ? disconnectedLabel : "Archive"} · ${formatFreshness(data.sourceUpdatedAt)}`
    : "En attente"
  if (data && mode === "replay") {
    statusClass = "replay-badge"
    statusIcon = <IconHistory size={13} />
    statusLabel = `Relecture · ${formatTimestamp(data.sourceUpdatedAt)}`
  } else if (data && isLive) {
    statusClass = "live-badge"
    statusIcon = <span className="live-dot" />
    statusLabel = `Actualisé ${formatFreshness(data.sourceUpdatedAt)}`
  }

  return (
    <header className="app-header">
      <div className="brand-lockup" aria-label="Vélib’ Pulse">
        <div className="brand-mark" aria-hidden="true"><IconBike size={25} stroke={2.4} /></div>
        <div>
          <Text className="brand-name">Vélib’ <em>Pulse</em></Text>
          <Text className="brand-tagline">Observatoire du réseau</Text>
        </div>
      </div>

      <div className="network-kpis" aria-label="Disponibilité sur le réseau">
        {loading && !data ? (
          <>
            <Skeleton className="kpi-skeleton" radius="md" />
            <Skeleton className="kpi-skeleton" radius="md" />
            <Skeleton className="kpi-skeleton" radius="md" />
          </>
        ) : (
          <>
            <Kpi
              icon={<IconBike size={21} />}
              label="Vélos mécaniques"
              pulse={previousTotals !== null && previousTotals.mechanical !== totals.mechanical}
              tone="green"
              value={totals.mechanical}
            />
            <Kpi
              icon={<IconBolt size={21} />}
              label="Vélos électriques"
              pulse={previousTotals !== null && previousTotals.electric !== totals.electric}
              tone="blue"
              value={totals.electric}
            />
            <Kpi
              icon={<IconParking size={21} />}
              label="Places libres"
              pulse={false}
              tone="navy"
              value={totals.docks}
            />
          </>
        )}
      </div>

      <Group gap="sm" className="header-status" wrap="nowrap">
        {data ? (
          <Badge
            className={statusClass}
            leftSection={statusIcon}
            size="lg"
            variant="light"
          >
            {statusLabel}
          </Badge>
        ) : (
          <Badge variant="light" color="gray" size="lg">En attente</Badge>
        )}
        <Tooltip label="Actualiser les données">
          <ActionIcon
            aria-label="Actualiser les données"
            className="refresh-button"
            loading={loading}
            onClick={onRefresh}
            size="lg"
            variant="subtle"
          >
            <IconRefresh size={19} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </header>
  )
})

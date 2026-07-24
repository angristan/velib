import {
  ActionIcon,
  Badge,
  Button,
  Drawer,
  Group,
  Progress,
  Skeleton,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core"
import { useMediaQuery } from "@mantine/hooks"
import { lazy, Suspense, useEffect, useRef } from "react"
import {
  IconArrowsDiff,
  IconBike,
  IconBolt,
  IconExternalLink,
  IconMapPin,
  IconParking,
  IconParkingOff,
  IconX,
} from "@tabler/icons-react"
import type {
  HistoryRange,
  LiveStationChange,
  Station,
  StationComparison,
  StationHistory,
  StationTrend,
} from "../types"
import { stationBikes, stationIsOperative } from "../types"
import {
  distanceInMeters,
  formatArchiveDuration,
  formatArchiveTimestamp,
  formatDistance,
  formatNumber,
} from "../utils"
const HistoryChart = lazy(() =>
  import("./HistoryChart").then((module) => ({ default: module.HistoryChart })),
)

interface StationDetailsProps {
  readonly station: Station | null
  readonly comparison: StationComparison | null
  readonly nearby: readonly Station[]
  readonly history: StationHistory | null
  readonly historyLoading: boolean
  readonly historyError: string | null
  readonly historyEnabled: boolean
  readonly variation: LiveStationChange | null
  readonly variationLabel: string
  readonly trend: StationTrend
  readonly range: HistoryRange
  readonly onRangeChange: (range: HistoryRange) => void
  readonly onClose: () => void
  readonly onMobileCloseFocus: () => void
  readonly onSelect: (station: Station) => void
}

const MetricTile = ({
  icon,
  value,
  label,
  tone,
}: {
  readonly icon: React.ReactNode
  readonly value: number
  readonly label: string
  readonly tone: string
}) => (
  <div className={`detail-metric detail-metric--${tone}`}>
    <span>{icon}</span>
    <b>{formatNumber(value)}</b>
    <small title={label}>{label}</small>
  </div>
)

const sparklinePoints = (points: readonly number[]): string => {
  if (points.length === 0) return ""
  const minimum = Math.min(...points)
  const maximum = Math.max(...points)
  const span = Math.max(1, maximum - minimum)
  return points.map((point, index) => {
    const x = points.length === 1 ? 90 : (index / (points.length - 1)) * 180
    const y = 30 - ((point - minimum) / span) * 24
    return `${x},${y}`
  }).join(" ")
}

const DetailContent = ({
  station,
  comparison,
  nearby,
  history,
  historyLoading,
  historyError,
  historyEnabled,
  variation,
  variationLabel,
  trend,
  range,
  onRangeChange,
  onSelect,
}: Omit<StationDetailsProps, "station" | "onClose" | "onMobileCloseFocus"> & { readonly station: Station }) => {
  const bikes = stationBikes(station)
  const capacityScale = Math.max(
    1,
    station.capacity,
    bikes + station.docks + station.unavailable,
  )
  const occupiedPercent = (bikes / capacityScale) * 100
  const docksPercent = (station.docks / capacityScale) * 100
  const unavailablePercent = (station.unavailable / capacityScale) * 100
  const operative = stationIsOperative(station)
  const comparisonBikeDelta = comparison === null
    ? 0
    : bikes - stationBikes(comparison.from)
  const directions = `https://www.openstreetmap.org/directions?to=${station.latitude}%2C${station.longitude}`

  return (
    <div className="detail-content">
      <div className="station-hero">
        <Group gap="sm" mb={8}>
          <Badge color={operative ? "green" : "gray"} size="md" variant="light">
            {operative ? "Station ouverte" : "Station indisponible"}
          </Badge>
          <Text className="detail-code">N° {station.code}</Text>
        </Group>
        <Text component="h2" id="station-detail-title" className="detail-title">{station.name}</Text>
        {comparison && (
          <span className="capacity-context">Instant B · {formatArchiveTimestamp(comparison.toAt)}</span>
        )}
        <div className="capacity-summary">
          <div>
            <strong>{bikes}</strong>
            <span>vélos disponibles</span>
          </div>
          <Text>{station.docks} places libres sur {station.capacity}</Text>
        </div>
        <Progress.Root
          aria-label={`${bikes} vélos, ${station.docks} places libres et ${station.unavailable} emplacements indisponibles sur ${station.capacity}`}
          className="capacity-progress"
          radius="xl"
          size="sm"
        >
          <Progress.Section color={operative ? "green.6" : "gray.6"} value={occupiedPercent} />
          <Progress.Section color="gray.4" value={docksPercent} />
          <Progress.Section color="red.6" value={unavailablePercent} />
        </Progress.Root>
        {comparison && (
          <section className="station-comparison" aria-label="Comparaison de disponibilité entre A et B">
            <header className="station-comparison__title">
              <span><IconArrowsDiff size={17} /></span>
              <div>
                <b>Évolution A → B</b>
                <small>{formatArchiveDuration(comparison.fromAt, comparison.toAt)}</small>
              </div>
              <em data-direction={comparisonBikeDelta > 0 ? "up" : comparisonBikeDelta < 0 ? "down" : "neutral"}>
                {comparisonBikeDelta > 0 ? "+" : ""}{comparisonBikeDelta} vélo{Math.abs(comparisonBikeDelta) === 1 ? "" : "s"}
              </em>
            </header>
            <div className="station-comparison__endpoints">
              <span><b>A</b>{formatArchiveTimestamp(comparison.fromAt)}</span>
              <span><b>B</b>{formatArchiveTimestamp(comparison.toAt)}</span>
            </div>
            <table>
              <caption className="sr-only">Valeurs à l’instant A, à l’instant B et différence</caption>
              <thead>
                <tr><th>Mesure</th><th>A</th><th>B</th><th>Δ</th></tr>
              </thead>
              <tbody>
                {[
                  ["Mécaniques", comparison.from.mechanical, station.mechanical],
                  ["Électriques", comparison.from.electric, station.electric],
                  ["Places libres", comparison.from.docks, station.docks],
                ].map(([label, from, to]) => {
                  const delta = Number(to) - Number(from)
                  return (
                    <tr key={String(label)}>
                      <th scope="row">{label}</th>
                      <td>{from}</td>
                      <td>{to}</td>
                      <td data-direction={delta > 0 ? "up" : delta < 0 ? "down" : "neutral"}>
                        {delta > 0 ? "+" : ""}{delta}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        )}
        {!comparison && variation && (
          <div className="live-variation" aria-live="polite">
            <span className="live-variation__label">{variationLabel}</span>
            <div>
              {variation.mechanicalDelta !== 0 && (
                <span data-direction={variation.mechanicalDelta > 0 ? "up" : "down"}>
                  <IconBike size={15} />
                  {variation.mechanicalDelta > 0 ? "+" : ""}{variation.mechanicalDelta}
                </span>
              )}
              {variation.electricDelta !== 0 && (
                <span data-direction={variation.electricDelta > 0 ? "up" : "down"}>
                  <IconBolt size={15} />
                  {variation.electricDelta > 0 ? "+" : ""}{variation.electricDelta}
                </span>
              )}
              {variation.docksDelta !== 0 && (
                <span data-direction={variation.docksDelta > 0 ? "up" : "down"}>
                  <IconParking size={15} />
                  {variation.docksDelta > 0 ? "+" : ""}{variation.docksDelta}
                </span>
              )}
              {variation.mechanicalDelta === 0 &&
                variation.electricDelta === 0 &&
                variation.docksDelta === 0 && <span>Statut actualisé</span>}
            </div>
          </div>
        )}
        {trend.deltas.length > 0 && (
          <section className="station-streak" aria-label="Variations récentes de disponibilité">
            <div className="station-streak__heading">
              <span>
                <b>Dernières variations</b>
                <small>Disponibilité totale des vélos</small>
              </span>
              <div className="station-streak__values" aria-label={trend.deltas.join(", ")}>
                {trend.deltas.map((delta, index) => (
                  <i data-direction={delta > 0 ? "up" : "down"} key={`${index}-${delta}`}>
                    {delta > 0 ? "+" : "−"}{Math.abs(delta)}
                  </i>
                ))}
              </div>
            </div>
            <svg
              aria-hidden="true"
              className="station-streak__chart"
              preserveAspectRatio="none"
              viewBox="0 0 180 36"
            >
              <line x1="0" x2="180" y1="30" y2="30" />
              <polyline points={sparklinePoints(trend.points)} />
            </svg>
          </section>
        )}
      </div>

      <div className="detail-metrics">
        <MetricTile icon={<IconBike size={22} />} value={station.mechanical} label="Mécaniques" tone="green" />
        <MetricTile icon={<IconBolt size={22} />} value={station.electric} label="Électriques" tone="blue" />
        <MetricTile icon={<IconParking size={22} />} value={station.docks} label="Places libres" tone="gray" />
        <MetricTile icon={<IconParkingOff size={22} />} value={station.unavailable} label="Indisponibles" tone="red" />
      </div>

      <Button
        className="directions-button"
        component="a"
        href={directions}
        leftSection={<IconMapPin size={18} />}
        rel="noreferrer"
        rightSection={<IconExternalLink size={15} />}
        target="_blank"
        variant="filled"
      >
        Itinéraire
      </Button>

      {historyEnabled ? (
        <Suspense
          fallback={(
            <section aria-busy="true" aria-label="Chargement du graphique" className="history-section">
              <Skeleton height={24} width="45%" />
              <Skeleton height={250} mt="md" radius="md" />
            </section>
          )}
        >
          <HistoryChart
            error={historyError}
            history={history}
            loading={historyLoading}
            onRangeChange={onRangeChange}
            range={range}
          />
        </Suspense>
      ) : (
        <section className="replay-detail-note">
          <b>Contexte de relecture</b>
          <span>Les compteurs et la série ci-dessus correspondent à l’instant sélectionné.</span>
        </section>
      )}

      {nearby.length > 0 && (
        <section className="nearby-section" aria-labelledby="nearby-heading">
          <Text className="eyebrow">À proximité</Text>
          <Text component="h3" id="nearby-heading" className="nearby-title">Stations voisines</Text>
          <Stack component="ul" gap={7} mt="sm">
            {nearby.map((candidate) => (
              <li key={candidate.code}>
                <UnstyledButton className="nearby-row" onClick={() => onSelect(candidate)}>
                  <span>
                    <b>{candidate.name}</b>
                    <small>{stationBikes(candidate)} vélos · {candidate.docks} places</small>
                  </span>
                  <Text>{formatDistance(distanceInMeters(station, candidate))}</Text>
                </UnstyledButton>
              </li>
            ))}
          </Stack>
        </section>
      )}
    </div>
  )
}

const mediaQueryOptions = { getInitialValueInEffect: false } as const

export const StationDetails = (props: StationDetailsProps) => {
  const useDrawer = useMediaQuery("(max-width: 1100px)", undefined, mediaQueryOptions)
  const useMobileReturnTarget = useMediaQuery(
    "(max-width: 899px)",
    undefined,
    mediaQueryOptions,
  )
  const panelRef = useRef<HTMLElement>(null)
  const { station, onClose, onMobileCloseFocus } = props

  const closeDrawer = () => {
    onClose()
    if (useMobileReturnTarget) {
      window.requestAnimationFrame(onMobileCloseFocus)
    }
  }

  useEffect(() => {
    if (useDrawer) return
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    panelRef.current?.focus()
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [useDrawer])

  if (!station) return null

  const content = <DetailContent {...props} station={station} />

  if (useDrawer) {
    return (
      <Drawer
        classNames={{ content: "station-drawer", body: "station-drawer__body", header: "station-drawer__header" }}
        onClose={closeDrawer}
        opened
        position="bottom"
        returnFocus={!useMobileReturnTarget}
        size="88%"
        title={<Text fw={800} size="lg">Détail de la station</Text>}
      >
        {content}
      </Drawer>
    )
  }

  return (
    <aside
      aria-labelledby="station-detail-title"
      className="station-detail-panel"
      ref={panelRef}
      tabIndex={-1}
    >
      <Tooltip label="Fermer le détail">
        <ActionIcon
          aria-label="Fermer le détail"
          className="detail-close"
          onClick={onClose}
          variant="subtle"
        >
          <IconX size={20} />
        </ActionIcon>
      </Tooltip>
      {content}
    </aside>
  )
}

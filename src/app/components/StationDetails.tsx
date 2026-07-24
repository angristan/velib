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
import { useI18n } from "../i18n"
import type { AppLocale } from "../locale"
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
  locale,
}: {
  readonly icon: React.ReactNode
  readonly value: number
  readonly label: string
  readonly tone: string
  readonly locale: AppLocale
}) => (
  <div className={`detail-metric detail-metric--${tone}`}>
    <span>{icon}</span>
    <b>{formatNumber(value, locale)}</b>
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
  const { locale, messages } = useI18n()
  const copy = messages.details
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
            {operative ? copy.open : copy.unavailable}
          </Badge>
          <Text className="detail-code">{messages.common.stationNumber} {station.code}</Text>
        </Group>
        <Text component="h2" id="station-detail-title" className="detail-title">{station.name}</Text>
        {comparison && (
          <span className="capacity-context">{copy.selectedMoment} · {formatArchiveTimestamp(comparison.toAt, locale)}</span>
        )}
        <div className="capacity-summary">
          <div>
            <strong>{bikes}</strong>
            <span>{copy.availableBikes}</span>
          </div>
          <Text>{copy.freeDocks(station.docks, station.capacity)}</Text>
        </div>
        <Progress.Root
          aria-label={copy.capacity(bikes, station.docks, station.unavailable, station.capacity)}
          className="capacity-progress"
          radius="xl"
          size="sm"
        >
          <Progress.Section color={operative ? "green.6" : "gray.6"} value={occupiedPercent} />
          <Progress.Section color="gray.4" value={docksPercent} />
          <Progress.Section color="red.6" value={unavailablePercent} />
        </Progress.Root>
        {comparison && (
          <section className="station-comparison" aria-label={copy.comparisonLabel}>
            <header className="station-comparison__title">
              <span><IconArrowsDiff size={17} /></span>
              <div>
                <b>{copy.comparisonTitle}</b>
                <small>{formatArchiveDuration(comparison.fromAt, comparison.toAt, locale)}</small>
              </div>
              <em data-direction={comparisonBikeDelta > 0 ? "up" : comparisonBikeDelta < 0 ? "down" : "neutral"}>
                {copy.bikeDelta(comparisonBikeDelta)}
              </em>
            </header>
            <div className="station-comparison__endpoints">
              <span><b>{copy.before}</b>{formatArchiveTimestamp(comparison.fromAt, locale)}</span>
              <span><b>{copy.after}</b>{formatArchiveTimestamp(comparison.toAt, locale)}</span>
            </div>
            <table>
              <caption className="sr-only">{copy.comparisonCaption}</caption>
              <thead>
                <tr><th>{copy.measure}</th><th>{copy.before}</th><th>{copy.after}</th><th>Δ</th></tr>
              </thead>
              <tbody>
                {[
                  [messages.common.mechanical, comparison.from.mechanical, station.mechanical],
                  [messages.common.electric, comparison.from.electric, station.electric],
                  [messages.common.freeDocks, comparison.from.docks, station.docks],
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
                variation.docksDelta === 0 && <span>{copy.statusUpdated}</span>}
            </div>
          </div>
        )}
        {trend.deltas.length > 0 && (
          <section className="station-streak" aria-label={copy.recentVariations}>
            <div className="station-streak__heading">
              <span>
                <b>{copy.lastVariations}</b>
                <small>{copy.totalAvailability}</small>
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
        <MetricTile icon={<IconBike size={22} />} value={station.mechanical} label={messages.common.mechanical} locale={locale} tone="green" />
        <MetricTile icon={<IconBolt size={22} />} value={station.electric} label={messages.common.electric} locale={locale} tone="blue" />
        <MetricTile icon={<IconParking size={22} />} value={station.docks} label={messages.common.freeDocks} locale={locale} tone="gray" />
        <MetricTile icon={<IconParkingOff size={22} />} value={station.unavailable} label={messages.common.unavailable} locale={locale} tone="red" />
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
        {copy.directions}
      </Button>

      {historyEnabled ? (
        <Suspense
          fallback={(
            <section aria-busy="true" aria-label={copy.chartLoading} className="history-section">
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
          <b>{copy.replayContext}</b>
          <span>{copy.replayContextHint}</span>
        </section>
      )}

      {nearby.length > 0 && (
        <section className="nearby-section" aria-labelledby="nearby-heading">
          <Text className="eyebrow">{copy.nearbyEyebrow}</Text>
          <Text component="h3" id="nearby-heading" className="nearby-title">{copy.nearbyTitle}</Text>
          <Stack component="ul" gap={7} mt="sm">
            {nearby.map((candidate) => (
              <li key={candidate.code}>
                <UnstyledButton className="nearby-row" onClick={() => onSelect(candidate)}>
                  <span>
                    <b>{candidate.name}</b>
                    <small>{copy.nearbySummary(stationBikes(candidate), candidate.docks)}</small>
                  </span>
                  <Text>{formatDistance(distanceInMeters(station, candidate), locale)}</Text>
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
  const { messages } = useI18n()
  const copy = messages.details
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
        closeButtonProps={{ "aria-label": copy.close }}
        onClose={closeDrawer}
        opened
        position="bottom"
        returnFocus={!useMobileReturnTarget}
        size="88%"
        title={<Text fw={800} size="lg">{copy.drawerTitle}</Text>}
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
      <Tooltip label={copy.close}>
        <ActionIcon
          aria-label={copy.close}
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

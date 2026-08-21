import { LineChart } from "@mantine/charts"
import {
  Alert,
  Center,
  Group,
  Skeleton,
  Stack,
  Text,
} from "@mantine/core"
import { IconChartAreaLine, IconInfoCircle } from "@tabler/icons-react"
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import { useI18n } from "../i18n"
import type { HistoryRange, StationHistory } from "../types"
import { formatChartTime, formatDecimal, formatNumber } from "../utils"

interface HistoryChartProps {
  readonly history: StationHistory | null
  readonly range: HistoryRange
  readonly loading: boolean
  readonly error: string | null
  readonly onRangeChange: (range: HistoryRange) => void
}

interface TooltipPosition {
  readonly x: number
  readonly y: number
}

const TOOLTIP_OFFSET = 10
const TOOLTIP_FALLBACK_WIDTH = 136
const TOOLTIP_FALLBACK_HEIGHT = 98

const placeTooltipAxis = (cursor: number, tooltipSize: number, chartSize: number) => {
  const afterCursor = cursor + TOOLTIP_OFFSET
  return afterCursor + tooltipSize <= chartSize
    ? afterCursor
    : Math.max(0, cursor - tooltipSize - TOOLTIP_OFFSET)
}

export const HistoryChart = ({
  history,
  range,
  loading,
  error,
  onRangeChange,
}: HistoryChartProps) => {
  const { locale, messages } = useI18n()
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition>()
  const tooltipFrame = useRef<number | null>(null)
  const copy = messages.history
  const ranges: ReadonlyArray<{ value: HistoryRange; label: string }> = [
    { value: "1h", label: copy.ranges.hour },
    { value: "3h", label: copy.ranges.threeHours },
    { value: "1d", label: copy.ranges.day },
    { value: "7d", label: copy.ranges.week },
    { value: "30d", label: copy.ranges.month },
    { value: "1y", label: copy.ranges.year },
  ]
  const points = history?.points ?? []
  const mechanicalLabel = messages.common.mechanical
  const electricLabel = messages.common.electric
  const docksLabel = messages.common.docks
  const unavailableLabel = messages.common.unavailable
  const seriesOrder = [mechanicalLabel, electricLabel, docksLabel, unavailableLabel]
  const chartData = points.map((point) => ({
    label: formatChartTime(point.at, range, locale),
    timestamp: point.at,
    [mechanicalLabel]: Math.round(point.mechanical * 10) / 10,
    [electricLabel]: Math.round(point.electric * 10) / 10,
    [docksLabel]: Math.round(point.docks * 10) / 10,
    [unavailableLabel]: Math.round(point.unavailable * 10) / 10,
  }))
  const bikes = points.map((point) => point.mechanical + point.electric)
  const average = bikes.length > 0
    ? bikes.reduce((sum, value) => sum + value, 0) / bikes.length
    : 0
  const removed = points.reduce((sum, point) => sum + point.removed, 0)
  const returned = points.reduce((sum, point) => sum + point.returned, 0)
  const formatAvailability = (value: number) => Number.isInteger(value)
    ? formatNumber(value, locale)
    : formatDecimal(value, locale)

  const cancelTooltipFrame = useCallback(() => {
    if (tooltipFrame.current !== null) {
      window.cancelAnimationFrame(tooltipFrame.current)
      tooltipFrame.current = null
    }
  }, [])

  const handleChartMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const chart = event.currentTarget
    const chartBounds = chart.getBoundingClientRect()
    const tooltip = chart.querySelector<HTMLElement>(".availability-chart__tooltip")
    const cursorX = event.clientX - chartBounds.left
    const cursorY = event.clientY - chartBounds.top
    const nextPosition = {
      x: placeTooltipAxis(cursorX, tooltip?.offsetWidth ?? TOOLTIP_FALLBACK_WIDTH, chartBounds.width),
      y: placeTooltipAxis(cursorY, tooltip?.offsetHeight ?? TOOLTIP_FALLBACK_HEIGHT, chartBounds.height),
    }

    cancelTooltipFrame()
    tooltipFrame.current = window.requestAnimationFrame(() => {
      setTooltipPosition((current) => current?.x === nextPosition.x && current.y === nextPosition.y
        ? current
        : nextPosition)
      tooltipFrame.current = null
    })
  }, [cancelTooltipFrame])

  const handleChartMouseLeave = useCallback(() => {
    cancelTooltipFrame()
    setTooltipPosition(undefined)
  }, [cancelTooltipFrame])

  useEffect(() => cancelTooltipFrame, [cancelTooltipFrame])

  return (
    <section className="history-section" aria-labelledby="history-heading">
      <Group justify="space-between" align="center" wrap="nowrap">
        <div>
          <Text className="eyebrow">{copy.eyebrow}</Text>
          <Text component="h3" id="history-heading" className="history-title">{copy.title}</Text>
        </div>
        <div className="range-control" role="group" aria-label={copy.period}>
          {ranges.map((option) => (
            <button
              aria-pressed={range === option.value}
              data-active={range === option.value || undefined}
              key={option.value}
              onClick={() => onRangeChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </Group>

      {loading ? (
        <Stack gap="sm" mt="md">
          <Skeleton height={22} width="55%" />
          <Skeleton height={190} radius="md" />
        </Stack>
      ) : error ? (
        <Alert color="orange" icon={<IconInfoCircle size={18} />} mt="md" title={copy.unavailable}>
          {error}
        </Alert>
      ) : points.length === 0 ? (
        <Center className="chart-empty">
          <Stack align="center" gap={6}>
            <IconChartAreaLine size={30} stroke={1.5} />
            <Text fw={700}>{copy.empty}</Text>
            <Text c="dimmed" size="sm" ta="center">{copy.emptyHint}</Text>
          </Stack>
        </Center>
      ) : (
        <>
          <div className="chart-stats">
            <span><small>{copy.low}</small><b>{formatNumber(Math.min(...bikes), locale)}</b></span>
            <span><small>{copy.average}</small><b>{formatDecimal(average, locale)}</b></span>
            <span><small>{copy.high}</small><b>{formatNumber(Math.max(...bikes), locale)}</b></span>
            <span><small>{copy.movements}</small><b>−{formatNumber(removed, locale)} / +{formatNumber(returned, locale)}</b></span>
          </div>
          <LineChart
            activeDotProps={{ r: 4, strokeWidth: 2 }}
            aria-label={copy.chartLabel}
            className="availability-chart"
            classNames={{
              legend: "availability-chart__legend",
              legendItem: "availability-chart__legend-item",
              legendItemColor: "availability-chart__legend-color",
              tooltip: "availability-chart__tooltip",
              tooltipBody: "availability-chart__tooltip-body",
              tooltipItem: "availability-chart__tooltip-item",
              tooltipItemBody: "availability-chart__tooltip-item-body",
              tooltipItemColor: "availability-chart__tooltip-item-color",
              tooltipItemData: "availability-chart__tooltip-item-data",
              tooltipItemName: "availability-chart__tooltip-item-name",
              tooltipLabel: "availability-chart__tooltip-label",
            }}
            curveType="linear"
            data={chartData}
            dataKey="label"
            dotProps={{ r: 2.5, strokeWidth: 0 }}
            gridAxis="x"
            h={260}
            legendProps={{
              height: locale === "fr" ? 42 : 28,
              iconSize: 8,
              itemSorter: (item) => seriesOrder.indexOf(String(item.value)),
              verticalAlign: "top",
            }}
            lineChartProps={{ margin: { bottom: 0, left: -6, right: 6, top: 0 } }}
            lineProps={{ isAnimationActive: false, strokeLinecap: "round", strokeLinejoin: "round" }}
            onMouseLeave={handleChartMouseLeave}
            onMouseMove={handleChartMouseMove}
            series={[
              { name: mechanicalLabel, color: "var(--mint)" },
              { name: electricLabel, color: "var(--blue)" },
              { name: docksLabel, color: "var(--chart-docks)", strokeDasharray: "6 4" },
              { name: unavailableLabel, color: "var(--coral)", strokeDasharray: "2 4" },
            ]}
            strokeDasharray="2 5"
            strokeWidth={2.2}
            tickLine="none"
            tooltipAnimationDuration={0}
            tooltipProps={{
              cursor: { stroke: "var(--blue)", strokeDasharray: "4 3", strokeOpacity: 0.7, strokeWidth: 1.4 },
              isAnimationActive: false,
              position: tooltipPosition,
              wrapperStyle: { pointerEvents: "none" },
            }}
            valueFormatter={formatAvailability}
            withDots={points.length <= 6}
            withLegend
            xAxisProps={{ minTickGap: 24, tickMargin: 8 }}
            yAxisProps={{ allowDecimals: false, domain: [0, "auto"], tickCount: 5, width: 32 }}
          />
        </>
      )}
    </section>
  )
}

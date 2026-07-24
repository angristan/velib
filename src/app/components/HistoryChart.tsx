import { AreaChart } from "@mantine/charts"
import {
  Alert,
  Center,
  Group,
  Skeleton,
  Stack,
  Text,
} from "@mantine/core"
import { IconChartAreaLine, IconInfoCircle } from "@tabler/icons-react"
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

export const HistoryChart = ({
  history,
  range,
  loading,
  error,
  onRangeChange,
}: HistoryChartProps) => {
  const { locale, messages } = useI18n()
  const copy = messages.history
  const ranges: ReadonlyArray<{ value: HistoryRange; label: string }> = [
    { value: "1h", label: copy.ranges.hour },
    { value: "3h", label: copy.ranges.threeHours },
    { value: "1d", label: copy.ranges.day },
    { value: "7d", label: copy.ranges.week },
  ]
  const points = history?.points ?? []
  const mechanicalLabel = messages.common.mechanical
  const electricLabel = messages.common.electric
  const docksLabel = messages.common.docks
  const unavailableLabel = messages.common.unavailable
  const chartData = points.map((point) => ({
    label: formatChartTime(point.at, range === "7d", locale),
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
          <AreaChart
            aria-label={copy.chartLabel}
            className="availability-chart"
            curveType="monotone"
            data={chartData}
            dataKey="label"
            fillOpacity={0.06}
            gridAxis="y"
            h={250}
            series={[
              { name: mechanicalLabel, color: "green.6" },
              { name: electricLabel, color: "blue.6" },
              { name: docksLabel, color: "gray.6" },
              { name: unavailableLabel, color: "red.6" },
            ]}
            strokeWidth={2}
            tickLine="none"
            valueFormatter={(value) => formatDecimal(value, locale)}
            withDots={points.length < 25}
            withGradient={false}
            withLegend
            yAxisProps={{ width: 34, allowDecimals: false }}
          />
        </>
      )}
    </section>
  )
}

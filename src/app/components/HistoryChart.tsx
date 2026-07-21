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
import type { HistoryRange, StationHistory } from "../types"
import { formatChartTime, formatNumber } from "../utils"

interface HistoryChartProps {
  readonly history: StationHistory | null
  readonly range: HistoryRange
  readonly loading: boolean
  readonly error: string | null
  readonly onRangeChange: (range: HistoryRange) => void
}

const ranges: ReadonlyArray<{ value: HistoryRange; label: string }> = [
  { value: "1h", label: "1 h" },
  { value: "3h", label: "3 h" },
  { value: "1d", label: "24 h" },
  { value: "7d", label: "7 j" },
]

export const HistoryChart = ({
  history,
  range,
  loading,
  error,
  onRangeChange,
}: HistoryChartProps) => {
  const points = history?.points ?? []
  const chartData = points.map((point) => ({
    label: formatChartTime(point.at, range === "7d"),
    timestamp: point.at,
    Mécaniques: Math.round(point.mechanical * 10) / 10,
    Électriques: Math.round(point.electric * 10) / 10,
    Places: Math.round(point.docks * 10) / 10,
    Indisponibles: Math.round(point.unavailable * 10) / 10,
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
          <Text className="eyebrow">Évolution</Text>
          <Text component="h3" id="history-heading" className="history-title">Disponibilité</Text>
        </div>
        <div className="range-control" role="group" aria-label="Période de l’historique">
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
        <Alert color="orange" icon={<IconInfoCircle size={18} />} mt="md" title="Historique indisponible">
          {error}
        </Alert>
      ) : points.length === 0 ? (
        <Center className="chart-empty">
          <Stack align="center" gap={6}>
            <IconChartAreaLine size={30} stroke={1.5} />
            <Text fw={700}>Pas encore d’historique</Text>
            <Text c="dimmed" size="sm" ta="center">
              La courbe apparaîtra au fil des collectes, sans données artificielles.
            </Text>
          </Stack>
        </Center>
      ) : (
        <>
          <div className="chart-stats">
            <span><small>creux affiché</small><b>{formatNumber(Math.min(...bikes))}</b></span>
            <span><small>moyenne</small><b>{average.toFixed(1)}</b></span>
            <span><small>pic affiché</small><b>{formatNumber(Math.max(...bikes))}</b></span>
            <span><small>mouvements</small><b>−{removed} / +{returned}</b></span>
          </div>
          <AreaChart
            aria-label="Historique des vélos, places libres et emplacements indisponibles"
            className="availability-chart"
            curveType="monotone"
            data={chartData}
            dataKey="label"
            fillOpacity={0.1}
            gridAxis="y"
            h={250}
            series={[
              { name: "Mécaniques", color: "green.6" },
              { name: "Électriques", color: "blue.6" },
              { name: "Places", color: "gray.6" },
              { name: "Indisponibles", color: "red.6" },
            ]}
            strokeWidth={2.2}
            tickLine="none"
            withDots={points.length < 25}
            withGradient
            withLegend
            yAxisProps={{ width: 34, allowDecimals: false }}
          />
        </>
      )}
    </section>
  )
}

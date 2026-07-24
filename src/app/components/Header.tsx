import {
  ActionIcon,
  Group,
  Skeleton,
  Text,
  Tooltip,
} from "@mantine/core"
import {
  IconBike,
  IconBolt,
  IconBrandGithub,
  IconMoonStars,
  IconParking,
  IconRefresh,
  IconSun,
} from "@tabler/icons-react"
import { memo, useEffect, useMemo, useRef } from "react"
import { useI18n } from "../i18n"
import type { AppLocale } from "../locale"
import type {
  LiveData,
  MapBackground,
} from "../types"
import { formatNumber } from "../utils"

interface HeaderProps {
  readonly colorScheme: MapBackground
  readonly data: LiveData | null
  readonly loading: boolean
  readonly onColorSchemeChange: (colorScheme: MapBackground) => void
  readonly onRefresh: () => void
}

interface KpiProps {
  readonly icon: React.ReactNode
  readonly label: string
  readonly value: number
  readonly tone: "green" | "blue" | "navy"
  readonly pulse: boolean
  readonly locale: AppLocale
}

const Kpi = ({ icon, label, value, tone, pulse, locale }: KpiProps) => (
  <div className={`network-kpi network-kpi--${tone}`}>
    <span className="network-kpi__icon" aria-hidden="true">{icon}</span>
    <span>
      <strong className={pulse ? "network-kpi__value--pulse" : undefined} key={value}>
        {formatNumber(value, locale)}
      </strong>
      <small>{label}</small>
    </span>
  </div>
)

export const Header = memo(function Header({
  colorScheme,
  data,
  loading,
  onColorSchemeChange,
  onRefresh,
}: HeaderProps) {
  const { locale, messages, setLocale } = useI18n()
  const copy = messages.header
  const nextColorScheme = colorScheme === "dark" ? "light" : "dark"
  const themeLabel = colorScheme === "dark" ? copy.lightTheme : copy.darkTheme
  const totals = useMemo(() => (data?.stations ?? []).reduce(
    (current, station) => ({
      mechanical: current.mechanical + station.mechanical,
      electric: current.electric + station.electric,
      docks: current.docks + station.docks,
    }),
    { mechanical: 0, electric: 0, docks: 0 },
  ), [data?.stations])
  const previousTotalsRef = useRef<typeof totals | null>(null)
  const previousTotals = previousTotalsRef.current
  useEffect(() => {
    previousTotalsRef.current = totals
  }, [totals.mechanical, totals.electric, totals.docks])

  return (
    <header className="app-header">
      <div className="brand-lockup" aria-label="Vélib’ Pulse">
        <div className="brand-mark" aria-hidden="true"><IconBike size={25} stroke={2.4} /></div>
        <div>
          <Text className="brand-name">Vélib’ <em>Pulse</em></Text>
          <Text className="brand-tagline">{copy.tagline}</Text>
        </div>
      </div>

      <div className="network-kpis" aria-label={copy.networkAvailability}>
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
              label={copy.mechanicalBikes}
              locale={locale}
              pulse={previousTotals !== null && previousTotals.mechanical !== totals.mechanical}
              tone="green"
              value={totals.mechanical}
            />
            <Kpi
              icon={<IconBolt size={21} />}
              label={copy.electricBikes}
              locale={locale}
              pulse={previousTotals !== null && previousTotals.electric !== totals.electric}
              tone="blue"
              value={totals.electric}
            />
            <Kpi
              icon={<IconParking size={21} />}
              label={copy.freeDocks}
              locale={locale}
              pulse={false}
              tone="navy"
              value={totals.docks}
            />
          </>
        )}
      </div>

      <Group gap="sm" className="header-actions" wrap="nowrap">
        <Tooltip label={copy.switchLanguage}>
          <ActionIcon
            aria-label={copy.switchLanguage}
            className="language-toggle"
            onClick={() => setLocale(locale === "fr" ? "en" : "fr")}
            size="lg"
            variant="subtle"
          >
            <span aria-hidden="true">{copy.languageCode}</span>
          </ActionIcon>
        </Tooltip>
        <Tooltip label={themeLabel}>
          <ActionIcon
            aria-label={themeLabel}
            className="theme-toggle"
            onClick={() => onColorSchemeChange(nextColorScheme)}
            size="lg"
            variant="subtle"
          >
            {colorScheme === "dark" ? <IconSun size={19} /> : <IconMoonStars size={19} />}
          </ActionIcon>
        </Tooltip>
        <Tooltip label={copy.sourceCode}>
          <ActionIcon
            aria-label={copy.sourceCode}
            className="github-button"
            component="a"
            href="https://github.com/angristan/velib"
            rel="noreferrer"
            size="lg"
            target="_blank"
            variant="subtle"
          >
            <IconBrandGithub size={19} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label={copy.refresh}>
          <ActionIcon
            aria-label={copy.refresh}
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

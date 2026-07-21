import {
  ActionIcon,
  Alert,
  Badge,
  Group,
  ScrollArea,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core"
import {
  IconAlertCircle,
  IconBike,
  IconBolt,
  IconParking,
  IconSearch,
  IconX,
} from "@tabler/icons-react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useEffect, useMemo, useRef } from "react"
import type { Station, StationFilter, UserLocation } from "../types"
import {
  stationBikes,
  stationIsOperative,
  stationMatchesFilter,
  stationMatchesQuery,
} from "../types"
import { distanceInMeters, formatDistance } from "../utils"

interface StationListProps {
  readonly stations: readonly Station[]
  readonly selectedCode: string | null
  readonly userLocation: UserLocation | null
  readonly search: string
  readonly filter: StationFilter
  readonly onSearchChange: (value: string) => void
  readonly onFilterChange: (value: StationFilter) => void
  readonly onSelect: (station: Station) => void
}

const filterOptions: ReadonlyArray<{ value: StationFilter; label: string }> = [
  { value: "all", label: "Toutes" },
  { value: "bikes", label: "Vélos" },
  { value: "electric", label: "Élect." },
  { value: "docks", label: "Places" },
  { value: "attention", label: "Alertes" },
]

export const StationList = ({
  stations,
  selectedCode,
  userLocation,
  search,
  filter,
  onSearchChange,
  onFilterChange,
  onSelect,
}: StationListProps) => {
  const visibleStations = useMemo(() => {
    const matching = stations.filter((station) =>
      stationMatchesQuery(station, search) && stationMatchesFilter(station, filter)
    )

    return matching.sort((left, right) => {
      if (userLocation) {
        return distanceInMeters(userLocation, left) - distanceInMeters(userLocation, right)
      }
      return left.name.localeCompare(right.name, "fr")
    })
  }, [filter, search, stations, userLocation])
  const viewportRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: visibleStations.length,
    estimateSize: () => 94,
    getItemKey: (index) => visibleStations[index]?.code ?? index,
    getScrollElement: () => viewportRef.current,
    overscan: 8,
  })

  useEffect(() => {
    if (viewportRef.current) rowVirtualizer.scrollToOffset(0)
  }, [filter, rowVirtualizer, search])

  const focusStationAt = (index: number) => {
    if (visibleStations.length === 0) return
    const nextIndex = Math.max(0, Math.min(index, visibleStations.length - 1))
    rowVirtualizer.scrollToIndex(nextIndex, { align: "auto" })
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        viewportRef.current
          ?.querySelector<HTMLButtonElement>(`[data-station-index="${nextIndex}"]`)
          ?.focus()
      })
    })
  }

  return (
    <aside className="station-sidebar" id="station-explorer" aria-label="Liste des stations">
      <div className="station-sidebar__heading">
        <Group justify="space-between" align="flex-end">
          <div>
            <Text className="eyebrow">Explorer</Text>
            <Text component="h1" className="sidebar-title">Stations</Text>
          </div>
          <Badge variant="light" size="md" className="station-count">
            {visibleStations.length} / {stations.length}
          </Badge>
        </Group>

        <TextInput
          aria-label="Rechercher une station"
          className="station-search"
          leftSection={<IconSearch size={18} />}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
          placeholder="Rechercher une station"
          rightSection={search ? (
            <ActionIcon
              aria-label="Effacer la recherche"
              color="gray"
              onClick={() => onSearchChange("")}
              size="sm"
              variant="subtle"
            >
              <IconX size={17} />
            </ActionIcon>
          ) : undefined}
          size="md"
          value={search}
        />

        <div className="station-filters" role="group" aria-label="Filtrer les stations">
          {filterOptions.map((option) => (
            <button
              aria-pressed={filter === option.value}
              data-active={filter === option.value || undefined}
              key={option.value}
              onClick={() => onFilterChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <ScrollArea
        className="station-scroll"
        offsetScrollbars
        type="auto"
        viewportRef={viewportRef}
      >
        <ul
          aria-label={`${visibleStations.length} stations affichées`}
          className="station-list"
          style={{ height: rowVirtualizer.getTotalSize() }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const station = visibleStations[virtualRow.index]
            if (!station) return null
            const totalBikes = stationBikes(station)
            const isUnavailable = !stationIsOperative(station)
            const distance = userLocation ? distanceInMeters(userLocation, station) : null

            return (
              <li
                aria-posinset={virtualRow.index + 1}
                aria-setsize={visibleStations.length}
                data-index={virtualRow.index}
                key={station.code}
                ref={rowVirtualizer.measureElement}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <UnstyledButton
                  aria-current={selectedCode === station.code ? "true" : undefined}
                  className="station-row"
                  data-active={selectedCode === station.code || undefined}
                  data-station-index={virtualRow.index}
                  onClick={() => onSelect(station)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault()
                      focusStationAt(virtualRow.index + 1)
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault()
                      focusStationAt(virtualRow.index - 1)
                    } else if (event.key === "Home") {
                      event.preventDefault()
                      focusStationAt(0)
                    } else if (event.key === "End") {
                      event.preventDefault()
                      focusStationAt(visibleStations.length - 1)
                    }
                  }}
                >
                  <div className="station-row__topline">
                    <Text className="station-name" lineClamp={1}>{station.name}</Text>
                    {distance !== null && <Text className="station-distance">{formatDistance(distance)}</Text>}
                  </div>
                  <Text className="station-code">N° {station.code}</Text>

                  {isUnavailable ? (
                    <div className="station-unavailable"><IconAlertCircle size={15} /> Indisponible</div>
                  ) : (
                    <div className="station-metrics">
                      <span className="metric metric--bike"><IconBike size={15} /><b>{station.mechanical}</b><small>méca.</small></span>
                      <span className="metric metric--electric"><IconBolt size={15} /><b>{station.electric}</b><small>élec.</small></span>
                      <span className="metric metric--dock"><IconParking size={15} /><b>{station.docks}</b><small>places</small></span>
                      <span className="availability-bar" aria-label={`${totalBikes} vélos sur ${station.capacity} emplacements`}>
                        <i style={{ width: `${Math.min(100, (totalBikes / Math.max(1, station.capacity)) * 100)}%` }} />
                      </span>
                    </div>
                  )}
                </UnstyledButton>
              </li>
            )
          })}
        </ul>

        {visibleStations.length === 0 && (
          <Alert className="no-results" color="gray" icon={<IconSearch size={18} />} title="Aucune station trouvée">
            Essayez un autre nom ou élargissez les filtres.
          </Alert>
        )}
      </ScrollArea>

      <footer className="station-data-credit">
        Service non officiel · Données{" "}
        <a
          href="https://www.velib-metropole.fr/donnees-open-data-gbfs-du-service-velib-metropole"
          rel="noreferrer"
          target="_blank"
        >
          Vélib’ Métropole
        </a>{" "}
        ·{" "}
        <a
          href="https://www.etalab.gouv.fr/licence-ouverte-open-licence/"
          rel="noreferrer"
          target="_blank"
        >
          Licence Ouverte
        </a>
      </footer>
    </aside>
  )
}

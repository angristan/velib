import {
  Alert,
  Text,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core"
import {
  IconChevronLeft,
  IconChevronRight,
  IconCloudOff,
  IconList,
  IconMap2,
} from "@tabler/icons-react"
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  compareSnapshots,
  defaultComparison,
} from "./archive"
import { DataStateOverlay } from "./components/DataStateOverlay"
import { Header } from "./components/Header"
import { ReplayControls } from "./components/ReplayControls"
import { StationList } from "./components/StationList"
import { TurnstileGate } from "./components/TurnstileGate"
import { useAccessSession } from "./hooks/useAccessSession"
import { useI18n } from "./i18n"
import {
  useArchiveSnapshot,
  useLiveData,
  useReplayData,
  useStationHistory,
} from "./hooks/useVelibData"
import {
  aggregateReplayChanges,
  archiveSnapshotDataAt,
  latestReplayUpdate,
  replayDataAt,
  replayUpdateAt,
  stationTrend,
} from "./replay"
import type {
  DataMode,
  HistoryRange,
  MapBackground,
  MapCamera,
  MapMode,
  PlaybackSpeed,
  Station,
  StationComparison,
  StationFilter,
  TimelineMode,
  TimelineRange,
  UserLocation,
} from "./types"
import { stationMatchesFilter, stationMatchesQuery } from "./types"
import { themeChangeFor } from "./theme"
import { clearAppUrlState, parseAppUrlState, serializeAppUrlState } from "./url-state"
import { distanceInMeters } from "./utils"

const MapView = lazy(() =>
  import("./components/MapView").then((module) => ({ default: module.MapView })),
)
const loadStationDetails = () => import("./components/StationDetails")
const preloadStationInteraction = () => Promise.all([
  loadStationDetails(),
  import("./components/HistoryChart"),
])
const StationDetails = lazy(() =>
  loadStationDetails().then((module) => ({ default: module.StationDetails })),
)

type MobileView = "list" | "map"

const ARCHIVE_REPLAY_MINUTES = 60 as const

export default function App() {
  const initialUrlStateRef = useRef(parseAppUrlState(window.location.search))
  const initialUrlState = initialUrlStateRef.current
  const { setColorScheme } = useMantineColorScheme()
  const computedColorScheme = useComputedColorScheme("light")
  const { locale, messages } = useI18n()
  const copy = messages.app
  const viewOptions: ReadonlyArray<{ value: MobileView; label: React.ReactNode }> = [
    {
      value: "list",
      label: <span className="view-option"><IconList size={16} /> {copy.list}</span>,
    },
    {
      value: "map",
      label: <span className="view-option"><IconMap2 size={16} /> {copy.map}</span>,
    },
  ]
  const access = useAccessSession()
  const live = useLiveData(!access.checked || access.verified, access.requireVerification)
  const [selectedCode, setSelectedCode] = useState<string | null>(initialUrlState.selectedCode)
  const [selectionFocus, setSelectionFocus] = useState(0)
  const [search, setSearch] = useState(initialUrlState.search)
  const [filter, setFilter] = useState<StationFilter>(initialUrlState.filter)
  const [range, setRange] = useState<HistoryRange>("3h")
  const [mobileView, setMobileView] = useState<MobileView>("map")
  const [explorerOpen, setExplorerOpen] = useState(() => {
    try {
      return window.localStorage.getItem("velib:explorer-open") !== "false"
    } catch {
      return true
    }
  })
  const [mode, setMode] = useState<DataMode>(initialUrlState.mode)
  const [mapMode, setMapMode] = useState<MapMode>(initialUrlState.mapMode)
  const [mapBackground, setMapBackground] = useState<MapBackground>(computedColorScheme)
  const [timelineMode, setTimelineMode] = useState<TimelineMode>(initialUrlState.timelineMode)
  const timelineRange: TimelineRange = "7d"
  const [replayCursor, setReplayCursor] = useState(0)
  const [replayAnchorAt, setReplayAnchorAt] = useState<number | null>(initialUrlState.replayAt)
  const [comparisonFromAt, setComparisonFromAt] = useState<number | null>(
    initialUrlState.comparisonFromAt,
  )
  const [playing, setPlaying] = useState(false)
  const [playbackRequested, setPlaybackRequested] = useState(false)
  const [playbackActive, setPlaybackActive] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(1)
  const [camera, setCamera] = useState<MapCamera>(initialUrlState.camera)
  const [shareConfirmed, setShareConfirmed] = useState(false)
  const mobileMapButtonRef = useRef<HTMLButtonElement>(null)
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null)
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)
  const replayRefreshKey = mode === "live"
    ? Math.floor((live.data?.sourceUpdatedAt ?? 0) / (15 * 60_000))
    : -1
  const snapshot = useArchiveSnapshot(
    replayAnchorAt,
    access.verified && mode === "replay",
    access.requireVerification,
  )
  const comparisonSnapshotQuery = useArchiveSnapshot(
    comparisonFromAt,
    access.verified && mode === "replay" && timelineMode === "compare",
    access.requireVerification,
  )
  const replayNeeded = mode === "live"
    ? mapMode === "heatmap"
    : playbackRequested || playbackActive
  const replay = useReplayData(
    ARCHIVE_REPLAY_MINUTES,
    replayRefreshKey,
    replayAnchorAt,
    mode === "live" ? live.liveUpdate : null,
    access.verified && replayNeeded,
    access.requireVerification,
  )

  useEffect(() => {
    setMapBackground(computedColorScheme)
  }, [computedColorScheme])

  useEffect(() => {
    try {
      window.localStorage.setItem("velib:explorer-open", String(explorerOpen))
    } catch {
      // The explorer remains usable when browser storage is unavailable.
    }
  }, [explorerOpen])

  useEffect(() => {
    if (!playbackRequested || replay.loading) return
    setPlaybackRequested(false)
    if (replay.data === null) return
    setReplayCursor(0)
    setPlaybackActive(true)
    setPlaying(true)
  }, [playbackRequested, replay.data, replay.loading])

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.visibilityState === "hidden") setPlaying(false)
    }
    document.addEventListener("visibilitychange", pauseWhenHidden)
    return () => document.removeEventListener("visibilitychange", pauseWhenHidden)
  }, [])

  useEffect(() => {
    if (!playing || !playbackActive || mode !== "replay" || replay.data === null) return
    const interval = window.setInterval(() => {
      setReplayCursor((current) => Math.min(current + 1, replay.data?.frames.length ?? current))
    }, 1_800 / playbackSpeed)
    return () => window.clearInterval(interval)
  }, [mode, playbackActive, playbackSpeed, playing, replay.data])

  useEffect(() => {
    if (playing && replay.data !== null && replayCursor >= replay.data.frames.length) {
      setPlaying(false)
    }
  }, [playing, replay.data, replayCursor])

  const replaySnapshot = useMemo(() => {
    if (mode !== "replay" || live.data === null) return null
    if (playbackActive && replay.data !== null) {
      return replayDataAt(live.data.stations, replay.data, replayCursor)
    }
    return snapshot.data === null
      ? null
      : archiveSnapshotDataAt(live.data.stations, snapshot.data)
  }, [live.data, mode, playbackActive, replay.data, replayCursor, snapshot.data])
  const comparisonSnapshot = useMemo(() => {
    if (live.data === null || comparisonSnapshotQuery.data === null) return null
    return archiveSnapshotDataAt(live.data.stations, comparisonSnapshotQuery.data)
  }, [comparisonSnapshotQuery.data, live.data])
  const comparing = mode === "replay" && timelineMode === "compare"
  const archiveLoading = snapshot.loading || (comparing && comparisonSnapshotQuery.loading)
  const archiveError = snapshot.error ?? (comparing ? comparisonSnapshotQuery.error : null)
  const presentedData = mode === "replay" ? replaySnapshot : live.data
  const comparisonChanges = useMemo(
    () => comparing ? compareSnapshots(comparisonSnapshot, replaySnapshot) : [],
    [comparing, comparisonSnapshot, replaySnapshot],
  )
  const displayedUpdate = comparing
    ? null
    : mode === "replay"
    ? replayUpdateAt(replay.data, replayCursor)
    : live.liveUpdate ?? latestReplayUpdate(replay.data)
  const activityChanges = useMemo(
    () => comparing
      ? comparisonChanges
      : aggregateReplayChanges(
        replay.data,
        mode === "replay" ? replayCursor : undefined,
      ),
    [comparing, comparisonChanges, mode, replay.data, replayCursor],
  )
  const stations = presentedData?.stations ?? []
  const visibleStations = useMemo(
    () => stations.filter((station) =>
      stationMatchesQuery(station, search) && stationMatchesFilter(station, filter)
    ),
    [filter, search, stations],
  )
  const selected = stations.find((station) => station.code === selectedCode) ?? null
  const selectedVariation = comparing
    ? comparisonChanges.find((change) => change.code === selectedCode) ?? null
    : displayedUpdate?.changes.find((change) => change.code === selectedCode) ?? null
  const selectedComparison = useMemo<StationComparison | null>(() => {
    if (!comparing || selected === null || comparisonSnapshot === null || replaySnapshot === null) return null
    const from = comparisonSnapshot.stations.find((station) => station.code === selected.code)
    if (from === undefined) return null
    return {
      from,
      fromAt: comparisonSnapshot.sourceUpdatedAt,
      toAt: replaySnapshot.sourceUpdatedAt,
    }
  }, [comparing, comparisonSnapshot, replaySnapshot?.sourceUpdatedAt, selected])
  const selectedTrend = useMemo(
    () => comparing
      ? { deltas: [], points: [] }
      : stationTrend(
        replay.data,
        selectedCode ?? "",
        mode === "replay" ? replayCursor : undefined,
      ),
    [comparing, mode, replay.data, replayCursor, selectedCode],
  )
  const history = useStationHistory(
    mode === "live" ? selected?.code ?? null : null,
    range,
    access.verified,
    access.requireVerification,
  )
  const nearby = useMemo(() => {
    if (!selected) return []
    return stations
      .filter((station) => station.code !== selected.code)
      .map((station) => ({ station, distance: distanceInMeters(selected, station) }))
      .sort((left, right) => left.distance - right.distance)
      .slice(0, 3)
      .map(({ station }) => station)
  }, [selected, stations])
  const selectedArchiveAt = mode === "replay"
    ? playbackActive
      ? replaySnapshot?.sourceUpdatedAt ?? replayAnchorAt ?? live.data?.sourceUpdatedAt ?? null
      : replayAnchorAt ?? snapshot.data?.sourceUpdatedAt ?? live.data?.sourceUpdatedAt ?? null
    : live.data?.sourceUpdatedAt ?? null
  const comparisonValue: readonly [number, number] | null =
    timelineMode === "compare" && comparisonFromAt !== null && selectedArchiveAt !== null
      ? [comparisonFromAt, selectedArchiveAt]
      : null

  const selectStation = useCallback((station: Station) => {
    void preloadStationInteraction()
    setSelectedCode(station.code)
    setSelectionFocus((current) => current + 1)
    setMobileView("map")
  }, [])

  const locate = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setLocationError(copy.geolocationUnavailable)
      return
    }

    setLocating(true)
    setLocationError(null)
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        })
        setLocating(false)
      },
      () => {
        setLocationError(copy.geolocationDenied)
        setLocating(false)
      },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 10_000 },
    )
  }, [copy.geolocationDenied, copy.geolocationUnavailable])

  const changeFilter = useCallback((value: StationFilter) => {
    setFilter(value)
  }, [])

  const selectArchiveAt = useCallback((timestamp: number) => {
    setPlaying(false)
    setPlaybackRequested(false)
    setPlaybackActive(false)
    setReplayAnchorAt(timestamp)
    setReplayCursor(0)
  }, [])

  const changeMode = useCallback((nextMode: DataMode) => {
    setPlaying(false)
    setPlaybackRequested(false)
    setPlaybackActive(false)
    if (nextMode === "replay") {
      const timestamp = live.data?.sourceUpdatedAt ?? null
      setReplayAnchorAt(timestamp)
      setReplayCursor(0)
    } else {
      setReplayAnchorAt(null)
    }
    setMode(nextMode)
  }, [live.data?.sourceUpdatedAt])

  const changeTimelineMode = useCallback((nextMode: TimelineMode) => {
    setPlaying(false)
    setPlaybackRequested(false)
    setPlaybackActive(false)
    setTimelineMode(nextMode)
    if (nextMode !== "compare") return

    const latestAt = live.data?.sourceUpdatedAt
    const selectedAt = selectedArchiveAt ?? latestAt
    if (latestAt === undefined || selectedAt === undefined || selectedAt === null) return
    const [fromAt] = defaultComparison(selectedAt, latestAt, timelineRange)
    setComparisonFromAt(fromAt)
  }, [live.data?.sourceUpdatedAt, selectedArchiveAt, timelineRange])

  const changeComparison = useCallback((value: readonly [number, number]) => {
    const [fromAt, toAt] = value
    setComparisonFromAt(fromAt)
    selectArchiveAt(toAt)
  }, [selectArchiveAt])

  const changePlaying = useCallback((nextPlaying: boolean) => {
    if (!nextPlaying) {
      setPlaybackRequested(false)
      setPlaying(false)
      return
    }
    if (!playbackActive || replay.data === null) {
      setPlaybackRequested(true)
      return
    }
    if (replayCursor >= replay.data.frames.length) setReplayCursor(0)
    setPlaying(true)
  }, [playbackActive, replay.data, replayCursor])

  const changeCamera = useCallback((nextCamera: MapCamera, userInitiated: boolean) => {
    setCamera(nextCamera)
    if (userInitiated && window.location.search !== "") {
      window.history.replaceState(null, "", clearAppUrlState(window.location.href))
    }
  }, [])

  const shareUrl = useCallback(() => serializeAppUrlState({
    selectedCode,
    search,
    filter,
    mode,
    replayAt: mode === "replay" ? selectedArchiveAt : null,
    timelineMode,
    timelineRange,
    comparisonFromAt: timelineMode === "compare"
      ? comparisonSnapshot?.sourceUpdatedAt ?? comparisonFromAt
      : null,
    mapMode,
    camera,
  }, window.location.href), [
    camera,
    comparisonFromAt,
    comparisonSnapshot?.sourceUpdatedAt,
    filter,
    mapMode,
    mode,
    search,
    selectedArchiveAt,
    selectedCode,
    timelineMode,
    timelineRange,
  ])

  const changeColorScheme = useCallback((nextColorScheme: MapBackground) => {
    const themeChange = themeChangeFor(nextColorScheme)
    setMapBackground(themeChange.mapBackground)
    setColorScheme(themeChange.colorScheme)
  }, [setColorScheme])

  const share = useCallback(() => {
    const url = shareUrl()
    window.history.replaceState(null, "", url)
    const copy = navigator.clipboard?.writeText(url)
    if (copy === undefined) return
    copy.then(() => {
      setShareConfirmed(true)
      window.setTimeout(() => setShareConfirmed(false), 2_500)
    }).catch(() => undefined)
  }, [shareUrl])

  return (
    <div className="app-frame">
      <Header
        colorScheme={mapBackground}
        data={presentedData}
        loading={live.loading || (mode === "replay" && archiveLoading)}
        onColorSchemeChange={changeColorScheme}
        onRefresh={live.refresh}
      />

      {((live.error && live.data) || archiveError || replay.error || locationError) && (
        <div className="notification-stack" aria-label={copy.notifications}>
          {live.error && live.data && (
            <Alert
              className="connection-warning"
              color="orange"
              icon={<IconCloudOff size={18} />}
              title={copy.updateInterrupted}
            >
              {copy.staleDataHint}
            </Alert>
          )}
          {archiveError && (
            <Alert color="orange" title={comparing ? copy.comparisonUnavailable : copy.archiveUnavailable}>
              {archiveError}
            </Alert>
          )}
          {replay.error && (
            <Alert color="orange" title={copy.replayUnavailable}>{replay.error}</Alert>
          )}
          {locationError && (
            <Alert
              className="location-warning"
              color="orange"
              onClose={() => setLocationError(null)}
              title={locationError}
              withCloseButton
            />
          )}
        </div>
      )}

      <main
        className="workspace"
        data-explorer-open={explorerOpen}
        data-mobile-view={mobileView}
      >
        <StationList
          filter={filter}
          onFilterChange={changeFilter}
          onSearchChange={setSearch}
          onSelect={selectStation}
          search={search}
          selectedCode={selectedCode}
          stations={stations}
          userLocation={userLocation}
        />

        <div className="map-column">
          <button
            aria-controls="station-explorer"
            aria-expanded={explorerOpen}
            aria-label={explorerOpen ? copy.hideExplorer : copy.showExplorer}
            className="explorer-edge-toggle"
            onClick={() => setExplorerOpen((current) => !current)}
            title={explorerOpen ? copy.hideExplorerShort : copy.showExplorerShort}
            type="button"
          >
            {explorerOpen ? <IconChevronLeft size={21} /> : <IconChevronRight size={21} />}
          </button>
          <Suspense fallback={<div className="map-loading"><Text>{copy.loadingMap}</Text></div>}>
            <MapView
              activityChanges={activityChanges}
              comparing={comparing}
              connection={live.connection}
              dataError={live.error}
              initialCamera={camera}
              key={`${mapBackground}-${locale}`}
              liveUpdate={displayedUpdate}
              locating={locating}
              mapBackground={mapBackground}
              mapMode={mode === "replay" ? comparing ? "heatmap" : "stations" : mapMode}
              mode={mode}
              onCameraChange={changeCamera}
              onLocate={locate}
              onSelect={selectStation}
              selected={selected}
              selectionFocus={selectionFocus}
              sourceUpdatedAt={presentedData?.sourceUpdatedAt ?? null}
              stations={visibleStations}
              userLocation={userLocation}
            />
          </Suspense>
          <ReplayControls
            compact={selected !== null}
            comparison={comparisonValue}
            frameCount={replay.data?.frames.length ?? (snapshot.data === null ? 0 : 1)}
            latestAt={live.data?.sourceUpdatedAt ?? null}
            loading={archiveLoading}
            mapMode={mapMode}
            mode={mode}
            onComparisonChange={changeComparison}
            onMapModeChange={setMapMode}
            onModeChange={changeMode}
            onPlayingChange={changePlaying}
            onSelectedAtChange={selectArchiveAt}
            onShare={share}
            onSpeedChange={setPlaybackSpeed}
            onTimelineModeChange={changeTimelineMode}
            playbackLoading={playbackRequested && replay.loading}
            playing={playing || playbackRequested}
            selectedAt={selectedArchiveAt}
            shareConfirmed={shareConfirmed}
            speed={playbackSpeed}
            timelineMode={timelineMode}
          />
          {stations.length === 0 && (
            <DataStateOverlay
              actionLabel={mode === "replay" ? copy.returnLive : messages.common.retry}
              error={mode === "replay" ? archiveError : live.error}
              loading={mode === "replay" ? archiveLoading : live.loading}
              message={mode === "replay"
                ? copy.archiveMissingHint
                : undefined}
              onRefresh={mode === "replay" ? () => changeMode("live") : live.refresh}
              title={mode === "replay" ? copy.archiveMissing : undefined}
            />
          )}
          {selected && (
            <Suspense fallback={null}>
              <StationDetails
                comparison={selectedComparison}
                history={mode === "live" ? history.data : null}
                historyEnabled={mode === "live"}
                historyError={mode === "live" ? history.error : null}
                historyLoading={mode === "live" && history.loading}
                nearby={nearby}
                onClose={() => setSelectedCode(null)}
                onMobileCloseFocus={() => mobileMapButtonRef.current?.focus()}
                onRangeChange={setRange}
                onSelect={selectStation}
                range={range}
                station={selected}
                trend={selectedTrend}
                variation={selectedVariation}
                variationLabel={comparing ? copy.balance : mode === "replay" ? copy.replayVariation : copy.liveVariation}
              />
            </Suspense>
          )}
        </div>
      </main>

      <div className="mobile-view-switcher">
        <div className="view-switcher-control" role="group" aria-label={copy.chooseView}>
          {viewOptions.map((option) => (
            <button
              aria-pressed={mobileView === option.value}
              data-active={mobileView === option.value || undefined}
              key={option.value}
              onClick={() => setMobileView(option.value)}
              ref={option.value === "map" ? mobileMapButtonRef : undefined}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {!access.verified && (
        <TurnstileGate
          checked={access.checked}
          error={access.error}
          onRetry={access.retry}
          onToken={access.verify}
          siteKey={access.siteKey}
        />
      )}

      <Text className="sr-only" aria-live="polite">
        {selected ? copy.selectedStation(selected.name) : copy.noSelectedStation}
      </Text>
    </div>
  )
}

import { ActionIcon, Badge, Group, Text, Tooltip } from "@mantine/core"
import {
  IconActivityHeartbeat,
  IconBike,
  IconBolt,
  IconCurrentLocation,
  IconMapPinFilled,
  IconParking,
} from "@tabler/icons-react"
import type { FeatureCollection, Point } from "geojson"
import { GeoJSONSource, Map, Marker, NavigationControl } from "maplibre-gl"
import type { MapLayerMouseEvent, StyleSpecification } from "maplibre-gl"
import { useEffect, useRef, useState } from "react"
import { availabilityBins, availabilityMarkerKey } from "../marker-style"
import type {
  DataMode,
  LiveStationChange,
  LiveUpdate,
  MapCamera,
  MapMode,
  Station,
  UserLocation,
} from "../types"
import { stationStatus } from "../types"

interface MapViewProps {
  readonly stations: readonly Station[]
  readonly selected: Station | null
  readonly selectionFocus: number
  readonly userLocation: UserLocation | null
  readonly locating: boolean
  readonly liveUpdate: LiveUpdate | null
  readonly activityChanges: readonly LiveStationChange[]
  readonly mode: DataMode
  readonly mapMode: MapMode
  readonly initialCamera: MapCamera
  readonly onCameraChange: (camera: MapCamera) => void
  readonly onSelect: (station: Station) => void
  readonly onLocate: () => void
}

type LiveChangeDirection = "up" | "down" | "neutral"

interface VariationMapProperties {
  readonly code: string
  readonly direction: LiveChangeDirection
  readonly weight: number
}

interface StationMapProperties {
  readonly code: string
  readonly capacity: number
  readonly mechanical: number
  readonly electric: number
  readonly docks: number
  readonly status: string
  readonly availabilityMarker: string
}

const sourceData = (
  stations: readonly Station[],
): FeatureCollection<Point, StationMapProperties> => ({
  type: "FeatureCollection",
  features: stations.map((station) => ({
    type: "Feature",
    id: station.code,
    geometry: {
      type: "Point",
      coordinates: [station.longitude, station.latitude],
    },
    properties: {
      code: station.code,
      capacity: station.capacity,
      mechanical: station.mechanical,
      electric: station.electric,
      docks: station.docks,
      status: stationStatus(station),
      availabilityMarker: availabilityMarkerKey(station),
    },
  })),
})

const variationSourceData = (
  stations: readonly Station[],
  changes: readonly LiveStationChange[],
): FeatureCollection<Point, VariationMapProperties> => {
  const changesByCode = new globalThis.Map(
    changes.map((change) => [change.code, change]),
  )
  const features: FeatureCollection<Point, VariationMapProperties>["features"] = []
  for (const station of stations) {
    const change = changesByCode.get(station.code)
    const delta = change === undefined
      ? 0
      : change.mechanicalDelta + change.electricDelta
    const weight = Math.abs(delta)
    features.push({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [station.longitude, station.latitude],
      },
      properties: {
        code: station.code,
        direction: directionFrom(delta),
        weight,
      },
    })
  }
  return { type: "FeatureCollection", features }
}

const directionFrom = (delta: number): LiveChangeDirection => {
  if (delta > 0) return "up"
  if (delta < 0) return "down"
  return "neutral"
}

interface MarkerSegment {
  readonly units: number
  readonly color: string
}

const addAvailabilityMarkerImage = (
  map: Map,
  name: string,
  segments: readonly MarkerSegment[],
): void => {
  if (map.hasImage(name)) return
  const canvas = document.createElement("canvas")
  canvas.width = 64
  canvas.height = 64
  const context = canvas.getContext("2d")
  if (context === null) return

  context.beginPath()
  context.arc(32, 32, 27, 0, Math.PI * 2)
  context.fillStyle = "#e8594f"
  context.fill()

  let start = -Math.PI / 2
  for (const segment of segments) {
    if (segment.units === 0) continue
    const end = start + (segment.units / 10) * Math.PI * 2
    context.beginPath()
    context.moveTo(32, 32)
    context.arc(32, 32, 27, start, end)
    context.closePath()
    context.fillStyle = segment.color
    context.fill()
    start = end
  }

  context.beginPath()
  context.arc(32, 32, 28, 0, Math.PI * 2)
  context.lineWidth = 3
  context.strokeStyle = "#ffffff"
  context.stroke()

  map.addImage(name, context.getImageData(0, 0, 64, 64), { pixelRatio: 2 })
}

const addAvailabilityMarkerImages = (
  map: Map,
  stations: readonly Station[],
): void => {
  const added = new Set<string>()
  for (const station of stations) {
    const name = availabilityMarkerKey(station)
    if (added.has(name)) continue
    added.add(name)
    const bins = availabilityBins(station)
    addAvailabilityMarkerImage(
      map,
      name,
      [
        { units: bins.mechanical, color: "#27c196" },
        { units: bins.electric, color: "#2484fd" },
        { units: bins.docks, color: "#aeb6c3" },
      ],
    )
  }
}

const mapStyle: StyleSpecification = {
  version: 8,
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
  sources: {
    carto: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
        "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
      ],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a> · Données <a href="https://www.velib-metropole.fr/donnees-open-data-gbfs-du-service-velib-metropole">Vélib’ Métropole</a> (<a href="https://www.etalab.gouv.fr/licence-ouverte-open-licence/">Licence Ouverte</a>) · service non officiel',
    },
  },
  layers: [{ id: "carto", type: "raster", source: "carto" }],
}

export const MapView = ({
  stations,
  selected,
  selectionFocus,
  userLocation,
  locating,
  liveUpdate,
  activityChanges,
  mode,
  mapMode,
  initialCamera,
  onCameraChange,
  onSelect,
  onLocate,
}: MapViewProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const userMarkerRef = useRef<Marker | null>(null)
  const rippleMarkersRef = useRef<ReadonlyArray<Marker>>([])
  const selectedCodeRef = useRef<string | null>(null)
  const [showBikeBreakdown, setShowBikeBreakdown] = useState(initialCamera.zoom >= 14)
  const [visibleChangeCount, setVisibleChangeCount] = useState(0)
  const stationsRef = useRef(stations)
  const selectRef = useRef(onSelect)
  const cameraChangeRef = useRef(onCameraChange)

  stationsRef.current = stations
  selectRef.current = onSelect
  cameraChangeRef.current = onCameraChange

  useEffect(() => {
    if (!containerRef.current) return

    const map = new Map({
      container: containerRef.current,
      style: mapStyle,
      center: [initialCamera.longitude, initialCamera.latitude],
      zoom: initialCamera.zoom,
      minZoom: 9,
      maxZoom: 19,
      attributionControl: {},
    })
    map.addControl(new NavigationControl({ showCompass: false }), "bottom-right")
    mapRef.current = map

    map.on("load", () => {
      map.addSource("stations", {
        type: "geojson",
        data: sourceData(stationsRef.current),
      })
      map.addSource("variations", {
        type: "geojson",
        data: variationSourceData(stationsRef.current, []),
      })
      addAvailabilityMarkerImages(map, stationsRef.current)
      map.addLayer({
        id: "station-availability-markers",
        type: "symbol",
        source: "stations",
        maxzoom: 14,
        layout: {
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "icon-image": ["get", "availabilityMarker"],
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            9,
            ["interpolate", ["linear"], ["get", "capacity"], 5, 0.2, 10, 0.28, 20, 0.42, 40, 0.65, 70, 0.9],
            12,
            ["interpolate", ["linear"], ["get", "capacity"], 5, 0.28, 10, 0.38, 20, 0.56, 40, 0.86, 70, 1.2],
            14,
            ["interpolate", ["linear"], ["get", "capacity"], 5, 0.38, 10, 0.5, 20, 0.72, 40, 1.1, 70, 1.55],
          ],
        },
        paint: {
          "icon-opacity": ["case", ["==", ["get", "status"], "unavailable"], 0.48, 0.95],
        },
      })

      map.addLayer({
        id: "station-overview-selection",
        type: "circle",
        source: "stations",
        maxzoom: 14,
        paint: {
          "circle-color": "rgba(255,255,255,0)",
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            9,
            ["interpolate", ["linear"], ["get", "capacity"], 5, 5, 10, 6, 20, 8, 40, 11, 70, 16],
            14,
            ["interpolate", ["linear"], ["get", "capacity"], 5, 9, 10, 11, 20, 15, 40, 21, 70, 28],
          ],
          "circle-stroke-color": "#2484fd",
          "circle-stroke-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            1,
            0,
          ],
          "circle-stroke-width": 3,
        },
      })

      map.addLayer({
        id: "station-mechanical-badge",
        type: "circle",
        source: "stations",
        minzoom: 14,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "#27c196",
          "circle-opacity": ["case", ["==", ["get", "status"], "unavailable"], 0.65, 1],
          "circle-radius": 11,
          "circle-stroke-color": [
            "case",
            ["==", ["get", "mechanical"], 0],
            "#e8594f",
            ["<=", ["get", "mechanical"], 2],
            "#e8793f",
            "#ffffff",
          ],
          "circle-stroke-width": ["case", ["<=", ["get", "mechanical"], 2], 3, 2],
          "circle-translate": [-22, 0],
        },
      })

      map.addLayer({
        id: "station-electric-badge",
        type: "circle",
        source: "stations",
        minzoom: 14,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "#2484fd",
          "circle-opacity": ["case", ["==", ["get", "status"], "unavailable"], 0.65, 1],
          "circle-radius": 11,
          "circle-stroke-color": [
            "case",
            ["==", ["get", "electric"], 0],
            "#e8594f",
            ["<=", ["get", "electric"], 2],
            "#e8793f",
            "#ffffff",
          ],
          "circle-stroke-width": ["case", ["<=", ["get", "electric"], 2], 3, 2],
          "circle-translate": [0, 0],
        },
      })

      map.addLayer({
        id: "station-docks-badge",
        type: "circle",
        source: "stations",
        minzoom: 14,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": "#8a94a6",
          "circle-opacity": ["case", ["==", ["get", "status"], "unavailable"], 0.65, 1],
          "circle-radius": 11,
          "circle-stroke-color": [
            "case",
            ["==", ["get", "docks"], 0],
            "#e8594f",
            ["<=", ["get", "docks"], 2],
            "#e8793f",
            "#ffffff",
          ],
          "circle-stroke-width": ["case", ["<=", ["get", "docks"], 2], 3, 2],
          "circle-translate": [22, 0],
        },
      })

      map.addLayer({
        id: "station-mechanical-count",
        type: "symbol",
        source: "stations",
        minzoom: 14,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-allow-overlap": true,
          "text-field": ["to-string", ["get", "mechanical"]],
          "text-font": ["Open Sans Bold"],
          "text-ignore-placement": true,
          "text-size": 10,
        },
        paint: {
          "text-color": "#ffffff",
          "text-translate": [-22, 0],
        },
      })

      map.addLayer({
        id: "station-electric-count",
        type: "symbol",
        source: "stations",
        minzoom: 14,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-allow-overlap": true,
          "text-field": ["to-string", ["get", "electric"]],
          "text-font": ["Open Sans Bold"],
          "text-ignore-placement": true,
          "text-size": 10,
        },
        paint: {
          "text-color": "#ffffff",
          "text-translate": [0, 0],
        },
      })

      map.addLayer({
        id: "station-docks-count",
        type: "symbol",
        source: "stations",
        minzoom: 14,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "text-allow-overlap": true,
          "text-field": ["to-string", ["get", "docks"]],
          "text-font": ["Open Sans Bold"],
          "text-ignore-placement": true,
          "text-size": 10,
        },
        paint: {
          "text-color": "#ffffff",
          "text-translate": [22, 0],
        },
      })

      map.addLayer({
        id: "station-hit-target",
        type: "circle",
        source: "stations",
        paint: {
          "circle-color": "#ffffff",
          "circle-opacity": 0.001,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 8, 14, 35],
          "circle-stroke-width": 0,
        },
      })

      map.addLayer({
        id: "variation-loss-heatmap",
        type: "heatmap",
        source: "variations",
        maxzoom: 17,
        filter: ["==", ["get", "direction"], "down"],
        layout: { visibility: "none" },
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["get", "weight"], 1, 0.25, 12, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 9, 0.7, 16, 1.5],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 18, 16, 38],
          "heatmap-opacity": 0.74,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(232,89,79,0)",
            0.35,
            "rgba(232,89,79,0.24)",
            0.7,
            "rgba(232,89,79,0.48)",
            1,
            "rgba(190,48,67,0.76)",
          ],
        },
      })
      map.addLayer({
        id: "variation-gain-heatmap",
        type: "heatmap",
        source: "variations",
        maxzoom: 17,
        filter: ["==", ["get", "direction"], "up"],
        layout: { visibility: "none" },
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["get", "weight"], 1, 0.25, 12, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 9, 0.7, 16, 1.5],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 18, 16, 38],
          "heatmap-opacity": 0.74,
          "heatmap-color": [
            "interpolate",
            ["linear"],
            ["heatmap-density"],
            0,
            "rgba(39,193,150,0)",
            0.35,
            "rgba(39,193,150,0.22)",
            0.7,
            "rgba(39,193,150,0.46)",
            1,
            "rgba(7,132,104,0.76)",
          ],
        },
      })
      map.addLayer({
        id: "variation-neutral-points",
        type: "circle",
        source: "variations",
        filter: ["==", ["get", "direction"], "neutral"],
        layout: { visibility: "none" },
        paint: {
          "circle-color": "#718096",
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2, 14, 3.5, 17, 5],
          "circle-opacity": 0.38,
          "circle-stroke-color": "rgba(255,255,255,0.8)",
          "circle-stroke-width": 0.75,
        },
      })
      map.addLayer({
        id: "variation-points",
        type: "circle",
        source: "variations",
        filter: [">", ["get", "weight"], 0],
        layout: { visibility: "none" },
        paint: {
          "circle-color": [
            "match",
            ["get", "direction"],
            "up",
            "#149b78",
            "down",
            "rgba(255,255,255,0.92)",
            "#2484fd",
          ],
          "circle-radius": ["interpolate", ["linear"], ["get", "weight"], 1, 4, 12, 10],
          "circle-opacity": 0.78,
          "circle-stroke-color": [
            "match",
            ["get", "direction"],
            "down",
            "#d94b43",
            "#ffffff",
          ],
          "circle-stroke-width": [
            "match",
            ["get", "direction"],
            "down",
            2.5,
            1.5,
          ],
        },
      })
    })

    const selectStationFromMap = (event: MapLayerMouseEvent) => {
      let closestCode: string | null = null
      let closestDistance = Number.POSITIVE_INFINITY
      for (const feature of event.features ?? []) {
        if (feature.geometry.type !== "Point") continue
        const [longitude, latitude] = feature.geometry.coordinates
        if (longitude === undefined || latitude === undefined) continue
        const point = map.project([longitude, latitude])
        const distance = Math.hypot(point.x - event.point.x, point.y - event.point.y)
        if (distance >= closestDistance) continue
        const code = feature.properties.code
        if (typeof code !== "string" && typeof code !== "number") continue
        closestCode = String(code)
        closestDistance = distance
      }
      if (closestCode === null) return
      const station = stationsRef.current.find((candidate) => candidate.code === closestCode)
      if (station) selectRef.current(station)
    }
    const stationLayers = [
      "station-hit-target",
      "variation-neutral-points",
      "variation-points",
    ]
    for (const layer of stationLayers) {
      map.on("click", layer, selectStationFromMap)
    }

    map.on("zoomend", () => {
      setShowBikeBreakdown(map.getZoom() >= 14)
    })
    map.on("moveend", () => {
      const center = map.getCenter()
      cameraChangeRef.current({
        latitude: center.lat,
        longitude: center.lng,
        zoom: map.getZoom(),
      })
    })

    const interactiveLayers = stationLayers
    for (const layer of interactiveLayers) {
      map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer" })
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = "" })
    }

    const observer = new ResizeObserver(() => map.resize())
    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const update = () => {
      const source = map.getSource("stations")
      if (source instanceof GeoJSONSource) {
        addAvailabilityMarkerImages(map, stations)
        source.setData(sourceData(stations))
      }
    }

    if (map.loaded()) update()
    else map.once("load", update)
  }, [stations])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const update = () => {
      const source = map.getSource("variations")
      if (source instanceof GeoJSONSource) {
        source.setData(variationSourceData(stations, activityChanges))
      }
    }

    if (map.loaded()) update()
    else map.once("load", update)
  }, [activityChanges, stations])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const update = () => {
      const stationsVisible = mapMode === "stations"
      const stationVisibility = stationsVisible ? "visible" : "none"
      const variationVisibility = mapMode === "heatmap" ? "visible" : "none"
      for (const layer of [
        "station-availability-markers",
        "station-overview-selection",
        "station-hit-target",
        "station-mechanical-badge",
        "station-electric-badge",
        "station-docks-badge",
        "station-mechanical-count",
        "station-electric-count",
        "station-docks-count",
      ]) {
        map.setLayoutProperty(layer, "visibility", stationVisibility)
      }
      for (const layer of [
        "variation-loss-heatmap",
        "variation-gain-heatmap",
        "variation-neutral-points",
        "variation-points",
      ]) {
        map.setLayoutProperty(layer, "visibility", variationVisibility)
      }
    }

    if (map.loaded()) update()
    else map.once("load", update)
  }, [mapMode])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const updateSelection = () => {
      const previousCode = selectedCodeRef.current
      if (previousCode !== null) {
        map.setFeatureState({ source: "stations", id: previousCode }, { selected: false })
      }
      if (selected !== null) {
        map.setFeatureState({ source: "stations", id: selected.code }, { selected: true })
      }
      selectedCodeRef.current = selected?.code ?? null
    }

    if (map.loaded()) updateSelection()
    else map.once("load", updateSelection)
  }, [selected?.code])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !selected || selectionFocus === 0) return
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    map.flyTo({
      center: [selected.longitude, selected.latitude],
      zoom: Math.max(map.getZoom(), 15),
      duration: reduceMotion ? 0 : 350,
      essential: false,
      padding: { right: window.innerWidth > 1100 ? 430 : 0 },
    })
  }, [selected?.code, selectionFocus])

  useEffect(() => {
    const map = mapRef.current
    if (
      !map ||
      mapMode !== "stations" ||
      liveUpdate === null ||
      liveUpdate.changes.length === 0
    ) return

    for (const marker of rippleMarkersRef.current) marker.remove()
    rippleMarkersRef.current = []

    const bounds = map.getBounds()
    const stationsByCode = new globalThis.Map(
      stationsRef.current.map((station) => [station.code, station])
    )
    const visibleChanges = liveUpdate.changes
      .map((change) => ({ change, station: stationsByCode.get(change.code) }))
      .filter(({ station }) =>
        station !== undefined && bounds.contains([station.longitude, station.latitude])
      )
      .sort((left, right) => {
        const leftMagnitude = Math.abs(left.change.mechanicalDelta) +
          Math.abs(left.change.electricDelta) + Math.abs(left.change.docksDelta)
        const rightMagnitude = Math.abs(right.change.mechanicalDelta) +
          Math.abs(right.change.electricDelta) + Math.abs(right.change.docksDelta)
        return rightMagnitude - leftMagnitude
      })

    setVisibleChangeCount(visibleChanges.length)
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return

    const markers: Array<Marker> = []
    let deltaLabelCount = 0
    for (const { change, station } of visibleChanges.slice(0, 40)) {
      if (station === undefined) continue
      const element = document.createElement("div")
      element.className = "station-live-ripple-marker"
      element.setAttribute("aria-hidden", "true")
      const bikeDelta = change.mechanicalDelta + change.electricDelta
      const direction = directionFrom(bikeDelta)
      const ring = document.createElement("span")
      ring.className = "station-live-ripple"
      ring.dataset.direction = direction
      element.appendChild(ring)

      if (bikeDelta !== 0 && deltaLabelCount < 24) {
        const delta = document.createElement("span")
        delta.className = "station-live-delta"
        delta.dataset.direction = direction
        delta.textContent = `${bikeDelta > 0 ? "+" : "−"}${Math.abs(bikeDelta)}`
        element.appendChild(delta)
        deltaLabelCount += 1
      }

      markers.push(
        new Marker({ element, anchor: "center" })
          .setLngLat([station.longitude, station.latitude])
          .addTo(map)
      )
    }
    rippleMarkersRef.current = markers

    const clearTimer = window.setTimeout(() => {
      for (const marker of markers) marker.remove()
      if (rippleMarkersRef.current === markers) rippleMarkersRef.current = []
    }, 10_200)

    return () => {
      window.clearTimeout(clearTimer)
      for (const marker of markers) marker.remove()
    }
  }, [liveUpdate, mapMode])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    userMarkerRef.current?.remove()
    userMarkerRef.current = null
    if (!userLocation) return

    const marker = document.createElement("div")
    marker.className = "user-location-marker"
    marker.setAttribute("aria-label", "Votre position")
    userMarkerRef.current = new Marker({ element: marker })
      .setLngLat([userLocation.longitude, userLocation.latitude])
      .addTo(map)

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    map.flyTo({
      center: [userLocation.longitude, userLocation.latitude],
      zoom: Math.max(map.getZoom(), 14),
      duration: reduceMotion ? 0 : 500,
      essential: false,
    })
  }, [userLocation])

  return (
    <section
      aria-label="Carte des stations Vélib’. Utilisez la liste pour une navigation complète au clavier."
      className="map-shell"
      data-mode={mode}
    >
      <div className="map-canvas" ref={containerRef} />
      <div className="map-caption">
        <Group gap={10} wrap="nowrap">
          <IconMapPinFilled size={22} />
          <div>
            <Text fw={800}>
              {mapMode === "heatmap" ? "Variations de disponibilité" : "Stations Vélib’"}
            </Text>
            <Text c="dimmed" size="sm">
              {mapMode === "heatmap"
                ? `${activityChanges.length} stations avec variation`
                : `${stations.length} affichées`}
            </Text>
          </div>
        </Group>
      </div>
      {liveUpdate && liveUpdate.changes.length > 0 && (
        <div
          className="live-map-update"
          key={liveUpdate.sourceUpdatedAt}
          role={mode === "live" ? "status" : undefined}
        >
          <IconActivityHeartbeat size={19} />
          <span>
            <strong>{liveUpdate.changes.length}</strong>{" "}
            station{liveUpdate.changes.length > 1 ? "s" : ""}{" "}
            {mode === "replay" ? "rejouée" : "actualisée"}{liveUpdate.changes.length > 1 ? "s" : ""}
            <small>
              {visibleChangeCount > 0
                ? `${visibleChangeCount} visible${visibleChangeCount > 1 ? "s" : ""} ici`
                : "aucune dans cette vue"}
            </small>
          </span>
        </div>
      )}
      <div className="map-legend" aria-label="Légende de la carte">
        {mapMode === "heatmap" ? (
          <>
            <span><i className="legend-gradient legend-gradient--gain" />Disponibilité en hausse</span>
            <span><i className="legend-gradient legend-gradient--loss" />Disponibilité en baisse</span>
            <span><i className="legend-dot legend-dot--neutral" />Sans variation</span>
            <span className="legend-hint">Intensité selon les variations cumulées</span>
          </>
        ) : showBikeBreakdown ? (
          <>
            <span><IconBike size={15} className="legend-icon legend-icon--mechanical" />Mécaniques</span>
            <span><IconBolt size={15} className="legend-icon legend-icon--electric" />Électriques</span>
            <span><IconParking size={15} className="legend-icon legend-icon--docks" />Places</span>
            <span><i className="legend-ring legend-ring--docks" />Peu de places</span>
            <span className="legend-hint">Contour orange = faible · rouge = aucun</span>
          </>
        ) : (
          <>
            <span><i className="legend-dot legend-dot--available" />Mécaniques</span>
            <span><i className="legend-dot legend-dot--electric" />Électriques</span>
            <span><i className="legend-dot legend-dot--free-docks" />Places libres</span>
            <span><i className="legend-dot legend-dot--empty" />Capacité indisponible</span>
            <span className="legend-hint">Disque proportionnel · diamètre selon la capacité totale</span>
          </>
        )}
      </div>
      <Tooltip label="Trouver les stations autour de moi" position="left">
        <ActionIcon
          aria-label="Trouver les stations autour de moi"
          className="locate-button"
          loading={locating}
          onClick={onLocate}
          color="blue"
          radius="xl"
          size="xl"
        >
          <IconCurrentLocation size={22} />
        </ActionIcon>
      </Tooltip>
      {userLocation && (
        <Badge className="nearby-badge" color="blue" size="lg" variant="filled">Triées par proximité</Badge>
      )}
    </section>
  )
}

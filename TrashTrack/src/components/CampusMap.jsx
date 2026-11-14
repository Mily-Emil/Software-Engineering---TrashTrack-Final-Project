// Komponen Peta Resmi Google Maps JavaScript API (@vis.gl/react-google-maps)
// Menampilkan peta Kampus Universitas Klabat (Unklab) dengan poligon batas kampus (UNKLAB_POLYGON)
// serta AdvancedMarker untuk titik laporan sampah dan pemilih lokasi.
import { useEffect, useState } from 'react'
import { APIProvider, AdvancedMarker, Map, useMap, useMapsLibrary } from '@vis.gl/react-google-maps'
import { MAP_VIEW_BOUNDS, UNKLAB_CENTER, UNKLAB_POLYGON } from '../lib/ai'

export const GOOGLE_MAPS_API_KEY = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim()
export const GOOGLE_MAPS_MAP_ID = (import.meta.env.VITE_GOOGLE_MAPS_MAP_ID || 'DEMO_MAP_ID').trim()

export function statusPinClass(status) {
  if (status === 'Menunggu') return 'waiting'
  if (status === 'Diproses') return 'progress'
  if (status === 'Ditolak') return 'rejected'
  return 'done'
}

// Komponen Poligon Batas Kampus Universitas Klabat (7 titik perimeter kampus)
function CampusBoundaryPolygon({ isHybrid, fillOpacity = 0.06 }) {
  const map = useMap()
  const mapsLib = useMapsLibrary('maps')

  useEffect(() => {
    if (!map || !mapsLib) return
    const strokeColor = isHybrid ? '#4ade80' : '#1b6943'
    const polygon = new mapsLib.Polygon({
      paths: UNKLAB_POLYGON,
      strokeColor,
      strokeOpacity: 0.92,
      strokeWeight: 2.5,
      fillColor: strokeColor,
      fillOpacity,
      clickable: false,
      map
    })
    return () => {
      polygon.setMap(null)
    }
  }, [map, mapsLib, isHybrid, fillOpacity])

  return null
}

export function GoogleMapsProvider({ children }) {
  if (!GOOGLE_MAPS_API_KEY) {
    return children
  }
  return <APIProvider apiKey={GOOGLE_MAPS_API_KEY}>{children}</APIProvider>
}

export default function CampusGoogleMap({
  className = '',
  reports = [],
  onMarkerClick,
  interactive = true,
  onPick,
  pickPosition,
  fillOpacity = 0.06,
  showControls = true
}) {
  // 'm' = Google Maps Standard Roadmap | 'y' = Google Maps Hybrid (Satelit + Label Gedung)
  const [layerType, setLayerType] = useState('m')
  const mapTypeId = layerType === 'y' ? 'hybrid' : 'roadmap'

  const handleMapClick = event => {
    if (!onPick) return
    const latLng = event?.detail?.latLng
    if (latLng && typeof latLng.lat === 'number' && typeof latLng.lng === 'number') {
      onPick({ latitude: latLng.lat, longitude: latLng.lng })
    }
  }

  return (
    <div className={`gmap-wrap ${className}`}>
      {showControls && (
        <div className="gmap-type-toggle" role="group" aria-label="Tipe tampilan Google Maps">
          <button
            type="button"
            className={layerType === 'm' ? 'active' : ''}
            onClick={e => {
              e.stopPropagation()
              setLayerType('m')
            }}
          >
            Peta
          </button>
          <button
            type="button"
            className={layerType === 'y' ? 'active' : ''}
            onClick={e => {
              e.stopPropagation()
              setLayerType('y')
            }}
          >
            Satelit
          </button>
        </div>
      )}

      <Map
        defaultCenter={{ lat: UNKLAB_CENTER[0], lng: UNKLAB_CENTER[1] }}
        defaultZoom={16}
        minZoom={14}
        maxZoom={20}
        mapId={GOOGLE_MAPS_MAP_ID}
        mapTypeId={mapTypeId}
        gestureHandling={interactive ? 'greedy' : 'cooperative'}
        disableDefaultUI={!interactive}
        mapTypeControl={false}
        streetViewControl={false}
        fullscreenControl={interactive}
        zoomControl={interactive}
        clickableIcons={false}
        restriction={{
          latLngBounds: {
            south: MAP_VIEW_BOUNDS[0][0],
            west: MAP_VIEW_BOUNDS[0][1],
            north: MAP_VIEW_BOUNDS[1][0],
            east: MAP_VIEW_BOUNDS[1][1]
          },
          strictBounds: false
        }}
        onClick={handleMapClick}
        className="gmap-leaflet-inner"
        style={{ width: '100%', height: '100%' }}
      >
        <CampusBoundaryPolygon isHybrid={layerType === 'y'} fillOpacity={fillOpacity} />

        {reports.map(r => (
          <AdvancedMarker
            key={r.id || r.report_code}
            position={{ lat: Number(r.latitude), lng: Number(r.longitude) }}
            onClick={() => onMarkerClick && onMarkerClick(r)}
            title={`${r.report_code} (${r.status})`}
          >
            <div className={`pin pin-${statusPinClass(r.status)}`}>
              <span />
            </div>
          </AdvancedMarker>
        ))}

        {pickPosition && (
          <AdvancedMarker
            position={{ lat: Number(pickPosition.latitude), lng: Number(pickPosition.longitude) }}
            title="Titik lokasi laporan"
          >
            <div className="pin pin-picked">
              <span />
            </div>
          </AdvancedMarker>
        )}
      </Map>

      <a
        className="gmap-badge"
        href={`https://www.google.com/maps/@${UNKLAB_CENTER[0]},${UNKLAB_CENTER[1]},17z`}
        target="_blank"
        rel="noreferrer"
        title="Buka lokasi Kampus Universitas Klabat di Google Maps"
      >
        <span className="gmap-dot" />
        Google Maps API
      </a>
    </div>
  )
}

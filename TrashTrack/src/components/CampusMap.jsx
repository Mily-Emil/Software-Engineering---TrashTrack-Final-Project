// Komponen Peta Google Maps Kampus Universitas Klabat (Unklab)
// Menampilkan tile Google Maps (Roadmap & Satelit Hybrid) yang up-to-date
// dengan tetap mempertahankan seluruh titik sampah, batas area kampus, dan fungsi sistem.
import { useState } from 'react'
import { MapContainer, Marker, Rectangle, TileLayer, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { MAP_VIEW_BOUNDS, UNKLAB_BOUNDS, UNKLAB_CENTER } from '../lib/ai'

export const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || ''

export const iconFor = status =>
  L.divIcon({
    className: '',
    html: `<div class="pin pin-${status === 'Menunggu' ? 'waiting' : status === 'Diproses' ? 'progress' : status === 'Ditolak' ? 'rejected' : 'done'}"><span></span></div>`,
    iconSize: [30, 38],
    iconAnchor: [15, 36]
  })

const pickedIcon = L.divIcon({
  className: '',
  html: `<div class="pin pin-picked"><span></span></div>`,
  iconSize: [30, 38],
  iconAnchor: [15, 36]
})

function MapClickHandler({ onPick }) {
  useMapEvents({
    click(e) {
      if (onPick) {
        onPick({ latitude: e.latlng.lat, longitude: e.latlng.lng })
      }
    }
  })
  return null
}

export function GoogleMapsProvider({ children }) {
  return children
}

export default function CampusGoogleMap({
  className = '',
  reports = [],
  onMarkerClick,
  interactive = true,
  onPick,
  pickPosition,
  fillOpacity = 0.05,
  showControls = true
}) {
  // 'm' = Google Maps Standard Roadmap (Jalan & Gedung Up-to-date)
  // 'y' = Google Maps Hybrid (Satelit + Nama Gedung & Jalan)
  const [layerType, setLayerType] = useState('m')

  const googleTileUrl =
    layerType === 'y'
      ? 'https://mt{s}.google.com/vt/lyrs=y&hl=id&x={x}&y={y}&z={z}'
      : 'https://mt{s}.google.com/vt/lyrs=m&hl=id&x={x}&y={y}&z={z}'

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

      <MapContainer
        center={UNKLAB_CENTER}
        zoom={16}
        maxZoom={20}
        maxBounds={MAP_VIEW_BOUNDS}
        maxBoundsViscosity={0.9}
        scrollWheelZoom={interactive}
        zoomControl={interactive}
        attributionControl={false}
        className="gmap-leaflet-inner"
      >
        <TileLayer
          key={layerType}
          url={googleTileUrl}
          subdomains={['0', '1', '2', '3']}
          maxZoom={20}
        />
        <Rectangle
          bounds={UNKLAB_BOUNDS}
          pathOptions={{
            color: layerType === 'y' ? '#4ade80' : '#2b6e46',
            weight: 2,
            dashArray: '6 4',
            fillOpacity
          }}
        />
        {onPick && <MapClickHandler onPick={onPick} />}
        {reports.map(r => (
          <Marker
            key={r.id || r.report_code}
            position={[Number(r.latitude), Number(r.longitude)]}
            icon={iconFor(r.status)}
            eventHandlers={
              onMarkerClick
                ? {
                    click: () => onMarkerClick(r)
                  }
                : undefined
            }
          />
        ))}
        {pickPosition && (
          <Marker
            position={[Number(pickPosition.latitude), Number(pickPosition.longitude)]}
            icon={pickedIcon}
          />
        )}
      </MapContainer>

      <a
        className="gmap-badge"
        href={`https://www.google.com/maps/@${UNKLAB_CENTER[0]},${UNKLAB_CENTER[1]},17z`}
        target="_blank"
        rel="noreferrer"
        title="Buka lokasi Kampus Universitas Klabat di Google Maps"
      >
        <span className="gmap-dot" />
        Google Maps
      </a>
    </div>
  )
}

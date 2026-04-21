import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { kml as kmlToGeoJSON } from '@tmcw/togeojson'
import shp from 'shpjs'
import { parquetRead, parquetMetadata } from 'hyparquet'
import {
  createColumnHelper,
  getCoreRowModel,
  getFilteredRowModel,
  createTable,
} from '@tanstack/table-core'

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dropZone        = document.getElementById('drop-zone')
const searchInput     = document.getElementById('search-input')
const tableContainer  = document.getElementById('table-container')
const statusEl        = document.getElementById('status')
const searchContainer = document.getElementById('search-container')
const basemapSelect   = document.getElementById('basemap-select')
const tomtomKeyInput  = document.getElementById('tomtom-key-input')

// ── Leaflet map ───────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([20, 0], 2)

const TILE_CONFIGS = {
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
      referrerPolicy: 'no-referrer',
    },
  },
  tomtom: (apiKey) => ({
    url: `https://api.tomtom.com/map/1/tile/basic/main/{z}/{x}/{y}.png?key=${apiKey}`,
    options: {
      attribution: '&copy; <a href="https://www.tomtom.com">TomTom</a>',
      maxZoom: 22,
      referrerPolicy: 'no-referrer',
    },
  }),
}

let baseTileLayer = null

function setBasemap(type) {
  if (baseTileLayer) { map.removeLayer(baseTileLayer); baseTileLayer = null }

  if (type === 'tomtom') {
    const key = tomtomKeyInput.value.trim()
    if (!key) return
    const { url, options } = TILE_CONFIGS.tomtom(key)
    baseTileLayer = L.tileLayer(url, options).addTo(map)
  } else {
    const { url, options } = TILE_CONFIGS.osm
    baseTileLayer = L.tileLayer(url, options).addTo(map)
  }
}

// Restore saved TomTom key and initialise OSM basemap
const savedKey = localStorage.getItem('tomtom_api_key')
if (savedKey) tomtomKeyInput.value = savedKey
setBasemap('osm')

basemapSelect.addEventListener('change', () => {
  const isTomTom = basemapSelect.value === 'tomtom'
  tomtomKeyInput.classList.toggle('hidden', !isTomTom)
  setBasemap(basemapSelect.value)
})

tomtomKeyInput.addEventListener('change', () => {
  localStorage.setItem('tomtom_api_key', tomtomKeyInput.value.trim())
  setBasemap('tomtom')
})

let geoLayer = null

function updateMap(geojson) {
  if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null }

  geoLayer = L.geoJSON(geojson, {
    pointToLayer: (_feature, latlng) =>
      L.circleMarker(latlng, {
        radius: 6,
        fillColor: '#3b82f6',
        color: '#1d4ed8',
        weight: 1.5,
        opacity: 1,
        fillOpacity: 0.85,
      }),
    style: {
      color: '#3b82f6',
      weight: 2,
      opacity: 0.9,
      fillColor: '#93c5fd',
      fillOpacity: 0.25,
    },
  }).addTo(map)

  const bounds = geoLayer.getBounds()
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 })
  }
}

// ── Table state ───────────────────────────────────────────────────────────────
let table      = null
let tableState = null

// createTable (vanilla JS) is fully-controlled — every feature reads from
// state directly, so all feature defaults must be present upfront.
function makeState(globalFilter = '') {
  return {
    globalFilter,
    columnFilters: [],
    columnOrder: [],
    columnPinning: { left: [], right: [] },
    columnSizing: {},
    columnSizingInfo: {
      startOffset: null,
      startSize: null,
      deltaOffset: null,
      deltaPercentage: null,
      isResizingColumn: false,
      columnSizingStart: [],
    },
    columnVisibility: {},
    expanded: {},
    grouping: [],
    pagination: { pageIndex: 0, pageSize: 10 },
    rowPinning: { top: [], bottom: [] },
    rowSelection: {},
    sorting: [],
  }
}

// ── Drag & Drop ───────────────────────────────────────────────────────────────
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropZone.style.borderColor = '#60a5fa'
  dropZone.style.backgroundColor = '#eff6ff'
})

dropZone.addEventListener('dragleave', () => {
  dropZone.style.borderColor = ''
  dropZone.style.backgroundColor = ''
})

dropZone.addEventListener('drop', (e) => {
  e.preventDefault()
  dropZone.style.borderColor = ''
  dropZone.style.backgroundColor = ''
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files)
})

// Allow multi-select for .shp + .dbf pairs
dropZone.addEventListener('click', () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = '.geojson,.json,.kml,.shp,.dbf,.parquet,application/geo+json,application/json'
  input.onchange = (e) => e.target.files.length && loadFiles(e.target.files)
  input.click()
})

searchInput.addEventListener('input', (e) => {
  table?.setGlobalFilter(e.target.value)
})

// ── File loading & format dispatch ────────────────────────────────────────────
async function loadFiles(fileList) {
  const files = Array.from(fileList)
  // Index by extension so .shp + .dbf can be found together
  const byExt = {}
  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase()
    byExt[ext] = f
  }

  showStatus('Loading…', 'info')

  let geojson
  try {
    if (byExt.geojson || byExt.json) {
      const text = await readAsText(byExt.geojson ?? byExt.json)
      geojson = JSON.parse(text)
    } else if (byExt.kml) {
      geojson = await parseKML(byExt.kml)
    } else if (byExt.shp) {
      geojson = await parseShapefile(byExt.shp, byExt.dbf ?? null)
    } else if (byExt.parquet) {
      geojson = await parseGeoParquet(byExt.parquet)
    } else {
      showStatus(
        'Unsupported format. Drop a .geojson, .kml, .shp (+ .dbf), or .parquet file.',
        'error'
      )
      return
    }
  } catch (err) {
    showStatus(`Failed to parse file: ${err.message}`, 'error')
    console.error(err)
    return
  }

  try {
    buildTable(geojson)
  } catch (err) {
    showStatus(`Error building table: ${err.message}`, 'error')
    console.error(err)
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function readAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = (e) => resolve(e.target.result)
    r.onerror = reject
    r.readAsText(file)
  })
}

function readAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = (e) => resolve(e.target.result)
    r.onerror = reject
    r.readAsArrayBuffer(file)
  })
}

// ── KML parser ────────────────────────────────────────────────────────────────
async function parseKML(file) {
  const text = await readAsText(file)
  const doc = new DOMParser().parseFromString(text, 'text/xml')
  if (doc.querySelector('parsererror')) throw new Error('Invalid KML/XML')
  return kmlToGeoJSON(doc)
}

// ── Shapefile parser (.shp + optional .dbf) ───────────────────────────────────
async function parseShapefile(shpFile, dbfFile) {
  const shpBuf = await readAsArrayBuffer(shpFile)

  if (dbfFile) {
    const dbfBuf = await readAsArrayBuffer(dbfFile)
    return shp.combine([shp.parseShp(shpBuf), shp.parseDbf(dbfBuf)])
  }

  // Geometry-only when no .dbf accompanies the .shp
  const geometries = shp.parseShp(shpBuf)
  return {
    type: 'FeatureCollection',
    features: geometries.map((geometry) => ({ type: 'Feature', geometry, properties: {} })),
  }
}

// ── GeoParquet parser ─────────────────────────────────────────────────────────
async function parseGeoParquet(file) {
  const arrayBuffer = await readAsArrayBuffer(file)

  // GeoParquet stores geometry metadata under the 'geo' key
  const meta = parquetMetadata(arrayBuffer)
  const geoMetaStr = meta.key_value_metadata?.find((kv) => kv.key === 'geo')?.value
  const geoMeta = geoMetaStr ? JSON.parse(geoMetaStr) : null
  const geomCol = geoMeta?.primary_column ?? 'geometry'

  // hyparquet requires an AsyncBuffer — wrap the in-memory ArrayBuffer
  const asyncBuffer = {
    byteLength: arrayBuffer.byteLength,
    slice: (start, end) => Promise.resolve(arrayBuffer.slice(start, end)),
  }

  let rows = []
  await parquetRead({
    file: asyncBuffer,
    metadata: meta,
    rowFormat: 'object',
    onComplete(data) { rows = data },
  })

  const features = rows
    .map((row) => {
      const geomVal = row[geomCol]
      let geometry = null

      if (geomVal instanceof Uint8Array) {
        // Standard GeoParquet: geometry stored as WKB binary
        try { geometry = wkbToGeoJSON(geomVal) } catch { /* skip malformed */ }
      } else if (geomVal && typeof geomVal === 'object' && typeof geomVal.type === 'string') {
        // Already a GeoJSON geometry object (e.g. pandas GeoDataFrame → pyarrow struct encoding)
        geometry = geomVal
      } else if (typeof geomVal === 'string') {
        // JSON-encoded geometry string or WKT — try JSON first
        try { geometry = JSON.parse(geomVal) } catch { /* not JSON, skip */ }
      }

      const properties = Object.fromEntries(
        Object.entries(row).filter(([k]) => k !== geomCol)
      )
      return { type: 'Feature', geometry, properties }
    })
    .filter((f) => f.geometry !== null)

  if (!features.length) throw new Error('No valid geometries found in Parquet file')
  return { type: 'FeatureCollection', features }
}

// ── WKB decoder (handles WKB + EWKB, all core geometry types) ─────────────────
function wkbToGeoJSON(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let pos = 0

  function readGeom() {
    const le = view.getUint8(pos++) === 1
    let type = view.getUint32(pos, le); pos += 4

    if (type & 0x20000000) pos += 4   // EWKB SRID present — skip 4 bytes
    type &= 0x0fffffff                 // strip Z/M/SRID flag bits

    const f64 = () => { const v = view.getFloat64(pos, le); pos += 8; return v }
    const u32 = () => { const v = view.getUint32(pos, le); pos += 4; return v }
    const pt  = () => [f64(), f64()]
    const ring = () => Array.from({ length: u32() }, pt)

    switch (type) {
      case 1: return { type: 'Point',              coordinates: pt() }
      case 2: return { type: 'LineString',          coordinates: ring() }
      case 3: return { type: 'Polygon',             coordinates: Array.from({ length: u32() }, ring) }
      case 4: return { type: 'MultiPoint',          coordinates: Array.from({ length: u32() }, () => readGeom().coordinates) }
      case 5: return { type: 'MultiLineString',     coordinates: Array.from({ length: u32() }, () => readGeom().coordinates) }
      case 6: return { type: 'MultiPolygon',        coordinates: Array.from({ length: u32() }, () => readGeom().coordinates) }
      case 7: return { type: 'GeometryCollection',  geometries:  Array.from({ length: u32() }, readGeom) }
      default: throw new Error(`Unsupported WKB geometry type: ${type}`)
    }
  }

  return readGeom()
}

// ── GeoJSON → TanStack table ──────────────────────────────────────────────────
function buildTable(geojson) {
  const features =
    geojson.type === 'FeatureCollection' ? geojson.features
    : geojson.type === 'Feature'         ? [geojson]
    : []

  if (!features.length) {
    showStatus('No features found in this file.', 'error')
    return
  }

  const slice    = features.slice(0, 10)
  const propKeys = [...new Set(slice.flatMap((f) => Object.keys(f.properties ?? {})))]

  const data = slice.map((f, i) => ({
    '#':      i + 1,
    Geometry: f.geometry?.type ?? '—',
    ...Object.fromEntries(propKeys.map((k) => [k, f.properties?.[k] ?? null])),
  }))

  const helper  = createColumnHelper()
  const allKeys = ['#', 'Geometry', ...propKeys]
  const columns = allKeys.map((key) => {
    const safeId = key.replace(/[^a-zA-Z0-9_-]/g, '_') || `col_${key}`
    return helper.accessor((row) => row[key], { id: safeId, header: key })
  })

  tableState        = makeState()
  searchInput.value = ''

  table = createTable({
    data,
    columns,
    state: tableState,
    onStateChange(updater) {
      tableState = typeof updater === 'function' ? updater(tableState) : updater
      table.setOptions((prev) => ({ ...prev, state: tableState }))
      renderTable()
    },
    getCoreRowModel:     getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, columnId, filterValue) => {
      const val = row.getValue(columnId)
      if (val === null || val === undefined) return false
      return String(val).toLowerCase().includes(String(filterValue).toLowerCase())
    },
    renderFallbackValue: null,
  })

  const total = features.length
  const ext   = geojson._sourceFormat ?? ''
  showStatus(
    `Loaded ${total} feature${total !== 1 ? 's' : ''}. Showing first ${slice.length}.`,
    'success'
  )
  searchContainer.classList.remove('hidden')
  renderTable()
  updateMap(geojson)
}

// ── Table renderer ────────────────────────────────────────────────────────────
function renderTable() {
  const headerGroups = table.getHeaderGroups()
  const rows         = table.getFilteredRowModel().rows
  const colSpan      = headerGroups[0]?.headers.length ?? 1

  const thead = headerGroups.map((hg) => `
    <tr>
      ${hg.headers.map((h) => `
        <th class="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap select-none">
          ${esc(String(h.column.columnDef.header))}
        </th>`).join('')}
    </tr>`).join('')

  const tbody = rows.length === 0
    ? `<tr><td colspan="${colSpan}" class="text-center py-8 text-sm text-gray-400">No matching rows</td></tr>`
    : rows.map((row, i) => `
        <tr class="${i % 2 === 0 ? 'bg-white' : 'bg-gray-50'} hover:bg-blue-50 transition-colors duration-75">
          ${row.getVisibleCells().map((cell) => {
            const raw     = cell.getValue()
            const display =
              raw === null || raw === undefined
                ? '<span class="text-gray-300 text-xs">null</span>'
                : typeof raw === 'object'
                  ? `<span class="font-mono text-xs text-gray-400">${esc(JSON.stringify(raw, (_k, v) => typeof v === 'bigint' ? v.toString() : v))}</span>`
                  : esc(String(raw))
            return `<td class="px-3 py-1.5 text-sm text-gray-700 max-w-[180px] truncate"
                        title="${esc(String(raw ?? ''))}">${display}</td>`
          }).join('')}
        </tr>`).join('')

  tableContainer.innerHTML = `
    <div class="overflow-x-auto rounded-lg border border-gray-200 shadow-sm">
      <table class="min-w-full bg-white">
        <thead class="bg-gray-100 border-b border-gray-200">${thead}</thead>
        <tbody class="divide-y divide-gray-100">${tbody}</tbody>
      </table>
    </div>
    <p class="text-xs text-gray-400 mt-2 text-right">
      ${rows.length} row${rows.length !== 1 ? 's' : ''} shown
    </p>`
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showStatus(msg, type) {
  statusEl.textContent = msg
  statusEl.className = [
    'mt-3 text-sm px-3 py-2 rounded-lg border',
    type === 'error'   ? 'bg-red-50 text-red-600 border-red-200'
    : type === 'info'  ? 'bg-blue-50 text-blue-600 border-blue-200'
    : /* success */      'bg-green-50 text-green-700 border-green-200',
  ].join(' ')
  statusEl.classList.remove('hidden')
}

function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

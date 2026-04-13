# GeoSpatial Helper

A Chrome Extension (Manifest V3) for inspecting geospatial files directly in the browser — no server, no upload, no dependencies beyond the extension itself.

Drop a file onto the popup to get an interactive Leaflet map (auto-zoomed to the data's bounding box) and a searchable TanStack Table showing the first 10 features.

---

## Features

- **Drag-and-drop or click-to-browse** file loading
- **Multi-format support** — GeoJSON, KML, Shapefile, GeoParquet
- **Interactive Leaflet map** — OpenStreetMap basemap, auto-fits to bounding box, points rendered as blue circle markers
- **Searchable table** — TanStack Table v8 with global filter across all property columns
- **First 10 features** shown in the table with all properties as columns
- **Geometry type column** auto-added (Point, LineString, Polygon, etc.)
- **Null-safe rendering** — null values shown as greyed `null`, nested objects as monospace JSON
- **Status banner** — success / error / loading states with colour coding
- Entirely **client-side** — files never leave the browser

---

## Supported Formats

| Format | Extension(s) | Library | Notes |
|---|---|---|---|
| GeoJSON | `.geojson`, `.json` | Native `JSON.parse` | FeatureCollection or single Feature |
| KML | `.kml` | `@tmcw/togeojson` | Converts via `DOMParser` |
| Shapefile | `.shp` + `.dbf` | `shpjs` | Drop both files together; `.dbf` optional (geometry-only fallback) |
| GeoParquet | `.parquet` | `hyparquet` | Handles WKB binary, pandas/pyarrow GeoJSON struct, and JSON-string encodings |

---

## Project Structure

```
chrome_plugin/
├── public/
│   └── manifest.json        # MV3 manifest
├── popup.html               # Extension popup shell
├── popup.js                 # All logic: parsers, map, table
├── style.css                # Tailwind CSS entry point
├── package.json
├── vite.config.js           # Vite build config with buffer polyfill
├── tailwind.config.js
├── postcss.config.js
└── dist/                    # Built extension — load this folder in Chrome
    ├── manifest.json
    ├── popup.html
    ├── popup.js
    └── popup.css
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Install & Build

```bash
npm install
npm run build
```

The built extension is output to `dist/`.

### Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder
5. Click the **GeoSpatial Helper** icon in the toolbar

### Development

```bash
npm run dev   # Vite dev server (for iterating on the popup UI in a browser tab)
npm run build # Production build to dist/
```

---

## Architecture

### Tech Stack

| Concern | Library | Version |
|---|---|---|
| Build tool | Vite | ^6.3 |
| Styling | Tailwind CSS | ^3.4 |
| Map | Leaflet.js | ^1.9 |
| Table (headless) | TanStack Table Core | ^8.20 |
| KML parsing | @tmcw/togeojson | ^5.8 |
| Shapefile parsing | shpjs | ^4.0 |
| Parquet parsing | hyparquet | ^1.8 |
| Node.js `buffer` shim | buffer | ^6.0 |

### How It Works

**File loading (`loadFiles`)**
All dropped or selected files are indexed by extension. The dispatcher routes to the correct parser:

```
.geojson / .json  → JSON.parse()
.kml              → DOMParser → @tmcw/togeojson kml()
.shp [+ .dbf]     → shpjs.parseShp() + shpjs.parseDbf() → shpjs.combine()
.parquet          → hyparquet parquetRead() → geometry detection
```

All parsers normalise their output to a GeoJSON `FeatureCollection` before calling `buildTable()`.

**GeoParquet geometry detection**

The parquet geometry column can arrive in three forms depending on how the file was written:

1. `Uint8Array` — standard WKB binary (official GeoParquet spec)
2. Plain object `{ type, coordinates }` — pandas/pyarrow GeoDataFrame struct encoding
3. JSON string — rare, handled via `JSON.parse`

A custom WKB decoder handles all 7 core geometry types (Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon, GeometryCollection) including EWKB with SRID prefix.

**TanStack Table (vanilla JS)**

`createTable` from `@tanstack/table-core` is the framework-agnostic core. In vanilla JS it requires a fully-controlled state object — all feature states (columnPinning, columnSizing, pagination, rowPinning, etc.) must be initialised upfront or the library throws. The `makeState()` factory provides all required defaults.

Global filter uses an inline function rather than the string-based registry lookup (`'includesString'`) to avoid silent failures.

**Leaflet map**

Initialised immediately on popup open (module scripts defer to DOMContentLoaded, so the `#map` div exists). On each file load:
- Previous layer is removed
- `L.geoJSON()` renders the full FeatureCollection
- `pointToLayer` → `L.circleMarker` with blue-500 fill for Point geometries
- Lines / Polygons use a blue theme style
- `layer.getBounds()` → `map.fitBounds()` zooms to the data

**Vite configuration**

`shpjs` depends on Node's `buffer` module which Vite 4+ externalises by default. Fixed via:
```js
resolve: { alias: { buffer: 'buffer' } }   // route to the 'buffer' npm polyfill
define:  { global: 'globalThis' }           // CJS packages that reference global
```

Rollup output uses flat `[name].[ext]` naming (no `assets/` subdirectory) so the manifest can reference `popup.html`, `popup.js`, and `popup.css` without path complexity.

---

## Known Limitations & Roadmap

| Item | Status |
|---|---|
| Only first 10 features shown in table | By design — full dataset on map |
| Files > ~500 MB may be slow | Entire file loaded into memory via FileReader |
| Shapefile without `.dbf` | Supported — geometry only, empty properties |
| KML styles / icons | Ignored — only geometry and properties extracted |
| GPX | Not yet supported (`@tmcw/togeojson` supports it — trivial to add) |
| DuckDB-WASM + Spatial | Planned — will enable lazy reads for 2 GB+ Parquet via OPFS |

---

## Licence

MIT

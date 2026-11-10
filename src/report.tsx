import { useState } from 'react'
import * as duckdb from '@duckdb/duckdb-wasm'
import type { R2ObjectInfo } from './types'

type Metric = { program: string; households: number; children: number; adults: number; seniors: number; pounds: number }
type DatasetDiagnostic = { key: string; rows: number; columns: string[]; recognized: string }

function asNumber(value: unknown) { const n = Number(value); return Number.isFinite(n) ? n : 0 }
function asDate(value: unknown) {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value > 10000 ? value * 86400000 : value)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
  }
  const text = String(value ?? '').trim()
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(text)
  if (iso) return iso[1]
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10)
}

async function createDb() {
  const bundles = duckdb.getJsDelivrBundles(); const bundle = await duckdb.selectBundle({ mvp: bundles.mvp, eh: bundles.eh })
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' })); const worker = new Worker(workerUrl)
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker); await db.instantiate(bundle.mainModule, null); URL.revokeObjectURL(workerUrl)
  return { db, connection: await db.connect() }
}

function rows(result: { toArray: () => unknown[] }) { return result.toArray().map(row => typeof row === 'object' && row ? Object.fromEntries(Object.entries(row)) : {}) }

export function Reports({ objects, loading, onRefresh }: { objects: R2ObjectInfo[]; loading: boolean; onRefresh: () => void }) {
  const [start, setStart] = useState('2025-01-06'); const [end, setEnd] = useState('2026-11-04'); const [running, setRunning] = useState(false); const [notice, setNotice] = useState(''); const [metrics, setMetrics] = useState<Metric[]>([]); const [rescue, setRescue] = useState(0); const [known, setKnown] = useState(0); const [diagnostics, setDiagnostics] = useState<DatasetDiagnostic[]>([])
  async function run() {
    setRunning(true); setNotice('Reading selected Parquet snapshots…'); setMetrics([]); setRescue(0); setDiagnostics([])
    try {
      const { db, connection } = await createDb();
      const latest = new Map<string, R2ObjectInfo>()
      for (const object of objects.filter(o => /\.parquet$/i.test(o.key))) {
        const dataset = object.key.replace(/-\d{4}-\d{2}-\d{2}-\d{6}\.parquet$/i, '')
        if (!latest.has(dataset) || object.key > latest.get(dataset)!.key) latest.set(dataset, object)
      }
      const files = [...latest.values()].filter(object => /(?:CRM_FOOD_SERVICES|DISTRIBUTION|ANONYMOUS_PROGRAMS|LOG_RESCUE|LOG_WAREHOUSE)/i.test(object.key));
      const all: Record<string, unknown>[] = []
      for (let i = 0; i < files.length; i++) {
        const object = files[i]; setNotice(`Reading ${i + 1} of ${files.length}: ${object.key}`)
        const response = await fetch(`/api/objects/${encodeURIComponent(object.key)}`); if (!response.ok) continue
        await db.registerFileBuffer(object.key.replace(/[^A-Za-z0-9_]/g, '_'), new Uint8Array(await response.arrayBuffer()))
        const file = object.key.replace(/[^A-Za-z0-9_]/g, '_'); const upper = object.key.toUpperCase(); const result = rows(await connection.query(`SELECT * FROM read_parquet('${file}')`)); const columns = Object.keys(result[0] ?? {}); all.push(...result.map(row => ({ ...row, __key: object.key }))); setDiagnostics(current => [...current, { key: object.key, rows: result.length, columns, recognized: columns.includes('service_id') && columns.includes('food_pounds') ? 'CRM candidate' : upper.includes('DISTRIBUTION') ? 'Locker candidate' : upper.includes('RESCUE') ? 'Rescue candidate' : 'Not recognized' }])
      }
      const inRange = (value: unknown) => { const d = asDate(value); return Boolean(d) && d >= start && d <= end }
      const output: Metric[] = []; let rescuePounds = 0; let knownRows = 0; let crmRowsRead = 0; let crmRowsInRange = 0
      for (const row of all) {
        const key = String(row.__key); const upper = key.toUpperCase()
        const isCrm = upper.includes('CRM_FOOD_SERVICES') || (upper.includes('CRM') && upper.includes('FOOD')) || ('service_id' in row && 'food_pounds' in row && 'service_date' in row)
        if (isCrm) {
          crmRowsRead++
          if (!inRange(row.service_date)) continue
          crmRowsInRange++; knownRows++
          output.push({ program: `CRM · ${String(row.service_type || 'Food')}`, households: asNumber(row.households_served), children: asNumber(row.children_served), adults: asNumber(row.adults_served), seniors: asNumber(row.seniors_served), pounds: asNumber(row.food_pounds) }); continue
        }
        if (upper.includes('DISTRIBUTION')) { if (!inRange(row.Date || row.date)) continue; output.push({ program: 'Lockers', households: 0, children: 0, adults: 0, seniors: 0, pounds: asNumber(row.TotalPounds ?? row.total_pounds) }); continue }
        if (upper.includes('ANONYMOUS')) { if (!inRange(row.Date || row.date)) continue; output.push({ program: `Anonymous · ${String(row.Program || 'Program')}`, households: asNumber(row.Households), children: asNumber(row.Children), adults: asNumber(row.Adults), seniors: asNumber(row.Seniors), pounds: asNumber(row.Pounds) }); continue }
        if (upper.includes('RESCUE')) { if (!inRange(row.Date || row.date)) continue; rescuePounds += asNumber(row.Total ?? row.total) }
      }
      const grouped = new Map<string, Metric>(); for (const item of output) { const current = grouped.get(item.program) ?? { ...item, households: 0, children: 0, adults: 0, seniors: 0, pounds: 0 }; current.households += item.households; current.children += item.children; current.adults += item.adults; current.seniors += item.seniors; current.pounds += item.pounds; grouped.set(item.program, current) }
      setMetrics([...grouped.values()]); setRescue(rescuePounds); setKnown(knownRows); setNotice(`Report complete. Read ${all.length.toLocaleString()} rows; CRM rows ${crmRowsRead.toLocaleString()}, in range ${crmRowsInRange.toLocaleString()}.`); await connection.close(); await db.terminate()
    } catch (error) { setNotice(`Report failed: ${error instanceof Error ? error.message : String(error)}`) } finally { setRunning(false) }
  }
  const total = metrics.reduce((a, x) => ({ households: a.households + x.households, children: a.children + x.children, adults: a.adults + x.adults, seniors: a.seniors + x.seniors, pounds: a.pounds + x.pounds }), { households: 0, children: 0, adults: 0, seniors: 0, pounds: 0 })
  return <section className="workspace"><div className="section-title"><div><p className="section-kicker">REPORTING</p><h2>Program totals</h2></div><button className="secondary-button" onClick={onRefresh}>Refresh files</button></div><div className="card report-controls"><label>From<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label><label>Through<input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label><button className="primary-button" disabled={running || loading || !objects.length} onClick={run}>{running ? 'Building report…' : 'Run report'} →</button></div>{notice && <div className="notice">{notice}</div>}<div className="card"><p className="section-kicker">LOADED DATASETS</p><div className="file-list">{diagnostics.map(item => <div className="file-row" key={item.key}><div><strong>{item.key}</strong><span>{item.recognized} · {item.rows.toLocaleString()} rows · {item.columns.join(', ') || 'No columns detected'}</span></div></div>)}</div>{!diagnostics.length && <p className="card-copy">Run the report to inspect loaded datasets.</p>}</div><div className="card"><p className="section-kicker">DISTRIBUTED FOOD</p><table className="report-table"><thead><tr><th>Program</th><th>Households Served</th><th>Children Served</th><th>Adults Served</th><th>Seniors Served</th><th>Pounds Distributed</th></tr></thead><tbody>{metrics.map(row => <tr key={row.program}><td>{row.program}</td><td>{row.households.toLocaleString()}</td><td>{row.children.toLocaleString()}</td><td>{row.adults.toLocaleString()}</td><td>{row.seniors.toLocaleString()}</td><td>{row.pounds.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td></tr>)}<tr className="report-total"><td>Total</td><td>{total.households.toLocaleString()}</td><td>{total.children.toLocaleString()}</td><td>{total.adults.toLocaleString()}</td><td>{total.seniors.toLocaleString()}</td><td>{total.pounds.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td></tr></tbody></table></div><div className="report-summary"><div className="card"><span>Distributed pounds</span><strong>{total.pounds.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div><div className="card"><span>Rescue incoming pounds</span><strong>{rescue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong></div><div className="card"><span>CRM service rows</span><strong>{known.toLocaleString()}</strong></div></div></section>
}

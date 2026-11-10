import { useState } from 'react'
import * as duckdb from '@duckdb/duckdb-wasm'
import type { R2ObjectInfo } from './types'

type Metric = { program: string; households: number; children: number; adults: number; seniors: number; pounds: number }
type DatasetDiagnostic = { key: string; rows: number; columns: string[]; recognized: string; dateColumn?: string }

function number(value: unknown) { const result = Number(value); return Number.isFinite(result) ? result : 0 }
function safeDate(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Dates must use YYYY-MM-DD format'); return value }
function sqlString(value: string) { return `'${value.replaceAll("'", "''")}'` }

async function createDb() {
  const bundles = duckdb.getJsDelivrBundles(); const bundle = await duckdb.selectBundle({ mvp: bundles.mvp, eh: bundles.eh })
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }))
  const worker = new Worker(workerUrl); const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker)
  await db.instantiate(bundle.mainModule, null); URL.revokeObjectURL(workerUrl)
  return { db, connection: await db.connect() }
}

function resultRows(result: { toArray: () => unknown[] }) { return result.toArray().map(row => Object.fromEntries(Object.entries(row as object))) as Record<string, unknown>[] }

export function Reports({ objects, loading, onRefresh }: { objects: R2ObjectInfo[]; loading: boolean; onRefresh: () => void }) {
  const [start, setStart] = useState('2025-01-06'); const [end, setEnd] = useState('2026-11-04'); const [running, setRunning] = useState(false); const [notice, setNotice] = useState(''); const [metrics, setMetrics] = useState<Metric[]>([]); const [rescue, setRescue] = useState(0); const [known, setKnown] = useState(0); const [diagnostics, setDiagnostics] = useState<DatasetDiagnostic[]>([])

  async function run() {
    setRunning(true); setNotice('Loading Parquet datasets into DuckDB-Wasm…'); setMetrics([]); setRescue(0); setKnown(0); setDiagnostics([])
    let db: duckdb.AsyncDuckDB | undefined; let connection: duckdb.AsyncDuckDBConnection | undefined
    try {
      const from = safeDate(start); const through = safeDate(end); ({ db, connection } = await createDb())
      const latest = new Map<string, R2ObjectInfo>()
      for (const object of objects.filter(item => /\.parquet$/i.test(item.key))) {
        const dataset = object.key.replace(/-\d{4}-\d{2}-\d{2}-\d{6}\.parquet$/i, '')
        if (!latest.has(dataset) || object.key > latest.get(dataset)!.key) latest.set(dataset, object)
      }
      const files = [...latest.values()].filter(object => /CRM_FOOD_SERVICES|DISTRIBUTION|ANONYMOUS_PROGRAMS|LOG_RESCUE/i.test(object.key))
      const crmResults: Metric[] = []; let rescuePounds = 0; let crmRows = 0
      for (const object of files) {
        setNotice(`Loading ${object.key}…`)
        const response = await fetch(`/api/objects/${encodeURIComponent(object.key)}`)
        if (!response.ok) throw new Error(`Unable to read ${object.key} (${response.status})`)
        const registeredName = object.key.replace(/[^A-Za-z0-9_]/g, '_')
        await db.registerFileBuffer(registeredName, new Uint8Array(await response.arrayBuffer()))
        const file = sqlString(registeredName); const schemaRows = resultRows(await connection.query(`DESCRIBE SELECT * FROM read_parquet(${file})`)); const columns = schemaRows.map(row => String(row.column_name)); const upper = object.key.toUpperCase()
        const isCrm = columns.includes('service_id') && columns.includes('service_date') && columns.includes('food_pounds')
        const recognized = isCrm ? 'CRM candidate' : upper.includes('DISTRIBUTION') ? 'Locker candidate' : upper.includes('RESCUE') ? 'Rescue candidate' : upper.includes('ANONYMOUS') ? 'Anonymous candidate' : 'Not recognized'
        const dateColumn = columns.includes('service_date') ? 'service_date' : columns.includes('Date') ? 'Date' : undefined
        const rowCount = number(resultRows(await connection.query(`SELECT COUNT(*) AS count FROM read_parquet(${file})`))[0]?.count)
        setDiagnostics(current => [...current, { key: object.key, rows: rowCount, columns, recognized, dateColumn }])
        if (isCrm) {
          const query = `SELECT service_type AS program, SUM(TRY_CAST(households_served AS DOUBLE)) AS households, SUM(TRY_CAST(children_served AS DOUBLE)) AS children, SUM(TRY_CAST(adults_served AS DOUBLE)) AS adults, SUM(TRY_CAST(seniors_served AS DOUBLE)) AS seniors, SUM(TRY_CAST(food_pounds AS DOUBLE)) AS pounds FROM read_parquet(${file}) WHERE TRY_CAST(service_date AS DATE) BETWEEN DATE ${sqlString(from)} AND DATE ${sqlString(through)} GROUP BY service_type ORDER BY service_type`
          const rows = resultRows(await connection.query(query)); crmRows += rowCount
          crmResults.push(...rows.map(row => ({ program: `CRM · ${String(row.program || 'Food')}`, households: number(row.households), children: number(row.children), adults: number(row.adults), seniors: number(row.seniors), pounds: number(row.pounds) })))
        } else if (upper.includes('DISTRIBUTION')) {
          const row = resultRows(await connection.query(`SELECT SUM(TRY_CAST(TotalPounds AS DOUBLE)) AS pounds FROM read_parquet(${file}) WHERE TRY_CAST(Date AS DATE) BETWEEN DATE ${sqlString(from)} AND DATE ${sqlString(through)}`))[0]
          crmResults.push({ program: 'Lockers', households: 0, children: 0, adults: 0, seniors: 0, pounds: number(row?.pounds) })
        } else if (upper.includes('ANONYMOUS')) {
          const rows = resultRows(await connection.query(`SELECT Program AS program, SUM(TRY_CAST(Households AS DOUBLE)) AS households, SUM(TRY_CAST(Children AS DOUBLE)) AS children, SUM(TRY_CAST(Adults AS DOUBLE)) AS adults, SUM(TRY_CAST(Seniors AS DOUBLE)) AS seniors, SUM(TRY_CAST(Pounds AS DOUBLE)) AS pounds FROM read_parquet(${file}) WHERE TRY_CAST(Date AS DATE) BETWEEN DATE ${sqlString(from)} AND DATE ${sqlString(through)} GROUP BY Program ORDER BY Program`))
          crmResults.push(...rows.map(row => ({ program: `Anonymous · ${String(row.program || 'Program')}`, households: number(row.households), children: number(row.children), adults: number(row.adults), seniors: number(row.seniors), pounds: number(row.pounds) })))
        } else if (upper.includes('RESCUE')) {
          const row = resultRows(await connection.query(`SELECT SUM(TRY_CAST(Total AS DOUBLE)) AS pounds FROM read_parquet(${file}) WHERE TRY_CAST(Date AS DATE) BETWEEN DATE ${sqlString(from)} AND DATE ${sqlString(through)}`))[0]
          rescuePounds += number(row?.pounds)
        }
      }
      const grouped = new Map<string, Metric>()
      for (const item of crmResults) { const current = grouped.get(item.program) ?? { ...item, households: 0, children: 0, adults: 0, seniors: 0, pounds: 0 }; current.households += item.households; current.children += item.children; current.adults += item.adults; current.seniors += item.seniors; current.pounds += item.pounds; grouped.set(item.program, current) }
      setMetrics([...grouped.values()]); setRescue(rescuePounds); setKnown(crmRows); setNotice('Report complete. Filtering and aggregation were performed by DuckDB-Wasm.')
    } catch (error) { setNotice(`Report failed: ${error instanceof Error ? error.message : String(error)}`) } finally { await connection?.close(); await db?.terminate(); setRunning(false) }
  }

  const total = metrics.reduce((sum, item) => ({ households: sum.households + item.households, children: sum.children + item.children, adults: sum.adults + item.adults, seniors: sum.seniors + item.seniors, pounds: sum.pounds + item.pounds }), { households: 0, children: 0, adults: 0, seniors: 0, pounds: 0 })
  const format = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return <section className="workspace"><div className="section-title"><div><p className="section-kicker">REPORTING</p><h2>Program totals</h2></div><button className="secondary-button" onClick={onRefresh}>Refresh files</button></div><div className="card report-controls"><label>From<input type="date" value={start} onChange={event => setStart(event.target.value)} /></label><label>Through<input type="date" value={end} onChange={event => setEnd(event.target.value)} /></label><button className="primary-button" disabled={running || loading || !objects.length} onClick={run}>{running ? 'Building report…' : 'Run report'} →</button></div>{notice && <div className="notice">{notice}</div>}<div className="card"><p className="section-kicker">LOADED DATASETS</p><div className="file-list">{diagnostics.map(item => <div className="file-row" key={item.key}><div><strong>{item.key}</strong><span>{item.recognized} · {item.rows.toLocaleString()} rows · {item.columns.join(', ') || 'No columns detected'}{item.dateColumn ? ` · date column ${item.dateColumn}` : ''}</span></div></div>)}</div>{!diagnostics.length && <p className="card-copy">Run the report to inspect loaded datasets.</p>}</div><div className="card"><p className="section-kicker">DISTRIBUTED FOOD</p><table className="report-table"><thead><tr><th>Program</th><th>Households Served</th><th>Children Served</th><th>Adults Served</th><th>Seniors Served</th><th>Pounds Distributed</th></tr></thead><tbody>{metrics.map(row => <tr key={row.program}><td>{row.program}</td><td>{format(row.households)}</td><td>{format(row.children)}</td><td>{format(row.adults)}</td><td>{format(row.seniors)}</td><td>{format(row.pounds)}</td></tr>)}<tr className="report-total"><td>Total</td><td>{format(total.households)}</td><td>{format(total.children)}</td><td>{format(total.adults)}</td><td>{format(total.seniors)}</td><td>{format(total.pounds)}</td></tr></tbody></table></div><div className="report-summary"><div className="card"><span>Distributed pounds</span><strong>{format(total.pounds)}</strong></div><div className="card"><span>Rescue incoming pounds</span><strong>{format(rescue)}</strong></div><div className="card"><span>CRM service rows</span><strong>{format(known)}</strong></div></div></section>
}

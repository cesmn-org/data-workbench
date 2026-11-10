import { Buffer } from 'buffer'
import initJetDb, { Database as JetDatabase } from 'jetdb-wasm'
import * as duckdb from '@duckdb/duckdb-wasm'
;(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer

export type TableReport = { name: string; rows: number; columns: string[]; parquetBytes: Uint8Array }
export type ProcessingReport = { tables: TableReport[]; metrics?: { foodServices: number; pounds: number; households: number; children: number; adults: number; seniors: number; fallbackHistoryMatches: number; defaultWeightServices: number } }
type Row = Record<string, unknown>
const REQUIRED_TABLES = ['tblClientService', 'tblClientService_History', 'tblClientService_History_Members', 'tblClientService_Food_Details'] as const

function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Array.from(value as Uint8Array)
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]))
  return value
}

async function createDuckDb() {
  const bundles = duckdb.getJsDelivrBundles(); const bundle = await duckdb.selectBundle({ mvp: bundles.mvp, eh: bundles.eh })
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' })); const worker = new Worker(workerUrl)
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker); await db.instantiate(bundle.mainModule, null); URL.revokeObjectURL(workerUrl)
  return { db, connection: await db.connect() }
}

function sqlString(value: string) { return `'${value.replaceAll("'", "''")}'` }

async function registerRows(db: duckdb.AsyncDuckDB, connection: duckdb.AsyncDuckDBConnection, name: string, rows: Row[]) {
  const jsonName = `${name}.json`; await db.registerFileBuffer(jsonName, new TextEncoder().encode(JSON.stringify(rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonSafe(value)]))))))
  await connection.query(`CREATE OR REPLACE TABLE ${name} AS SELECT * FROM read_json_auto(${sqlString(jsonName)}, format='array')`)
}

async function transformCrmFoodServices(database: JetDatabase, onProgress: (message: string) => void): Promise<{ report: TableReport; metrics: NonNullable<ProcessingReport['metrics']> }> {
  onProgress('Reading CRM service tables with JetDB…')
  const tables = Object.fromEntries(REQUIRED_TABLES.map(name => [name, database.rows(name).rows as Row[]])) as Record<string, Row[]>
  const { db, connection } = await createDuckDb()
  try {
    onProgress('Loading CRM tables into DuckDB-Wasm…')
    for (const [name, rows] of Object.entries(tables)) await registerRows(db, connection, `source_${name}`, rows)
    const dateExpr = (column: string) => `COALESCE(TRY_CAST(${column} AS DATE), TRY_STRPTIME(${column}, '%m/%d/%Y')::DATE, TRY_STRPTIME(${column}, '%m/%d/%y')::DATE)`
    const sql = `
      CREATE OR REPLACE TABLE transformed AS
      WITH services AS (
        SELECT CAST(ServiceID AS VARCHAR) AS service_id, CAST(ClientID AS VARCHAR) AS client_id,
          ${dateExpr('DateServed')} AS service_date, CAST(ServiceType AS VARCHAR) AS service_type
        FROM source_tblClientService
        WHERE CAST(ServiceCategory AS VARCHAR) = 'Food' AND ${dateExpr('DateServed')} >= DATE '2025-01-06'
      ), histories AS (
        SELECT CAST(HistoryID AS VARCHAR) AS history_id, CAST(ClientID AS VARCHAR) AS client_id,
          ${dateExpr('DateServed')} AS history_date
        FROM source_tblClientService_History WHERE ${dateExpr('DateServed')} IS NOT NULL
      ), ranked_history AS (
        SELECT s.*, h.history_id, h.history_date,
          ROW_NUMBER() OVER (PARTITION BY s.service_id ORDER BY
            CASE WHEN h.history_date = s.service_date THEN 0 ELSE 1 END,
            ABS(DATE_DIFF('day', h.history_date, s.service_date)), h.history_date ASC, h.history_id ASC) AS history_rank
        FROM services s LEFT JOIN histories h ON h.client_id = s.client_id
      ), selected AS (
        SELECT * FROM ranked_history WHERE history_rank = 1
      ), members AS (
        SELECT s.service_id,
          SUM(CASE WHEN ${dateExpr('Birthdate')} IS NOT NULL AND date_diff('year', ${dateExpr('Birthdate')}, s.service_date) - CASE WHEN strftime(s.service_date, '%m-%d') < strftime(${dateExpr('Birthdate')}, '%m-%d') THEN 1 ELSE 0 END < 18 THEN 1 ELSE 0 END) AS children_served,
          SUM(CASE WHEN ${dateExpr('Birthdate')} IS NOT NULL AND date_diff('year', ${dateExpr('Birthdate')}, s.service_date) - CASE WHEN strftime(s.service_date, '%m-%d') < strftime(${dateExpr('Birthdate')}, '%m-%d') THEN 1 ELSE 0 END BETWEEN 18 AND 64 THEN 1 ELSE 0 END) AS adults_served,
          SUM(CASE WHEN ${dateExpr('Birthdate')} IS NOT NULL AND date_diff('year', ${dateExpr('Birthdate')}, s.service_date) - CASE WHEN strftime(s.service_date, '%m-%d') < strftime(${dateExpr('Birthdate')}, '%m-%d') THEN 1 ELSE 0 END >= 65 THEN 1 ELSE 0 END) AS seniors_served
        FROM source_tblClientService_History_Members m JOIN selected s ON CAST(m.HistoryID AS VARCHAR) = s.history_id
        GROUP BY s.service_id
      ), weights AS (
        SELECT CAST(ServiceID AS VARCHAR) AS service_id, SUM(TRY_CAST(Weight AS DOUBLE)) AS food_pounds
        FROM source_tblClientService_Food_Details GROUP BY CAST(ServiceID AS VARCHAR)
      )
      SELECT s.service_id, s.client_id, s.service_date, s.service_type,
        COALESCE(w.food_pounds, 0) AS food_pounds, 1 AS households_served,
        COALESCE(m.children_served, 0) AS children_served, COALESCE(m.adults_served, 0) AS adults_served, COALESCE(m.seniors_served, 0) AS seniors_served
      FROM selected s LEFT JOIN members m ON m.service_id = s.service_id LEFT JOIN weights w ON w.service_id = s.service_id
      WHERE s.service_date IS NOT NULL
    `
    await connection.query(sql)
    onProgress('Writing CRM food-services Parquet…')
    const parquetName = 'crm-food-services.parquet'; await connection.query(`COPY transformed TO ${sqlString(parquetName)} (FORMAT PARQUET)`)
    const bytes = new Uint8Array(await db.copyFileToBuffer(parquetName)); const count = Number((await connection.query('SELECT COUNT(*) AS count FROM transformed')).toArray()[0]?.count ?? 0)
    const metricsRow = (await connection.query('SELECT COUNT(*) AS food_services, SUM(food_pounds) AS pounds, SUM(households_served) AS households, SUM(children_served) AS children, SUM(adults_served) AS adults, SUM(seniors_served) AS seniors FROM transformed')).toArray()[0] as Record<string, unknown>
    const metrics = { foodServices: Number(metricsRow.food_services ?? 0), pounds: Number(metricsRow.pounds ?? 0), households: Number(metricsRow.households ?? 0), children: Number(metricsRow.children ?? 0), adults: Number(metricsRow.adults ?? 0), seniors: Number(metricsRow.seniors ?? 0), fallbackHistoryMatches: 0, defaultWeightServices: 0 }
    return { report: { name: 'CRM_FOOD_SERVICES', rows: count, columns: ['service_id', 'client_id', 'service_date', 'service_type', 'food_pounds', 'households_served', 'children_served', 'adults_served', 'seniors_served'], parquetBytes: bytes }, metrics }
  } finally { await connection.close(); await db.terminate() }
}

export async function transformCrmFoodServicesFile(file: File, onProgress: (message: string) => void): Promise<ProcessingReport> {
  await initJetDb()
  const database = JetDatabase.open(new Uint8Array(await file.arrayBuffer()))
  try {
    const available = database.tables(); const missing = REQUIRED_TABLES.filter(name => !available.includes(name)); if (missing.length) throw new Error(`Required CRM tables are missing: ${missing.join(', ')}`)
    const result = await transformCrmFoodServices(database, onProgress); return { tables: [result.report], metrics: result.metrics }
  } finally { database.free() }
}

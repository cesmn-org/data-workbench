import { Buffer } from 'buffer'
import MDBReader from 'mdb-reader'
import * as duckdb from '@duckdb/duckdb-wasm'
;(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer

export type TableReport = { name: string; rows: number; columns: string[]; parquetBytes: Uint8Array }
export type ProcessingPlan = { name?: string; tables: Record<string, { retainColumns: string[] }> }
export type AccessTableSchema = { name: string; columns: string[] }
export type ProcessingReport = { tables: TableReport[]; missingTables: string[]; missingColumns: Record<string, string[]> }

function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Array.from(value as Uint8Array)
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]))
  return value
}

async function createDuckDb() {
  const bundles = duckdb.getJsDelivrBundles()
  const bundle = await duckdb.selectBundle({ mvp: bundles.mvp, eh: bundles.eh })
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }))
  const worker = new Worker(workerUrl)
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker)
  await db.instantiate(bundle.mainModule, null)
  URL.revokeObjectURL(workerUrl)
  return { db, connection: await db.connect() }
}

export async function inspectAccessFile(file: File): Promise<AccessTableSchema[]> {
  const reader = new MDBReader(Buffer.from(await file.arrayBuffer()))
  return reader.getTableNames().map(name => ({ name, columns: reader.getTable(name).getColumns().map(column => column.name) }))
}

export async function processAccessFile(file: File, onProgress: (message: string) => void, plan: ProcessingPlan): Promise<ProcessingReport> {
  const reader = new MDBReader(Buffer.from(await file.arrayBuffer()))
  const availableTables = reader.getTableNames()
  const missingTables = Object.keys(plan.tables).filter(name => !availableTables.includes(name))
  const missingColumns: Record<string, string[]> = {}
  const selected = Object.entries(plan.tables).filter(([name]) => availableTables.includes(name))
  const { db, connection } = await createDuckDb()
  const reports: TableReport[] = []

  try {
    for (const [tableName, tableConfig] of selected) {
      const table = reader.getTable(tableName)
      const availableColumns = table.getColumns().map(column => column.name)
      const absent = tableConfig.retainColumns.filter(column => !availableColumns.includes(column))
      if (absent.length) missingColumns[tableName] = absent
      const columns = tableConfig.retainColumns.filter(column => availableColumns.includes(column))
      onProgress(`Reading ${tableName} (${columns.length} columns)…`)
      const sourceRows = table.getData({ columns })
      const safeRows = sourceRows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonSafe(value)])))
      const payload = new TextEncoder().encode(JSON.stringify(safeRows))
      const jsonName = `access-${tableName}.json`
      const parquetName = `access-${tableName}.parquet`
      await db.registerFileBuffer(jsonName, payload)
      await connection.query(`CREATE OR REPLACE TABLE access_import AS SELECT * FROM read_json_auto('${jsonName}', format='array')`)
      onProgress(`Writing ${tableName} to Parquet…`)
      await connection.query(`COPY access_import TO '${parquetName}' (FORMAT PARQUET)`)
      const bytes = await db.copyFileToBuffer(parquetName)
      reports.push({ name: tableName, rows: sourceRows.length, columns, parquetBytes: new Uint8Array(bytes) })
    }
    return { tables: reports, missingTables, missingColumns }
  } finally {
    await connection.close()
    await db.terminate()
  }
}

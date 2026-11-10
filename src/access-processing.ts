import { Buffer } from 'buffer'
import MDBReader from 'mdb-reader'
import * as duckdb from '@duckdb/duckdb-wasm'
;(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer

export type TableReport = { name: string; rows: number; columns: string[]; parquetBytes: Uint8Array }
export type ProcessingPlan = { name?: string; tables: Record<string, { retainColumns: string[] }> }
export type AccessTableSchema = { name: string; columns: string[] }
export type ProcessingReport = { tables: TableReport[]; missingTables: string[]; missingColumns: Record<string, string[]>; metrics?: { foodServices: number; pounds: number; households: number; children: number; adults: number; seniors: number; fallbackHistoryMatches: number; defaultWeightServices: number } }

type Row = Record<string, unknown>
const REQUIRED_TABLES = ['tblClientService', 'tblClientService_History', 'tblClientService_History_Members', 'tblClientService_Food_Details']
const CUTOFF = new Date('2025-01-06T00:00:00')

function jsonSafe(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Array.from(value as Uint8Array)
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonSafe(item)]))
  return value
}

function text(value: unknown): string { return value == null ? '' : String(value).trim() }
function number(value: unknown): number | null { const parsed = Number(text(value)); return Number.isFinite(parsed) ? parsed : null }
function sourceDate(value: unknown): Date | null {
  const raw = text(value); if (!raw) return null
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2})(?:\s|$)/.exec(raw)
  if (match) { const year = Number(match[3]) + (Number(match[3]) >= 30 ? 1900 : 2000); const result = new Date(year, Number(match[1]) - 1, Number(match[2])); return Number.isNaN(result.getTime()) ? null : result }
  const parsed = new Date(raw); return Number.isNaN(parsed.getTime()) ? null : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
}
function dateKey(value: unknown): string { const d = sourceDate(value); return d ? d.toISOString().slice(0, 10) : '' }
function ageAt(birthdate: unknown, eventDate: Date): number | null {
  const birth = sourceDate(birthdate); if (!birth) return null
  let age = eventDate.getFullYear() - birth.getFullYear()
  if (eventDate.getMonth() < birth.getMonth() || (eventDate.getMonth() === birth.getMonth() && eventDate.getDate() < birth.getDate())) age--
  return age >= 0 && age <= 110 ? age : null
}

async function createDuckDb() {
  const bundles = duckdb.getJsDelivrBundles(); const bundle = await duckdb.selectBundle({ mvp: bundles.mvp, eh: bundles.eh })
  const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' })); const worker = new Worker(workerUrl)
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker); await db.instantiate(bundle.mainModule, null); URL.revokeObjectURL(workerUrl)
  return { db, connection: await db.connect() }
}

async function rowsToParquet(connection: duckdb.AsyncDuckDBConnection, db: duckdb.AsyncDuckDB, name: string, rows: Row[]): Promise<Uint8Array> {
  const payload = new TextEncoder().encode(JSON.stringify(rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonSafe(value)])))))
  const jsonName = `${name}.json`; const parquetName = `${name}.parquet`; await db.registerFileBuffer(jsonName, payload)
  await connection.query(`CREATE OR REPLACE TABLE transformed AS SELECT * FROM read_json_auto('${jsonName}', format='array')`)
  await connection.query(`COPY transformed TO '${parquetName}' (FORMAT PARQUET)`)
  return new Uint8Array(await db.copyFileToBuffer(parquetName))
}

function readTable(reader: MDBReader, name: string): Row[] {
  return reader.getTable(name).getData() as Row[]
}

async function transformCrmFoodServices(reader: MDBReader, onProgress: (message: string) => void): Promise<{ report: TableReport; metrics: NonNullable<ProcessingReport['metrics']> }> {
  onProgress('Reading CRM service tables…')
  const services = readTable(reader, 'tblClientService'); const histories = readTable(reader, 'tblClientService_History'); const members = readTable(reader, 'tblClientService_History_Members'); const details = readTable(reader, 'tblClientService_Food_Details')
  const currentServices = services.filter(row => text(row.ServiceCategory) === 'Food' && (sourceDate(row.DateServed)?.getTime() ?? 0) >= CUTOFF.getTime())
  const historiesByClient = new Map<string, { date: Date; id: string }[]>()
  for (const row of histories) { const date = sourceDate(row.DateServed); if (!date) continue; const list = historiesByClient.get(text(row.ClientID)) ?? []; list.push({ date, id: text(row.HistoryID) }); historiesByClient.set(text(row.ClientID), list) }
  for (const list of historiesByClient.values()) list.sort((a, b) => a.date.getTime() - b.date.getTime())
  const membersByHistory = new Map<string, Row[]>()
  for (const row of members) { const list = membersByHistory.get(text(row.HistoryID)) ?? []; list.push(row); membersByHistory.set(text(row.HistoryID), list) }
  const weights = new Map<string, number>()
  for (const row of details) { const value = number(row.Weight); if (value != null) weights.set(text(row.ServiceID), (weights.get(text(row.ServiceID)) ?? 0) + value) }
  let fallbackHistoryMatches = 0; let defaultWeightServices = 0; let children = 0; let adults = 0; let seniors = 0; let pounds = 0
  const output: Row[] = []
  for (const service of currentServices) {
    const serviceDate = sourceDate(service.DateServed)!; const clientId = text(service.ClientID); const candidates = historiesByClient.get(clientId) ?? []
    let selected = candidates.find(candidate => candidate.date.getTime() === serviceDate.getTime())
    if (!selected && candidates.length) { selected = candidates.reduce((best, candidate) => { const distance = Math.abs(candidate.date.getTime() - serviceDate.getTime()); const bestDistance = Math.abs(best.date.getTime() - serviceDate.getTime()); return distance < bestDistance || (distance === bestDistance && candidate.date <= serviceDate && best.date > serviceDate) ? candidate : best }) ; fallbackHistoryMatches++ }
    const serviceChildren = { children: 0, adults: 0, seniors: 0 }
    for (const member of (selected ? membersByHistory.get(selected.id) ?? [] : [])) { const age = ageAt(member.Birthdate, serviceDate); if (age == null || age >= 18 && age < 65) serviceChildren.adults++; else if (age < 18) serviceChildren.children++; else serviceChildren.seniors++ }
    children += serviceChildren.children; adults += serviceChildren.adults; seniors += serviceChildren.seniors
    const recordedWeight = weights.get(text(service.ServiceID)); const foodPounds = recordedWeight == null ? 20 : recordedWeight; if (recordedWeight == null) defaultWeightServices++; pounds += foodPounds
    output.push({ service_id: text(service.ServiceID), client_id: clientId, service_date: dateKey(service.DateServed), service_type: text(service.ServiceType), food_pounds: foodPounds, households_served: 1, children_served: serviceChildren.children, adults_served: serviceChildren.adults, seniors_served: serviceChildren.seniors })
  }
  onProgress('Writing CRM food-services Parquet…'); const { db, connection } = await createDuckDb()
  try { const bytes = await rowsToParquet(connection, db, 'crm-food-services', output); return { report: { name: 'CRM_FOOD_SERVICES', rows: output.length, columns: Object.keys(output[0] ?? {}), parquetBytes: bytes }, metrics: { foodServices: output.length, pounds, households: output.length, children, adults, seniors, fallbackHistoryMatches, defaultWeightServices } } } finally { await connection.close(); await db.terminate() }
}

export async function inspectAccessFile(file: File): Promise<AccessTableSchema[]> { const reader = new MDBReader(Buffer.from(await file.arrayBuffer())); return reader.getTableNames().map(name => ({ name, columns: reader.getTable(name).getColumns().map(column => column.name) })) }

export async function processAccessFile(file: File, onProgress: (message: string) => void, plan: ProcessingPlan, transformation?: 'crm-food-services'): Promise<ProcessingReport> {
  const reader = new MDBReader(Buffer.from(await file.arrayBuffer())); const availableTables = reader.getTableNames(); const missingTables = Object.keys(plan.tables).filter(name => !availableTables.includes(name)); const missingColumns: Record<string, string[]> = {}
  if (transformation === 'crm-food-services') {
    const requiredMissing = REQUIRED_TABLES.filter(name => !availableTables.includes(name)); if (requiredMissing.length) return { tables: [], missingTables: requiredMissing, missingColumns: {} }
    const result = await transformCrmFoodServices(reader, onProgress); return { tables: [result.report], missingTables, missingColumns, metrics: result.metrics }
  }
  const selected = Object.entries(plan.tables).filter(([name]) => availableTables.includes(name)); const { db, connection } = await createDuckDb(); const reports: TableReport[] = []
  try { for (const [tableName, tableConfig] of selected) { const table = reader.getTable(tableName); const availableColumns = table.getColumns().map(column => column.name); const absent = tableConfig.retainColumns.filter(column => !availableColumns.includes(column)); if (absent.length) missingColumns[tableName] = absent; const columns = tableConfig.retainColumns.filter(column => availableColumns.includes(column)); onProgress(`Reading ${tableName} (${columns.length} columns)…`); const sourceRows = table.getData({ columns }); const safeRows = sourceRows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, jsonSafe(value)]))); const payload = new TextEncoder().encode(JSON.stringify(safeRows)); const jsonName = `access-${tableName}.json`; const parquetName = `access-${tableName}.parquet`; await db.registerFileBuffer(jsonName, payload); await connection.query(`CREATE OR REPLACE TABLE access_import AS SELECT * FROM read_json_auto('${jsonName}', format='array')`); onProgress(`Writing ${tableName} to Parquet…`); await connection.query(`COPY access_import TO '${parquetName}' (FORMAT PARQUET)`); const bytes = await db.copyFileToBuffer(parquetName); reports.push({ name: tableName, rows: sourceRows.length, columns, parquetBytes: new Uint8Array(bytes) }) } return { tables: reports, missingTables, missingColumns } } finally { await connection.close(); await db.terminate() }
}

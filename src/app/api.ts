import type { R2ObjectInfo, RefreshResult, RefreshWorkflow, UploadResult } from './types'

async function json<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`)
  return body
}

export async function listObjects() {
  return (await json<{ objects: R2ObjectInfo[] }>(await fetch('/api/objects'))).objects
}

export async function deleteObjects(keys: string[]) {
  await json(await fetch('/api/objects', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }) }))
}

export async function uploadParquet(report: { tables: { name: string; parquetBytes: Uint8Array }[] }, snapshotTimestamp?: string): Promise<UploadResult> {
  const form = new FormData(); form.set('source', 'WORKBENCH')
  for (const table of report.tables) form.append('file', new File([table.parquetBytes.buffer.slice(table.parquetBytes.byteOffset, table.parquetBytes.byteOffset + table.parquetBytes.byteLength) as ArrayBuffer], `${table.name}.parquet`, { type: 'application/vnd.apache.parquet' }))
  return json<UploadResult>(await fetch('/api/uploads', { method: 'POST', headers: snapshotTimestamp ? { 'x-snapshot-timestamp': snapshotTimestamp } : undefined, body: form }))
}

export async function startRefresh() {
  return json<{ id: string; timestamp: string }>(await fetch('/api/refresh', { method: 'POST' }))
}

export async function refreshStatus(id: string) {
  return json<{ status: string; timestamp: string; workflows: RefreshWorkflow[]; error?: string }>(await fetch(`/api/refresh/status/${id}`))
}

export async function pollRefresh(id: string, onUpdate: (result: RefreshResult & { status: string }) => void) {
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 3000))
    const result = await refreshStatus(id); onUpdate(result)
    if (result.status === 'success') return result
  }
}

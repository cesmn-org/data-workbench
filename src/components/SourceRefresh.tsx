import { pollRefresh, startRefresh } from '../app/api'
import type { RefreshResult } from '../app/types'
import { useState } from 'react'

export function SourceRefresh({ onNotice }: { onNotice: (message: string) => void }) {
  const [refreshing, setRefreshing] = useState(false); const [result, setResult] = useState<RefreshResult>()
  async function refresh() { setRefreshing(true); setResult(undefined); try { const started = await startRefresh(new Date().toISOString().slice(0, 19).replace('T', '-').replaceAll(':', '')); const final = await pollRefresh(started.id, status => { setResult({ timestamp: status.timestamp, workflows: status.workflows }); onNotice(status.status === 'success' ? 'All source-fetcher workflows completed successfully.' : `Running ${status.workflows.find(item => item.status === 'in_progress')?.workflow ?? 'source fetcher'}…`) }); setResult(final); onNotice('All source-fetcher workflows completed successfully.') } catch (error) { onNotice(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`) } finally { setRefreshing(false) } }
  return <section className="card refresh-card"><div className="refresh-copy"><p className="section-kicker">SOURCE FETCHERS</p><h3>Refresh source data</h3><p>Run all six GitHub Actions fetchers sequentially with one shared UTC snapshot timestamp.</p>{result && <div className="upload-summary"><strong>Snapshot {result.timestamp}</strong>{result.workflows.map(item => <span key={item.workflow}>{item.workflow} · {item.status ?? 'pending'}</span>)}</div>}</div><button className="primary-button" disabled={refreshing} onClick={refresh}>{refreshing ? 'Refreshing…' : 'Refresh source data'} →</button></section>
}

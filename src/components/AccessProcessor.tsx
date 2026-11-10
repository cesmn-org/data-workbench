import { useState } from 'react'
import type { ProcessingReport } from '../access-processing'
import { pollRefresh, startRefresh, uploadParquet } from '../app/api'
import type { RefreshResult, UploadResult } from '../app/types'

function snapshotTimestamp() {
  const iso = new Date().toISOString()
  return `${iso.slice(0, 10)}-${iso.slice(11, 19).replaceAll(':', '')}`
}

export function AccessProcessor({ onNotice }: { onNotice: (message: string) => void }) {
  const [sourceFile, setSourceFile] = useState<File>(); const [processing, setProcessing] = useState(false); const [progress, setProgress] = useState(''); const [step, setStep] = useState(0); const [uploaded, setUploaded] = useState<UploadResult>(); const [refreshResult, setRefreshResult] = useState<RefreshResult>()
  async function finishPipeline(result: ProcessingReport, timestamp: string) {
    try {
      setStep(5); setProgress('Uploading transformed CRM Parquet to R2…')
      const upload = await uploadParquet(result, timestamp); setUploaded(upload); setStep(6); setProgress('Starting source fetchers…')
      const refresh = await startRefresh(timestamp)
      const final = await pollRefresh(refresh.id, status => { setRefreshResult({ timestamp: status.timestamp, workflows: status.workflows }); setProgress(status.status === 'success' ? 'All source fetchers completed.' : `Running ${status.workflows.find(item => item.status === 'in_progress')?.workflow ?? 'source fetcher'}…`) })
      setRefreshResult(final); setStep(7); setProgress('Complete'); onNotice('Access transformed and uploaded; all source-fetcher workflows completed successfully.')
    } catch (error) { onNotice(`Pipeline failed: ${error instanceof Error ? error.message : String(error)}`) } finally { setProcessing(false) }
  }
  function processFile(file: File) {
    setSourceFile(file); setProcessing(true); setUploaded(undefined); setRefreshResult(undefined); setStep(1); setProgress('Starting background processing…')
    const timestamp = snapshotTimestamp(); const worker = new Worker(new URL('../access-processing.worker.ts', import.meta.url), { type: 'module' }); const finish = () => worker.terminate()
    worker.onmessage = event => { if (event.data.type === 'progress') { const message = event.data.message as string; setProgress(message); if (message.startsWith('Reading ')) setStep(2); if (message.startsWith('Writing ')) setStep(3) } else if (event.data.type === 'complete') { finish(); void finishPipeline(event.data.report as ProcessingReport, timestamp) } else if (event.data.type === 'error') { setProcessing(false); finish(); onNotice(`Processing failed: ${event.data.message}`) } }
    worker.onerror = event => { setProcessing(false); finish(); onNotice(`Processing failed: ${event.message}`) }; worker.postMessage({ file })
  }
  return <section className="workspace"><div className="hero"><div><p className="section-kicker">LOCAL-FIRST INGESTION</p><h2>Transform and refresh data.</h2><p>Select an Access file to transform it locally, upload the Parquet result to private R2, then run all source fetchers with the same snapshot timestamp.</p></div><div className="privacy-badge">✓ <span>Raw files stay local</span></div></div><section className="card"><p className="section-kicker">AUTOMATED PIPELINE</p><h3>Choose an Access file to begin</h3><label className="dropzone"><input type="file" accept=".accdb,.mdb,application/x-msaccess" disabled={processing} onChange={event => { const file = event.target.files?.[0]; if (file) processFile(file) }}/><span className="upload-icon">↑</span><strong>{sourceFile?.name || 'Choose an Access file'}</strong><small>{processing ? 'Pipeline running…' : 'Selection starts the complete pipeline'}</small></label></section><section className="card refresh-card"><div className="refresh-copy"><p className="section-kicker">PIPELINE STATUS</p><ol className="process-steps">{['Read Access file', 'Read CRM tables', 'Write Parquet file', 'Upload CRM Parquet', 'Start source fetchers', 'Complete'].map((label, index) => <li className={step > index ? 'done' : step === index + 1 ? 'current' : ''} key={label}><span>{step > index ? '✓' : index + 1}</span>{label}</li>)}</ol><p className="progress-message">{progress || 'Choose an Access file to start.'}</p></div></section>{(uploaded || refreshResult) && <section className="card results-card"><p className="section-kicker">PIPELINE OUTPUT</p>{uploaded && <div className="upload-summary"><strong>CRM uploaded: {uploaded.timestamp}</strong>{uploaded.objects.map(item => <span key={item.key}>{item.key}</span>)}</div>}{refreshResult && <div className="upload-summary"><strong>Source fetchers: {refreshResult.timestamp}</strong>{refreshResult.workflows.map(item => <span key={item.workflow}>{item.workflow} · {item.status ?? 'pending'}</span>)}</div>}</section>}</section>
}

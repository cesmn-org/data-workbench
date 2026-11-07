import { useMemo, useState } from 'react'
import './App.css'
import config from './config/access-import.json'
import { type ProcessingReport } from './access-processing'

type Area = 'operations' | 'datasets' | 'query' | 'reports' | 'exports'

const areas: { id: Area; label: string; description: string }[] = [
  { id: 'operations', label: 'Data Operations', description: 'Upload Access files and monitor refreshes' },
  { id: 'datasets', label: 'Datasets', description: 'Browse snapshots and source tables' },
  { id: 'query', label: 'Query', description: 'Explore data with SQL' },
  { id: 'reports', label: 'Reports', description: 'Reuse saved queries' },
  { id: 'exports', label: 'Exports', description: 'Download query results' },
]

function App() {
  const [activeArea, setActiveArea] = useState<Area>('operations')
  const [file, setFile] = useState<File>()
  const [notice, setNotice] = useState('')
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState('')
  const [report, setReport] = useState<ProcessingReport>()
  const tableCount = Object.keys(config.tables).length
  const columnCount = useMemo(() => Object.values(config.tables).reduce((total, table) => total + table.retainColumns.length, 0), [])

function processFile() {
    if (!file) return
    setProcessing(true); setReport(undefined); setNotice(''); setProgress('Starting background processing…')
    const worker = new Worker(new URL('./access-processing.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => {
      const message = event.data as { type: string; message?: string; report?: ProcessingReport }
      if (message.type === 'progress') setProgress(message.message ?? '')
      if (message.type === 'complete' && message.report) {
        setReport(message.report)
        setNotice(message.report.missingTables.length || Object.keys(message.report.missingColumns).length ? 'Processing completed with configuration mismatches.' : 'Processing completed. The raw Access file stayed in this browser.')
        setProcessing(false); worker.terminate()
      }
      if (message.type === 'error') { setNotice(`Processing failed: ${message.message}`); setProcessing(false); worker.terminate() }
    }
    worker.onerror = event => { setNotice(`Processing failed: ${event.message}`); setProcessing(false); worker.terminate() }
    worker.postMessage({ file })
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">DW</div><div><strong>Data Workbench</strong><span>Operational data, together</span></div></div>
        <nav aria-label="Main navigation">
          <p className="nav-label">WORKSPACE</p>
          {areas.map(area => <button key={area.id} className={`nav-item ${activeArea === area.id ? 'active' : ''}`} onClick={() => setActiveArea(area.id)}><span className="nav-icon">{area.id === 'operations' ? '↗' : area.id === 'datasets' ? '▦' : area.id === 'query' ? '⌘' : area.id === 'reports' ? '▤' : '⇩'}</span><span>{area.label}</span>{area.id === 'operations' && <span className="nav-dot" />}</button>)}
        </nav>
        <div className="sidebar-footer"><span className="status-dot" />Local workspace<div className="muted">R2 connection not configured</div></div>
      </aside>

      <main className="main-content">
        <header className="topbar"><div><p className="eyebrow">WORKSPACE / {activeArea.toUpperCase()}</p><h1>{areas.find(area => area.id === activeArea)?.label}</h1></div><div className="top-actions"><button className="icon-button" aria-label="Help">?</button><div className="avatar">JM</div></div></header>

        {activeArea === 'operations' ? <>
          <section className="intro-row"><div><h2>Keep your data moving.</h2><p>Process an Access database in your browser, then send only the prepared Parquet snapshots to R2.</p></div><div className="privacy-badge"><span>✓</span><div><strong>Privacy boundary</strong><small>Raw Access files stay on this device</small></div></div></section>
          {notice && <div className="notice"><span>i</span>{notice}<button onClick={() => setNotice('')}>×</button></div>}
          <section className="operation-grid">
            <div className="card upload-card"><div className="card-heading"><div><p className="section-kicker">STEP 01</p><h3>Upload Access database</h3></div><span className="step-badge">1</span></div><p className="card-copy">Choose an <code>.accdb</code> file. Its contents will be read and transformed locally in your browser.</p><label className="dropzone"><input type="file" accept=".accdb,.mdb,application/x-msaccess" onChange={event => { setFile(event.target.files?.[0]); setReport(undefined); setNotice('') }} /><span className="upload-icon">↑</span><strong>{file?.name || 'Choose an Access file'}</strong><small>{file ? 'Ready to process with the repository configuration' : 'or drag and drop it here'}</small></label>{file && <div className="selected-file"><span className="file-icon">▣</span><div><strong>{file.name}</strong><small>Selected locally</small></div><span className="check">✓</span></div>}</div>
            <div className="card profile-card"><div className="card-heading"><div><p className="section-kicker">STEP 02</p><h3>Import profile</h3></div><button className="text-button" onClick={() => setNotice('Processing rules are managed in src/config/access-import.json.')}>View source</button></div><p className="card-copy">Choose the tables and columns once. Future uploads will reuse this selection automatically.</p><div className="profile-summary"><div className="profile-icon">⚙</div><div><strong>Repository import configuration</strong><small>{tableCount} tables · {columnCount} columns retained</small></div></div><p className="saved-at">Version {config.version} · deployed with this application</p><button className="secondary-button" onClick={() => setNotice('Processing rules are managed in src/config/access-import.json.')} >View configuration <span>→</span></button></div>
          </section>
          <section className="card refresh-card"><div className="refresh-icon">↻</div><div className="refresh-copy"><p className="section-kicker">STEP 03</p><h3>Process configured tables</h3><p>{progress || 'Apply the repository configuration locally and generate Parquet output for each configured table.'}</p></div><button className="primary-button" disabled={!file || processing} onClick={processFile}>{processing ? 'Processing…' : 'Process Access file'} <span>→</span></button></section>
          {report && <section className="card results-card"><div className="section-title"><div><p className="section-kicker">RESULT</p><h3>Processing report</h3></div></div><div className="result-list">{report.tables.map(table => <div className="result-row" key={table.name}><strong>{table.name}</strong><span>{table.rows.toLocaleString()} rows · {table.columns.length} columns · {(table.parquetBytes.byteLength / 1024).toFixed(1)} KiB Parquet</span></div>)}</div>{report.missingTables.length > 0 && <p className="error-text">Missing tables: {report.missingTables.join(', ')}</p>}{Object.entries(report.missingColumns).map(([name, columns]) => <p className="error-text" key={name}>Missing columns in {name}: {columns.join(', ')}</p>)}</section>}
          <section className="activity-section"><div className="section-title"><div><p className="section-kicker">ACTIVITY</p><h3>Recent operations</h3></div><button className="text-button">View history →</button></div><div className="empty-activity"><div className="empty-icon">◷</div><strong>No operations yet</strong><span>Your completed uploads and refreshes will appear here.</span></div></section>
        </> : <section className="placeholder card"><div className="placeholder-icon">{activeArea === 'datasets' ? '▦' : activeArea === 'query' ? '⌘' : activeArea === 'reports' ? '▤' : '⇩'}</div><p className="section-kicker">COMING NEXT</p><h2>{areas.find(area => area.id === activeArea)?.label}</h2><p>{areas.find(area => area.id === activeArea)?.description}. This area will connect to the shared R2 + Parquet data layer.</p><button className="secondary-button" onClick={() => setActiveArea('operations')}>Back to Data Operations</button></section>}


      </main>
    </div>
  )
}

export default App

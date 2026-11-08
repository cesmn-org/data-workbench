import { useEffect, useState } from 'react'
import './App.css'
import { type AccessTableSchema, type ProcessingReport } from './access-processing'

type PlanTable = { name: string; retainColumns: string[] }
type Plan = { id: string; name: string; isDefault: boolean; tables: PlanTable[]; createdAt: string; updatedAt: string }
type R2ObjectInfo = { key: string; size: number; uploaded: string; etag?: string }
type Area = 'operations' | 'plans' | 'files'

function R2Files({ objects, loading, selectedKeys, onToggle, onRefresh, onDelete }: { objects: R2ObjectInfo[]; loading: boolean; selectedKeys: Set<string>; onToggle: (key: string) => void; onRefresh: () => void; onDelete: () => void }) {
  return <section className="workspace"><div className="section-title"><div><p className="section-kicker">PRIVATE R2</p><h2>Files</h2></div><button className="secondary-button" onClick={onRefresh}>Refresh</button></div><div className="file-toolbar"><span>{objects.length} files · {selectedKeys.size} selected</span><button className="primary-button" disabled={!selectedKeys.size} onClick={onDelete}>Delete selected</button></div>{loading ? <div className="card">Loading files…</div> : <div className="file-list">{objects.map(object => <label className="file-row" key={object.key}><input type="checkbox" checked={selectedKeys.has(object.key)} onChange={() => onToggle(object.key)} /><div><strong>{object.key}</strong><span>{(object.size / 1024).toFixed(1)} KiB · {new Date(object.uploaded).toLocaleString()}</span></div></label>)}{!objects.length && <div className="card">No files found.</div>}</div>}</section>
}

function App() {
  const [area, setArea] = useState<Area>('operations')
  const [objects, setObjects] = useState<R2ObjectInfo[]>([])
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [objectsLoading, setObjectsLoading] = useState(false)
  const [plans, setPlans] = useState<Plan[]>([])
  const [selectedPlan, setSelectedPlan] = useState<Plan>()
  const [planName, setPlanName] = useState('')
  const [sourceFile, setSourceFile] = useState<File>()
  const [schemas, setSchemas] = useState<AccessTableSchema[]>([])
  const [tableFilter, setTableFilter] = useState('')
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState('')
  const [processing, setProcessing] = useState(false)
  const [progress, setProgress] = useState('')
  const [processStep, setProcessStep] = useState(0)
  const [report, setReport] = useState<ProcessingReport>()
  const [uploading, setUploading] = useState(false)
  const [uploaded, setUploaded] = useState<{ timestamp: string; objects: { table: string; key: string; size: number }[] }>()

  async function loadObjects() { setObjectsLoading(true); try { const response = await fetch('/api/objects'); const body = await response.json() as { objects: R2ObjectInfo[] }; if (!response.ok) throw new Error('Unable to load R2 files'); setObjects(body.objects); setSelectedKeys(new Set()) } catch (error) { setNotice(String(error)) } finally { setObjectsLoading(false) } }
  function toggleObject(key: string) { setSelectedKeys(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next }) }
  async function deleteSelected() { const keys = [...selectedKeys]; if (!keys.length || !confirm(`Delete ${keys.length} selected file${keys.length === 1 ? '' : 's'}?`)) return; const response = await fetch('/api/objects', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }) }); if (!response.ok) { setNotice('Unable to delete selected files'); return } await loadObjects(); setNotice(`Deleted ${keys.length} file${keys.length === 1 ? '' : 's'}.`) }

  async function loadPlans() {
    const response = await fetch('/api/plans')
    if (!response.ok) throw new Error('Unable to load plans')
    const loaded = await response.json() as Plan[]
    setPlans(loaded)
    setSelectedPlan(current => loaded.find(plan => plan.id === current?.id) ?? loaded.find(plan => plan.isDefault) ?? loaded[0])
  }
  useEffect(() => { loadPlans().catch(error => setNotice(String(error))) }, [])
  useEffect(() => { if (area === 'files') loadObjects() }, [area])

  function inspect(file: File) {
    setSourceFile(file); setSchemas([]); setReport(undefined); setUploaded(undefined); setNotice('Reading Access tables and columns…')
    const worker = new Worker(new URL('./access-processing.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => {
      if (event.data.type === 'inspected') { setSchemas(event.data.schemas); setNotice('Choose tables and columns, then save the plan.'); worker.terminate() }
      if (event.data.type === 'error') { setNotice(`Inspection failed: ${event.data.message}`); worker.terminate() }
    }
    worker.onerror = event => { setNotice(`Inspection failed: ${event.message}`); worker.terminate() }
    worker.postMessage({ file, inspect: true })
  }

  function toggleTable(schema: AccessTableSchema) {
    const current = selectedPlan?.tables ?? []
    const exists = current.some(table => table.name === schema.name)
    const tables = exists ? current.filter(table => table.name !== schema.name) : [...current, { name: schema.name, retainColumns: schema.columns }]
    setSelectedPlan(plan => plan ? { ...plan, tables } : { id: '', name: planName, isDefault: false, tables, createdAt: '', updatedAt: '' })
  }

  function toggleColumn(tableName: string, column: string) {
    setSelectedPlan(plan => plan ? { ...plan, tables: plan.tables.map(table => table.name !== tableName ? table : { ...table, retainColumns: table.retainColumns.includes(column) ? table.retainColumns.filter(item => item !== column) : [...table.retainColumns, column] }) } : plan)
  }

  async function savePlan() {
    if (!planName.trim() || !selectedPlan?.tables.length) return setNotice('Enter a plan name and select at least one table.')
    const editingExisting = Boolean(selectedPlan.id)
    const response = await fetch(editingExisting ? `/api/plans/${selectedPlan.id}` : '/api/plans', { method: editingExisting ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: planName.trim(), tables: selectedPlan.tables }) })
    const body = await response.json() as Plan & { error?: string }
    if (!response.ok) return setNotice(body.error ?? 'Unable to save plan')
    await loadPlans(); setSelectedPlan(body); setEditing(false); setNotice('Plan saved.')
  }

  async function deletePlan(plan: Plan) {
    if (!confirm(`Delete plan “${plan.name}”?`)) return
    const response = await fetch(`/api/plans/${plan.id}`, { method: 'DELETE' })
    if (!response.ok) return setNotice('Unable to delete plan')
    await loadPlans(); setNotice('Plan deleted.')
  }

  async function makeDefault(plan: Plan) {
    const response = await fetch(`/api/plans/${plan.id}`, { method: 'POST' })
    if (!response.ok) return setNotice('Unable to set default plan')
    await loadPlans(); setNotice(`“${plan.name}” is now the default plan.`)
  }

  function processFile() {
    if (!sourceFile || !selectedPlan) return
    setProcessing(true); setReport(undefined); setUploaded(undefined); setProcessStep(1); setProgress('Starting background processing…')
    const worker = new Worker(new URL('./access-processing.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = event => {
      if (event.data.type === 'progress') { const message = event.data.message as string; setProgress(message); if (message.startsWith('Reading ')) setProcessStep(2); if (message.startsWith('Writing ')) setProcessStep(3) }
      if (event.data.type === 'complete') { setReport(event.data.report); setProcessStep(4); setProcessing(false); worker.terminate(); setNotice('Processing complete. The Access file stayed in this browser.') }
      if (event.data.type === 'error') { setNotice(`Processing failed: ${event.data.message}`); setProcessing(false); worker.terminate() }
    }
    worker.onerror = event => { setNotice(`Processing failed: ${event.message}`); setProcessing(false); worker.terminate() }
    worker.postMessage({ file: sourceFile, plan: { name: selectedPlan.name, tables: Object.fromEntries(selectedPlan.tables.map(table => [table.name, { retainColumns: table.retainColumns }])) } })
  }

  async function uploadResults() {
    if (!sourceFile || !report?.tables.length) return
    setUploading(true)
    try {
      const form = new FormData(); form.set('sourceFileName', 'ACCESS')
      for (const table of report.tables) form.append('file', new File([table.parquetBytes.buffer.slice(table.parquetBytes.byteOffset, table.parquetBytes.byteOffset + table.parquetBytes.byteLength) as ArrayBuffer], `${table.name}.parquet`, { type: 'application/vnd.apache.parquet' }))
      const response = await fetch('/api/uploads', { method: 'POST', body: form }); const body = await response.json() as { error?: string; timestamp?: string; objects?: { table: string; key: string; size: number }[] }
      if (!response.ok || !body.timestamp || !body.objects) throw new Error(body.error ?? `Upload failed (${response.status})`)
      setUploaded({ timestamp: body.timestamp, objects: body.objects }); setNotice('Parquet snapshots uploaded to private R2.')
    } catch (error) { setNotice(`Upload failed: ${error instanceof Error ? error.message : String(error)}`) } finally { setUploading(false) }
  }

  const activePlan = selectedPlan ?? plans.find(plan => plan.isDefault)
  const filterText = tableFilter.toLowerCase()
  const startsWith = filterText.startsWith('^')
  const filterValue = startsWith ? filterText.slice(1) : filterText
  const visibleSchemas = schemas.filter(schema => startsWith ? schema.name.toLowerCase().startsWith(filterValue) : schema.name.toLowerCase().includes(filterValue))
  const planSummary = (plan?: Plan) => plan?.tables.map(table => `${table.name} (${table.retainColumns.length})`).join(' · ') || 'No tables selected'
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">DW</div><div><strong>Data Workbench</strong><span>Operational data, together</span></div></div><nav><p className="nav-label">WORKSPACE</p><button className={`nav-item ${area === 'operations' ? 'active' : ''}`} onClick={() => setArea('operations')}>↗ <span>Data Operations</span></button><button className={`nav-item ${area === 'plans' ? 'active' : ''}`} onClick={() => setArea('plans')}>▦ <span>Processing Plans</span></button><button className={`nav-item ${area === 'files' ? 'active' : ''}`} onClick={() => setArea('files')}>▤ <span>R2 Files</span></button></nav></aside><main className="main-content"><header className="topbar"><div><p className="eyebrow">DATA WORKBENCH / {area.toUpperCase()}</p><h1>{area === 'operations' ? 'Data Operations' : area === 'plans' ? 'Processing Plans' : 'R2 Files'}</h1></div></header>{notice && <div className="notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}{area === 'files' ? <R2Files objects={objects} loading={objectsLoading} selectedKeys={selectedKeys} onToggle={toggleObject} onRefresh={loadObjects} onDelete={deleteSelected} /> : area === 'plans' ? <section className="workspace"><div className="section-title"><div><p className="section-kicker">CONFIGURATION</p><h2>Processing plans</h2></div><button className="primary-button" onClick={() => { setEditing(true); setSelectedPlan({ id: '', name: '', isDefault: false, tables: [], createdAt: '', updatedAt: '' }); setPlanName(''); setSchemas([]) }}>New plan</button></div><div className="plan-grid">{plans.map(plan => <article className={`plan-card ${plan.isDefault ? 'default' : ''}`} key={plan.id}><div><strong>{plan.name}</strong>{plan.isDefault && <span className="plan-badge">DEFAULT</span>}</div><p>{plan.tables.length} tables · {plan.tables.reduce((sum, table) => sum + table.retainColumns.length, 0)} columns</p><details className="plan-summary"><summary>{planSummary(plan)}</summary>{plan.tables.map(table => <div className="summary-table" key={table.name}><strong>{table.name}</strong><ul>{table.retainColumns.map(column => <li key={column}>{column}</li>)}</ul></div>)}</details><div className="plan-actions"><button className="secondary-button" onClick={() => { setSelectedPlan(plan); setPlanName(plan.name); setEditing(true); setSchemas([]) }}>Edit</button>{!plan.isDefault && <button className="text-button" onClick={() => makeDefault(plan)}>Make default</button>}<button className="text-button danger" onClick={() => deletePlan(plan)}>Delete</button></div></article>)}</div>{editing && <section className="card plan-editor"><p className="section-kicker">PLAN EDITOR</p><h3>{selectedPlan?.id ? 'Edit plan' : 'New plan'}</h3><input className="plan-name" value={planName} onChange={event => setPlanName(event.target.value)} placeholder="Plan name" /><p className="card-copy">Upload an Access file to inspect its tables and columns, then choose what this plan retains.</p><label className="secondary-button editor-file"><input type="file" accept=".accdb,.mdb,application/x-msaccess" onChange={event => event.target.files?.[0] && inspect(event.target.files[0])} />{sourceFile ? `Inspecting ${sourceFile.name}` : 'Choose Access file'}</label>{schemas.length > 0 && <input className="table-filter" value={tableFilter} onChange={event => setTableFilter(event.target.value)} placeholder="Filter tables… (use ^ for starts with)" />}{selectedPlan?.tables.length ? <div className="editor-summary"><strong>Selected in this plan</strong>{selectedPlan.tables.map(table => <div key={table.name}>{table.name}<span>{table.retainColumns.length} columns</span></div>)}</div> : null}{visibleSchemas.map(schema => { const selection = selectedPlan?.tables.find(table => table.name === schema.name); return <div className="schema-editor" key={schema.name}><label><input type="checkbox" checked={Boolean(selection)} onChange={() => toggleTable(schema)} /> <strong>{schema.name}</strong></label>{selection && <div className="column-grid">{schema.columns.map(column => <label key={column}><input type="checkbox" checked={selection.retainColumns.includes(column)} onChange={() => toggleColumn(schema.name, column)} />{column}</label>)}</div>}</div>})}<div className="modal-footer"><button className="secondary-button" onClick={() => setEditing(false)}>Cancel</button><button className="primary-button" onClick={savePlan}>Save plan</button></div></section>}</section> : <section className="workspace"><div className="hero"><div><p className="section-kicker">LOCAL-FIRST INGESTION</p><h2>Process with a plan, publish a snapshot.</h2><p>Access files stay in your browser. Choose a saved plan, generate Parquet locally, then upload the prepared snapshot to private R2.</p></div><div className="privacy-badge">✓ <span>Raw files stay local</span></div></div><div className="operation-grid"><section className="card"><p className="section-kicker">STEP 01</p><h3>Choose an Access file</h3><label className="dropzone"><input type="file" accept=".accdb,.mdb,application/x-msaccess" onChange={event => event.target.files?.[0] && inspect(event.target.files[0])}/><span className="upload-icon">↑</span><strong>{sourceFile?.name || 'Choose an Access file'}</strong><small>Used only to inspect and process locally</small></label></section><section className="card"><p className="section-kicker">STEP 02</p><h3>Choose a processing plan</h3><select className="plan-select" value={activePlan?.id ?? ''} onChange={event => setSelectedPlan(plans.find(plan => plan.id === event.target.value))}><option value="">Select a plan</option>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}{plan.isDefault ? ' (default)' : ''}</option>)}</select><p className="card-copy">{activePlan ? `${activePlan.tables.length} tables selected` : 'Create a plan before processing.'}</p>{activePlan && <div className="compact-plan-summary">{activePlan.tables.map(table => <details key={table.name}><summary><strong>{table.name}</strong><span>{table.retainColumns.length} columns</span></summary><ul>{table.retainColumns.map(column => <li key={column}>{column}</li>)}</ul></details>)}</div>}<button className="secondary-button" onClick={() => setArea('plans')}>Manage plans →</button></section></div><section className="card refresh-card"><div className="refresh-copy"><p className="section-kicker">STEP 03</p><h3>Process configured tables</h3><ol className="process-steps">{['Read Access file','Read configured tables','Write Parquet files','Complete'].map((step, index) => <li className={processStep > index ? 'done' : processStep === index + 1 ? 'current' : ''} key={step}><span>{processStep > index ? '✓' : index + 1}</span>{step}</li>)}</ol><p className="progress-message">{progress || 'Generate Parquet in the browser using the selected plan.'}</p></div><button className="primary-button" disabled={!sourceFile || !activePlan || processing} onClick={processFile}>{processing ? 'Processing…' : 'Process Access file'} →</button></section>{report && <section className="card results-card"><div className="section-title"><div><p className="section-kicker">RESULT</p><h3>Processing report</h3></div></div>{report.tables.map(table => <div className="result-row" key={table.name}><strong>{table.name}</strong><span>{table.rows.toLocaleString()} rows · {table.columns.length} columns · {(table.parquetBytes.byteLength / 1024).toFixed(1)} KiB</span></div>)}<button className="primary-button upload-results-button" disabled={uploading} onClick={uploadResults}>{uploading ? 'Uploading…' : 'Upload snapshots to R2'} →</button>{uploaded && <div className="upload-summary"><strong>Uploaded batch {uploaded.timestamp}</strong>{uploaded.objects.map(object => <span key={object.key}>{object.key}</span>)}</div>}</section>}</section>}</main></div>
}

export default App

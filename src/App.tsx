import { useEffect, useMemo, useState } from 'react'
import './App.css'

type Area = 'operations' | 'datasets' | 'query' | 'reports' | 'exports'
type Profile = { name: string; tables: Record<string, string[]>; updatedAt: string }

const areas: { id: Area; label: string; description: string }[] = [
  { id: 'operations', label: 'Data Operations', description: 'Upload Access files and monitor refreshes' },
  { id: 'datasets', label: 'Datasets', description: 'Browse snapshots and source tables' },
  { id: 'query', label: 'Query', description: 'Explore data with SQL' },
  { id: 'reports', label: 'Reports', description: 'Reuse saved queries' },
  { id: 'exports', label: 'Exports', description: 'Download query results' },
]

const starterProfile: Profile = { name: 'Access import profile', tables: {}, updatedAt: '' }

function App() {
  const [activeArea, setActiveArea] = useState<Area>('operations')
  const [profile, setProfile] = useState<Profile>(() => {
    try { return JSON.parse(localStorage.getItem('data-workbench-profile') ?? 'null') ?? starterProfile } catch { return starterProfile }
  })
  const [fileName, setFileName] = useState('')
  const [showSetup, setShowSetup] = useState(Object.keys(profile.tables).length === 0)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    localStorage.setItem('data-workbench-profile', JSON.stringify(profile))
  }, [profile])

  const tableCount = Object.keys(profile.tables).length
  const columnCount = useMemo(() => Object.values(profile.tables).reduce((total, columns) => total + columns.length, 0), [profile])

  function chooseFile(file?: File) {
    if (!file) return
    setFileName(file.name)
    setNotice('File selected. The saved import profile will be applied automatically when processing is connected.')
    if (tableCount === 0) setShowSetup(true)
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
            <div className="card upload-card"><div className="card-heading"><div><p className="section-kicker">STEP 01</p><h3>Upload Access database</h3></div><span className="step-badge">1</span></div><p className="card-copy">Choose an <code>.accdb</code> file. Its contents will be read and transformed locally in your browser.</p><label className="dropzone"><input type="file" accept=".accdb,.mdb,application/x-msaccess" onChange={event => chooseFile(event.target.files?.[0])} /><span className="upload-icon">↑</span><strong>{fileName || 'Choose an Access file'}</strong><small>{fileName ? 'Ready for the saved import profile' : 'or drag and drop it here'}</small></label>{fileName && <div className="selected-file"><span className="file-icon">▣</span><div><strong>{fileName}</strong><small>Selected locally</small></div><span className="check">✓</span></div>}</div>
            <div className="card profile-card"><div className="card-heading"><div><p className="section-kicker">STEP 02</p><h3>Import profile</h3></div><button className="text-button" onClick={() => setShowSetup(true)}>Edit profile</button></div><p className="card-copy">Choose the tables and columns once. Future uploads will reuse this selection automatically.</p><div className="profile-summary"><div className="profile-icon">⚙</div><div><strong>{profile.name}</strong><small>{tableCount ? `${tableCount} table${tableCount === 1 ? '' : 's'} · ${columnCount} column${columnCount === 1 ? '' : 's'} retained` : 'No tables configured yet'}</small></div></div>{profile.updatedAt && <p className="saved-at">Last saved {new Date(profile.updatedAt).toLocaleString()}</p>}<button className="secondary-button" onClick={() => setShowSetup(true)}>{tableCount ? 'Review retained fields' : 'Set up retained fields'} <span>→</span></button></div>
          </section>
          <section className="card refresh-card"><div className="refresh-icon">↻</div><div className="refresh-copy"><p className="section-kicker">STEP 03</p><h3>Refresh all data</h3><p>After the Access snapshot is prepared, run the configured source refreshes and monitor their status here.</p></div><button className="primary-button" disabled={!fileName || !tableCount}>Prepare refresh <span>→</span></button></section>
          <section className="activity-section"><div className="section-title"><div><p className="section-kicker">ACTIVITY</p><h3>Recent operations</h3></div><button className="text-button">View history →</button></div><div className="empty-activity"><div className="empty-icon">◷</div><strong>No operations yet</strong><span>Your completed uploads and refreshes will appear here.</span></div></section>
        </> : <section className="placeholder card"><div className="placeholder-icon">{activeArea === 'datasets' ? '▦' : activeArea === 'query' ? '⌘' : activeArea === 'reports' ? '▤' : '⇩'}</div><p className="section-kicker">COMING NEXT</p><h2>{areas.find(area => area.id === activeArea)?.label}</h2><p>{areas.find(area => area.id === activeArea)?.description}. This area will connect to the shared R2 + Parquet data layer.</p><button className="secondary-button" onClick={() => setActiveArea('operations')}>Back to Data Operations</button></section>}

        {showSetup && <div className="modal-backdrop" role="presentation"><div className="modal" role="dialog" aria-modal="true" aria-labelledby="profile-title"><div className="modal-header"><div><p className="section-kicker">IMPORT PROFILE</p><h2 id="profile-title">Configure retained fields</h2></div><button className="close-button" onClick={() => setShowSetup(false)} aria-label="Close">×</button></div><p className="modal-copy">This is a preview of the reusable selection step. The Access schema will populate these choices after the file is read locally.</p><div className="schema-preview"><div className="schema-row"><label><input type="checkbox" defaultChecked /> <strong>Service records</strong></label><span>12 columns available</span></div><div className="field-list"><label><input type="checkbox" defaultChecked /> Service date</label><label><input type="checkbox" defaultChecked /> Program</label><label><input type="checkbox" defaultChecked /> Household ID</label><label><input type="checkbox" /> Direct identifier <em>excluded</em></label></div><div className="schema-row"><label><input type="checkbox" /> Client details</label><span>8 columns available</span></div></div><div className="modal-footer"><button className="secondary-button" onClick={() => setShowSetup(false)}>Cancel</button><button className="primary-button" onClick={() => { setProfile({ name: 'Access import profile', tables: { 'Service records': ['Service date', 'Program', 'Household ID'] }, updatedAt: new Date().toISOString() }); setShowSetup(false); setNotice('Import profile saved locally in this browser.') }}>Save profile <span>→</span></button></div></div></div>}
      </main>
    </div>
  )
}

export default App

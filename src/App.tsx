import { useEffect, useState } from 'react'
import './App.css'
import { deleteObjects, listObjects } from './app/api'
import type { Area } from './app/types'
import { AccessProcessor } from './components/AccessProcessor'
import { DeleteFilesModal } from './components/DeleteFilesModal'
import { R2Files } from './components/R2Files'
import { SourceRefresh } from './components/SourceRefresh'
import { Reports } from './report'
import type { R2ObjectInfo } from './types'

function App() {
  const [area, setArea] = useState<Area>('operations'); const [objects, setObjects] = useState<R2ObjectInfo[]>([]); const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set()); const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false); const [objectsLoading, setObjectsLoading] = useState(false); const [notice, setNotice] = useState('')
  async function loadObjects() { setObjectsLoading(true); try { setObjects(await listObjects()); setSelectedKeys(new Set()) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } finally { setObjectsLoading(false) } }
  useEffect(() => { if (area === 'files' || area === 'reports') void loadObjects() }, [area])
  function toggleObject(key: string) { setSelectedKeys(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next }) }
  async function deleteSelected() { const keys = [...selectedKeys]; if (!keys.length) return; setDeleteConfirmOpen(false); try { await deleteObjects(keys); await loadObjects(); setNotice(`Deleted ${keys.length} file${keys.length === 1 ? '' : 's'}.`) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } }
  const title = area === 'operations' ? 'Data Operations' : area === 'files' ? 'R2 Files' : 'Reports'
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">DW</div><div><strong>Data Workbench</strong><span>Operational data, together</span></div></div><nav><p className="nav-label">WORKSPACE</p>{(['operations', 'files', 'reports'] as Area[]).map(item => <button key={item} className={`nav-item ${area === item ? 'active' : ''}`} onClick={() => setArea(item)}>{item === 'operations' ? '↗' : item === 'files' ? '▤' : '▥'} <span>{item === 'operations' ? 'Data Operations' : item === 'files' ? 'R2 Files' : 'Reports'}</span></button>)}</nav></aside><main className="main-content"><header className="topbar"><div><p className="eyebrow">DATA WORKBENCH / {area.toUpperCase()}</p><h1>{title}</h1></div></header>{notice && <div className="notice">{notice}<button onClick={() => setNotice('')}>×</button></div>}{area === 'files' ? <R2Files objects={objects} loading={objectsLoading} selectedKeys={selectedKeys} onToggle={toggleObject} onRefresh={loadObjects} onDelete={() => setDeleteConfirmOpen(true)} /> : area === 'reports' ? <Reports objects={objects} loading={objectsLoading} onRefresh={loadObjects} /> : <><AccessProcessor onNotice={setNotice} /><SourceRefresh onNotice={setNotice} /></> }</main>{deleteConfirmOpen && <DeleteFilesModal count={selectedKeys.size} onCancel={() => setDeleteConfirmOpen(false)} onConfirm={deleteSelected} />}</div>
}
export default App

import type { R2ObjectInfo } from '../types'

export type Area = 'operations' | 'files' | 'reports'
export type RefreshWorkflow = { workflow: string; status?: string }
export type RefreshResult = { timestamp: string; workflows: RefreshWorkflow[] }
export type UploadResult = { timestamp: string; objects: { table: string; key: string; size: number }[] }
export type { R2ObjectInfo }

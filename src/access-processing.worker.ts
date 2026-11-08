import { Buffer } from 'buffer'

;(globalThis as typeof globalThis & { Buffer: typeof Buffer; process?: unknown }).Buffer = Buffer
;(globalThis as typeof globalThis & { process?: unknown }).process = { browser: true, env: {}, versions: {}, nextTick: queueMicrotask } as any

self.onmessage = async (event: MessageEvent<{ file: File; plan?: { name?: string; tables: Record<string, { retainColumns: string[] }> }; inspect?: boolean }>) => {
  try {
    const { inspectAccessFile, processAccessFile } = await import('./access-processing')
    if (event.data.inspect) {
      const schemas = await inspectAccessFile(event.data.file)
      self.postMessage({ type: 'inspected', schemas })
      return
    }
    const report = await processAccessFile(event.data.file, message => self.postMessage({ type: 'progress', message }), event.data.plan)
    self.postMessage({ type: 'complete', report })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

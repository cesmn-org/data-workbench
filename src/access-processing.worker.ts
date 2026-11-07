import { Buffer } from 'buffer'
import { processAccessFile } from './access-processing'

;(globalThis as typeof globalThis & { Buffer: typeof Buffer; process?: unknown }).Buffer = Buffer
;(globalThis as typeof globalThis & { process?: unknown }).process = { browser: true, env: {}, versions: {}, nextTick: queueMicrotask } as any

self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  try {
    const report = await processAccessFile(event.data.file, message => self.postMessage({ type: 'progress', message }))
    self.postMessage({ type: 'complete', report })
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

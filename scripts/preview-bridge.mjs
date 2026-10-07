import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = '127.0.0.1'
const PORT = 5195
const ALLOWED_ORIGIN = 'http://localhost:5194'
const MAX_HTTP_BODY = 1024 * 1024
const MAX_RECORD_BYTES = 8 * 1024 * 1024
const MAX_CHUNK_BYTES = 1024 * 1024
const PROTOCOL_VERSION = 5
const ACTIONS = new Set([
  'pickTarget',
  'pickMedia',
  'desktopEntries',
  'open',
  'mediaInfo',
  'mediaChunk',
])

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const companionPath = process.env.MWP_PANELS_COMPANION
  ? resolve(process.env.MWP_PANELS_COMPANION)
  : resolve(projectRoot, 'native/out/windows-x86_64/bin/desktop-panels.exe')
const token = randomBytes(32).toString('hex')
const pending = new Map()
let nextRequestId = 1
let companion = null
let companionReady = false
const servers = []
let bufferedStdout = Buffer.alloc(0)
let recordParts = []
let recordBytes = 0
let continuationStarted = false

function encodeRecord(value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  if (bytes.length === 0 || bytes.length > MAX_RECORD_BYTES) {
    throw new Error('Preview command record exceeds the 8 MiB limit.')
  }
  const chunks = []
  for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES) {
    chunks.push(bytes.subarray(offset, Math.min(bytes.length, offset + MAX_CHUNK_BYTES)))
  }
  if (chunks.length === 1) return encodeChunk(0, chunks[0])
  return Buffer.concat(chunks.map((chunk, index) => {
    const kind = index === 0 ? 1 : index === chunks.length - 1 ? 3 : 2
    return encodeChunk(kind, chunk)
  }))
}

function encodeChunk(kind, bytes) {
  if (bytes.length === 0 || bytes.length > MAX_CHUNK_BYTES) {
    throw new Error('Invalid process-v2 chunk length.')
  }
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32LE((((kind & 0b11) << 30) | bytes.length) >>> 0)
  return Buffer.concat([header, bytes])
}

function sendRecord(value) {
  if (!companion || companion.exitCode !== null || companion.stdin.destroyed) {
    return Promise.reject(new Error('Preview companion is unavailable.'))
  }
  let frame
  try {
    frame = encodeRecord(value)
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise((resolveWrite, rejectWrite) => {
    companion.stdin.write(frame, (error) => {
      if (error) rejectWrite(error)
      else resolveWrite()
    })
  })
}

function handleCompanionRecord(record) {
  if (!record || record.v !== PROTOCOL_VERSION) {
    failCompanion(new Error('Preview companion returned an invalid protocol record.'))
    return
  }
  if (record.type === 'ready') {
    companionReady = true
    return
  }
  if (record.type === 'error') {
    failCompanion(new Error(typeof record.message === 'string'
      ? record.message
      : 'Preview companion reported a protocol error.'))
    return
  }
  if (record.type !== 'message' || record.payload?.kind !== 'panels.result') return

  const request = pending.get(record.payload.requestId)
  if (!request) return
  pending.delete(record.payload.requestId)
  clearTimeout(request.timeout)
  request.resolve({
    ok: record.payload.ok === true,
    ...(Object.hasOwn(record.payload, 'result') ? { result: record.payload.result } : {}),
    ...(typeof record.payload.error === 'string' ? { error: record.payload.error } : {}),
  })
}

function decodeV5Chunk(kind, payload) {
  if (kind === 0) {
    if (continuationStarted) throw new Error('Single chunk interrupted a companion record.')
    handleCompanionRecord(JSON.parse(payload.toString('utf8')))
    return
  }
  if (kind === 1) {
    if (continuationStarted) throw new Error('Nested companion record start.')
    continuationStarted = true
    recordParts = [payload]
    recordBytes = payload.length
    return
  }
  if (!continuationStarted) throw new Error('Companion continuation without a record start.')
  recordParts.push(payload)
  recordBytes += payload.length
  if (recordBytes > MAX_RECORD_BYTES) throw new Error('Companion record exceeds the 8 MiB limit.')
  if (kind === 3) {
    const record = Buffer.concat(recordParts, recordBytes)
    continuationStarted = false
    recordParts = []
    recordBytes = 0
    handleCompanionRecord(JSON.parse(record.toString('utf8')))
  } else if (kind !== 2) {
    throw new Error('Invalid companion continuation chunk.')
  }
}

function consumeStdout(chunk) {
  bufferedStdout = bufferedStdout.length === 0
    ? chunk
    : Buffer.concat([bufferedStdout, chunk])

  while (bufferedStdout.length >= 4) {
    const header = bufferedStdout.readUInt32LE(0)
    const kind = header >>> 30
    const size = header & 0x3fffffff
    if (size === 0 || size > MAX_CHUNK_BYTES) {
      throw new Error('Preview companion emitted an invalid chunk length.')
    }
    if (bufferedStdout.length < 4 + size) return
    const payload = bufferedStdout.subarray(4, 4 + size)
    bufferedStdout = bufferedStdout.subarray(4 + size)
    decodeV5Chunk(kind, payload)
  }
}

function failCompanion(error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[preview-bridge] ${message}`)
  for (const [requestId, request] of pending) {
    clearTimeout(request.timeout)
    request.resolve({ ok: false, error: message, requestId })
  }
  pending.clear()
  if (companion && companion.exitCode === null) companion.kill()
  for (const server of servers) server.close()
}

function waitForReady() {
  return new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(new Error('Preview companion did not send ready within two seconds.'))
    }, 2000)
    const interval = setInterval(() => {
      if (!companionReady) return
      clearTimeout(timer)
      clearInterval(interval)
      resolveReady()
    }, 10)
    companion.once('exit', (code, signal) => {
      clearTimeout(timer)
      clearInterval(interval)
      rejectReady(new Error(`Preview companion exited before ready (${code ?? signal}).`))
    })
    companion.once('error', (error) => {
      clearTimeout(timer)
      clearInterval(interval)
      rejectReady(error)
    })
  })
}

function isLoopbackRequest(request) {
  const peer = request.socket.remoteAddress
  const host = request.headers.host
  return [
    '127.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
  ].includes(peer)
    && (host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`)
}

function setCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Panels-Token')
  response.setHeader('Vary', 'Origin')
  response.setHeader('Cache-Control', 'no-store')
}

function sendJson(response, status, value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': bytes.length,
  })
  response.end(bytes)
}

async function readJsonBody(request) {
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > MAX_HTTP_BODY) throw Object.assign(new Error('Request body is too large.'), { status: 413 })
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'))
  } catch {
    throw Object.assign(new Error('Request body must be valid JSON.'), { status: 400 })
  }
}

function tokenMatches(value) {
  if (typeof value !== 'string') return false
  const supplied = Buffer.from(value, 'utf8')
  const expected = Buffer.from(token, 'utf8')
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function issueCommand(action, input) {
  if (!companionReady) return Promise.reject(new Error('Preview companion is not ready.'))
  const requestId = `preview-${nextRequestId++}`
  const payload = { kind: 'panels.command', requestId, action, input }
  const promise = new Promise((resolveResult, rejectResult) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId)
      rejectResult(new Error('Preview command timed out.'))
    }, 5 * 60 * 1000)
    pending.set(requestId, { resolve: resolveResult, reject: rejectResult, timeout })
  })
  return sendRecord({
    type: 'message',
    v: PROTOCOL_VERSION,
    payload,
  }).then(() => promise).catch((error) => {
    const request = pending.get(requestId)
    if (request) {
      clearTimeout(request.timeout)
      pending.delete(requestId)
      request.reject(error)
    }
    throw error
  })
}

function listen(server, host) {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error)
    server.once('error', onError)
    server.listen(PORT, host, () => {
      server.off('error', onError)
      resolveListen()
    })
  })
}

async function handleRequest(request, response) {
  if (!isLoopbackRequest(request)) {
    sendJson(response, 403, { ok: false, error: 'Loopback requests only.' })
    return
  }
  if (request.headers.origin !== ALLOWED_ORIGIN) {
    sendJson(response, 403, { ok: false, error: 'Preview origin is not allowed.' })
    return
  }
  setCorsHeaders(response)

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }
  if (request.method === 'GET' && request.url === '/session') {
    sendJson(response, 200, { token })
    return
  }
  if (request.method !== 'POST' || request.url !== '/command') {
    sendJson(response, 404, { ok: false, error: 'Unknown preview bridge endpoint.' })
    return
  }
  if (!tokenMatches(request.headers['x-panels-token'])) {
    sendJson(response, 403, { ok: false, error: 'Preview session token is invalid.' })
    return
  }

  try {
    const body = await readJsonBody(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(response, 400, { ok: false, error: 'Command request must be an object.' })
      return
    }
    if (typeof body.action !== 'string' || !ACTIONS.has(body.action)) {
      sendJson(response, 400, { ok: false, error: 'Unknown Desktop Panels command.' })
      return
    }
    const input = body.input ?? {}
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      sendJson(response, 400, { ok: false, error: 'Command input must be an object.' })
      return
    }
    const result = await issueCommand(body.action, input)
    sendJson(response, 200, result)
  } catch (error) {
    const status = Number.isInteger(error?.status) ? error.status : 502
    sendJson(response, status, {
      ok: false,
      error: error instanceof Error ? error.message : 'Preview command failed.',
    })
  }
}

async function start() {
  if (process.platform !== 'win32') {
    throw new Error('The preview bridge must run on Windows to spawn the companion executable.')
  }
  if (!existsSync(companionPath)) {
    throw new Error(`Companion executable was not found at ${companionPath}. Build native/companion first.`)
  }

  companion = spawn(companionPath, [], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  companion.stdout.on('data', (chunk) => {
    try {
      consumeStdout(chunk)
    } catch (error) {
      failCompanion(error)
    }
  })
  companion.stderr.on('data', (chunk) => {
    const message = chunk.toString('utf8').trim()
    if (message) console.error(`[companion] ${message}`)
  })
  companion.stdin.on('error', failCompanion)
  companion.on('exit', (code, signal) => {
    for (const server of servers) server.close()
    const message = `Preview companion exited (${code ?? signal}).`
    for (const request of pending.values()) {
      clearTimeout(request.timeout)
      request.resolve({ ok: false, error: message })
    }
    pending.clear()
  })

  await sendRecord({
    type: 'init',
    v: PROTOCOL_VERSION,
    addonId: 'mywallpaper.desktop-panels.preview',
    addonReleaseId: 'local-preview',
    layerId: 'local-preview',
    settings: {},
    layerSettings: {},
    deviceSettings: {},
  })
  await waitForReady()

  const requestHandler = (request, response) => {
    void handleRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 500, { ok: false, error: String(error) })
      } else {
        response.destroy(error instanceof Error ? error : undefined)
      }
    })
  }
  const ipv4Server = createServer(requestHandler)
  const ipv6Server = createServer(requestHandler)
  servers.push(ipv4Server, ipv6Server)
  for (const server of servers) server.on('error', failCompanion)
  await Promise.all([listen(ipv4Server, HOST), listen(ipv6Server, '::1')])
  console.log(`[preview-bridge] listening on localhost:${PORT} (IPv4/IPv6 loopback) for ${ALLOWED_ORIGIN}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  start().catch((error) => {
    console.error(`[preview-bridge] ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
    for (const server of servers) server.close()
    if (companion && companion.exitCode === null) companion.kill()
  })
}

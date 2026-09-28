import 'dotenv/config'
import express from 'express'
import OpenAI from 'openai'
import { MongoClient } from 'mongodb'
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const app = express()
const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '127.0.0.1'
const jevUrl = 'https://api.typesafe.ai/v1/systemone'
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017'
const databaseName = process.env.MONGODB_DATABASE || 'jev_studio'
const googleClientId = process.env.GOOGLE_CLIENT_ID || ''
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || ''
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/api/auth/google/callback`
const sessionDays = 30
const freeQuotas = { maxClassifiers: 5, monthlyApiCalls: 1000 }
const analyticsRetentionSeconds = 90 * 24 * 60 * 60
const platformAdminEmails = new Set(String(process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))
const googleAuthorizationEndpoint = 'https://accounts.google.com/o/oauth2/v2/auth'
const googleTokenEndpoint = 'https://oauth2.googleapis.com/token'
const googleJwksEndpoint = 'https://www.googleapis.com/oauth2/v3/certs'
let googleJwks = { expiresAt: 0, keys: [] }

app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))

let mongoClient
let database
let databasePromise

async function getDb() {
  if (database) return database
  if (!databasePromise) databasePromise = (async () => {
    mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2500 })
    await mongoClient.connect()
    const db = mongoClient.db(databaseName)
    if (!await db.listCollections({ name: 'api_call_events' }).hasNext()) {
      await db.createCollection('api_call_events', {
        timeseries: { timeField: 'timestamp', metaField: 'workspaceId', granularity: 'minutes' },
        expireAfterSeconds: analyticsRetentionSeconds,
      })
    }
    await Promise.all([
      db.collection('users').createIndex({ googleSub: 1 }, { unique: true }),
      db.collection('workspaces').createIndex({ id: 1 }, { unique: true }),
      db.collection('workspace_memberships').createIndex({ userId: 1, workspaceId: 1 }, { unique: true }),
      db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true }),
      db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('oauth_states').createIndex({ stateHash: 1 }, { unique: true }),
      db.collection('oauth_states').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      db.collection('classifiers').createIndex({ id: 1 }, { unique: true }),
      db.collection('classifiers').createIndex({ workspaceId: 1, updatedAt: -1 }),
      db.collection('builder_sessions').createIndex({ id: 1 }, { unique: true }),
      db.collection('builder_sessions').createIndex({ workspaceId: 1, updatedAt: -1 }),
      db.collection('api_keys').createIndex({ keyHash: 1 }, { unique: true }),
      db.collection('api_keys').createIndex({ workspaceId: 1, revokedAt: 1 }),
      db.collection('usage_counters').createIndex({ workspaceId: 1, period: 1, metric: 1 }, { unique: true }),
      db.collection('usage_rollups').createIndex({ workspaceId: 1, day: 1, classifierId: 1, source: 1 }, { unique: true }),
      db.collection('api_call_events').createIndex({ workspaceId: 1, timestamp: -1 }),
      db.collection('api_call_events').createIndex({ workspaceId: 1, classifierId: 1, timestamp: -1 }),
    ])
    database = db
    return db
  })().catch((error) => {
    databasePromise = null
    throw error
  })
  return databasePromise
}

function id(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`
}

function hashKey(value) {
  return createHash('sha256').update(value).digest('hex')
}

function cleanDocument(document) {
  if (!document) return null
  const { _id, ...clean } = document
  return clean
}

function handleRoute(handler) {
  return async (request, response) => {
    try {
      await handler(request, response)
    } catch (error) {
      console.error(error)
      const isMongo = error?.name?.includes('Mongo') || error?.message?.includes('ECONNREFUSED')
      response.status(error.status || (isMongo ? 503 : 500)).json({
        error: isMongo ? 'MongoDB is not available.' : error.message || 'Something went wrong.',
        code: error.code,
        limit: error.limit,
        used: error.used,
        resetsAt: error.resetsAt,
        detail: isMongo ? 'Start MongoDB and verify MONGODB_URI in .env.' : undefined,
        upstream: error.data,
      })
    }
  }
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter(([key]) => key))
}

function sessionCookie(value, maxAge = sessionDays * 24 * 60 * 60) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `jev_session=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

function oauthCookie(value, maxAge = 600) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `jev_oauth_state=${encodeURIComponent(value)}; Path=/api/auth/google/callback; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

function decodeJwtSegment(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

async function getGoogleSigningKeys() {
  if (googleJwks.expiresAt > Date.now()) return googleJwks.keys
  const response = await fetch(googleJwksEndpoint, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error('Could not retrieve Google signing keys.')
  const body = await response.json()
  const maxAge = Number(response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1] || 3600)
  googleJwks = { keys: body.keys || [], expiresAt: Date.now() + maxAge * 1000 }
  return googleJwks.keys
}

async function verifyGoogleIdToken(idToken, expectedNonce) {
  const parts = String(idToken).split('.')
  if (parts.length !== 3) throw new Error('Google returned an invalid identity token.')
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  const header = decodeJwtSegment(encodedHeader)
  const payload = decodeJwtSegment(encodedPayload)
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Google returned an unsupported identity token.')
  const jwk = (await getGoogleSigningKeys()).find((key) => key.kid === header.kid)
  if (!jwk) throw new Error('Google identity signing key was not found.')
  const validSignature = verifySignature('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(encodedSignature, 'base64url'))
  const now = Math.floor(Date.now() / 1000)
  const validAudience = Array.isArray(payload.aud) ? payload.aud.includes(googleClientId) : payload.aud === googleClientId
  if (!validSignature || !['https://accounts.google.com', 'accounts.google.com'].includes(payload.iss) || !validAudience || payload.exp <= now || payload.iat > now + 60 || !safeEqual(payload.nonce, expectedNonce)) {
    throw new Error('Google identity token validation failed.')
  }
  return payload
}

async function exchangeGoogleCode(code) {
  const response = await fetch(googleTokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: googleClientId, client_secret: googleClientSecret, redirect_uri: googleRedirectUri, grant_type: 'authorization_code' }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.id_token) throw new Error(body.error_description || 'Google sign-in could not be completed.')
  return body.id_token
}

function workspaceName(profile) {
  const firstName = String(profile.given_name || profile.name || profile.email?.split('@')[0] || 'My').trim().split(/\s+/)[0]
  return `${firstName}'s Workspace`
}

async function ensurePersonalWorkspace(db, user, profile) {
  const membership = await db.collection('workspace_memberships').findOne({ userId: user.id }, { sort: { createdAt: 1 } })
  if (membership) return db.collection('workspaces').findOne({ id: membership.workspaceId })
  const now = new Date()
  const workspace = {
    id: id('ws'),
    name: workspaceName(profile),
    type: 'personal',
    plan: 'free',
    quotas: { ...freeQuotas },
    usage: { activeClassifiers: 0 },
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  }
  await db.collection('workspaces').insertOne(workspace)
  await db.collection('workspace_memberships').insertOne({ id: id('mem'), workspaceId: workspace.id, userId: user.id, role: 'owner', createdAt: now })

  const legacyClaim = await db.collection('system_settings').updateOne(
    { _id: 'legacy_workspace_claim' },
    { $setOnInsert: { workspaceId: workspace.id, claimedAt: now } },
    { upsert: true },
  )
  if (legacyClaim.upsertedCount) {
    await Promise.all([
      db.collection('classifiers').updateMany({ workspaceId: { $exists: false } }, { $set: { workspaceId: workspace.id, createdBy: user.id } }),
      db.collection('builder_sessions').updateMany({ workspaceId: { $exists: false } }, { $set: { workspaceId: workspace.id, userId: user.id } }),
      db.collection('api_keys').updateMany({ workspaceId: { $exists: false } }, { $set: { workspaceId: workspace.id, createdBy: user.id } }),
    ])
    const activeClassifiers = await db.collection('classifiers').countDocuments({ workspaceId: workspace.id, archivedAt: null })
    await db.collection('workspaces').updateOne({ id: workspace.id }, { $set: { 'usage.activeClassifiers': activeClassifiers } })
    workspace.usage.activeClassifiers = activeClassifiers
  }
  return workspace
}

async function requireSession(request, response, next) {
  try {
    const token = parseCookies(request).jev_session
    if (!token) return response.status(401).json({ error: 'Sign in to continue.', code: 'authentication_required' })
    const db = await getDb()
    const session = await db.collection('sessions').findOne({ tokenHash: hashKey(token), expiresAt: { $gt: new Date() } })
    if (!session) return response.status(401).json({ error: 'Your session has expired.', code: 'authentication_required' })
    const [user, workspace, membership] = await Promise.all([
      db.collection('users').findOne({ id: session.userId }),
      db.collection('workspaces').findOne({ id: session.workspaceId }),
      db.collection('workspace_memberships').findOne({ userId: session.userId, workspaceId: session.workspaceId }),
    ])
    if (!user || !workspace || !membership) return response.status(401).json({ error: 'Your workspace session is no longer valid.', code: 'authentication_required' })
    request.auth = { session, user, workspace, membership }
    request.workspaceId = workspace.id
    next()
  } catch (error) {
    next(error)
  }
}

function currentPeriod(date = new Date()) {
  return date.toISOString().slice(0, 7)
}

function nextPeriodStart(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
}

async function reserveJevExecution(db, workspace) {
  const period = currentPeriod()
  const key = { workspaceId: workspace.id, period, metric: 'jev_executions' }
  const limit = workspace.quotas?.monthlyApiCalls ?? freeQuotas.monthlyApiCalls
  await db.collection('usage_counters').updateOne(key, { $setOnInsert: { used: 0, createdAt: new Date() }, $set: { limit, updatedAt: new Date() } }, { upsert: true })
  const counter = await db.collection('usage_counters').findOneAndUpdate(
    { ...key, used: { $lt: limit } },
    { $inc: { used: 1 }, $set: { updatedAt: new Date(), limit } },
    { returnDocument: 'after' },
  )
  if (!counter) {
    const current = await db.collection('usage_counters').findOne(key)
    const error = new Error('Monthly API quota exceeded.')
    Object.assign(error, { status: 429, code: 'quota_exceeded', limit, used: current?.used || limit, resetsAt: nextPeriodStart() })
    throw error
  }
  return counter
}

async function recordApiCall(db, event) {
  const timestamp = event.timestamp || new Date()
  const day = timestamp.toISOString().slice(0, 10)
  await Promise.all([
    db.collection('api_call_events').insertOne({ ...event, timestamp }),
    db.collection('usage_rollups').updateOne(
      { workspaceId: event.workspaceId, day, classifierId: event.classifierId, source: event.source },
      {
        $inc: {
          calls: 1,
          successes: event.status === 'success' ? 1 : 0,
          failures: event.status === 'success' ? 0 : 1,
          totalLatencyMs: event.latencyMs || 0,
        },
        $set: { updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true },
    ),
  ])
}

const builderSchema = {
  type: 'object',
  properties: {
    assistant_message: { type: 'string' },
    ready: { type: 'boolean' },
    suggested_name: { type: 'string' },
    suggested_description: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          type: { type: 'string', enum: ['choice', 'score', 'noul'] },
          instructions: { type: 'string' },
          choice_options: {
            type: 'array',
            items: {
              type: 'object',
              properties: { key: { type: 'string' }, description: { type: 'string' } },
              required: ['key', 'description'],
              additionalProperties: false,
            },
          },
          score_levels: { type: 'array', items: { type: 'string' } },
        },
        required: ['key', 'type', 'instructions', 'choice_options', 'score_levels'],
        additionalProperties: false,
      },
    },
  },
  required: ['assistant_message', 'ready', 'suggested_name', 'suggested_description', 'questions'],
  additionalProperties: false,
}

const builderInstructions = `You are the JEV Classifier Architect inside Jev-It Studio. Have a concise, collaborative conversation that discovers the user's automation need and turns it into a production-quality JEV classifier.

JEV receives one state and evaluates independent typed questions in parallel. It supports exactly:
- noul: a specific yes/no statement. No criteria.
- choice: select one named option. Provide 2-12 mutually exclusive choice_options with snake_case keys and concise descriptions.
- score: rate on an ordered rubric. Provide 2-10 concrete score_levels from lowest to highest.

Design rules:
- Questions must be atomic gut-check judgments answerable directly from the supplied state.
- Decompose multi-factor judgments into independent questions.
- Do not ask JEV to generate, explain, summarize, or return arbitrary text.
- Use stable snake_case question keys.
- Ask only the most useful follow-up question at each turn. Avoid interrogating the user with long lists.
- Maintain and improve the complete draft on every turn. When details are missing, questions may be empty or provisional.
- Set ready=true only when the classifier has a clear purpose, useful atomic questions, and valid criteria.
- Infer a short memorable classifier name from the conversation.
- assistant_message is natural conversational prose. When ready, briefly summarize the proposed classifier and ask the user to review the draft and click Create classifier.

Always return the full structured object. For noul, choice_options and score_levels must be empty. For choice, score_levels must be empty. For score, choice_options must be empty.`

function normalizeDraft(result) {
  const questions = {}
  for (const item of result.questions || []) {
    const key = String(item.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '')
    if (!key || questions[key]) continue
    const question = { type: item.type, instructions: String(item.instructions || '').trim() }
    if (item.type === 'choice') {
      question.criteria = Object.fromEntries(
        (item.choice_options || [])
          .map((option) => [
            String(option.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, ''),
            String(option.description || '').trim(),
          ])
          .filter(([optionKey, description]) => optionKey && description),
      )
    }
    if (item.type === 'score') question.criteria = (item.score_levels || []).map(String).filter(Boolean)
    questions[key] = question
  }
  return {
    name: result.suggested_name.trim() || 'Untitled classifier',
    description: result.suggested_description.trim(),
    questions,
    ready: Boolean(result.ready) && Object.keys(questions).length > 0,
  }
}

function draftToBuilderQuestions(questions = {}) {
  return Object.entries(questions).map(([key, question]) => ({
    key,
    type: question.type,
    instructions: question.instructions,
    choice_options: question.type === 'choice'
      ? Object.entries(question.criteria || {}).map(([optionKey, description]) => ({ key: optionKey, description }))
      : [],
    score_levels: question.type === 'score' ? question.criteria || [] : [],
  }))
}

function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) return 'Questions must be an object.'
  const entries = Object.entries(questions)
  if (!entries.length) return 'Add at least one question.'
  if (entries.length > 50) return 'A classifier supports up to 50 questions.'

  for (const [key, question] of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) return `Question key “${key}” must use lowercase snake_case.`
    if (!['choice', 'score', 'noul'].includes(question?.type)) return `Question “${key}” has an unsupported type.`
    if (!String(question.instructions || '').trim()) return `Question “${key}” needs instructions.`
    if (question.type === 'choice') {
      if (!question.criteria || typeof question.criteria !== 'object' || Array.isArray(question.criteria)) return `Choice “${key}” needs named options.`
      const options = Object.entries(question.criteria)
      if (options.length < 2 || options.length > 12) return `Choice “${key}” needs between 2 and 12 options.`
      for (const [optionKey, description] of options) {
        if (!/^[a-z][a-z0-9_]*$/.test(optionKey) || !String(description).trim()) return `Choice “${key}” has an invalid option.`
      }
    }
    if (question.type === 'score') {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10) return `Score “${key}” needs between 2 and 10 ordered levels.`
      if (question.criteria.some((level) => !String(level).trim())) return `Score “${key}” has an empty level.`
    }
  }
  return null
}

async function callJev(state, questions) {
  if (!process.env.TYPESAFE_API_KEY) {
    const error = new Error('Add TYPESAFE_API_KEY to .env before testing classifiers.')
    error.status = 503
    throw error
  }
  const request = {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: process.env.TYPESAFE_MODEL || 'jev-latest', questions }),
  }
  let upstream
  let lastError
  const retryableCodes = new Set(['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT'])
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      upstream = await fetch(jevUrl, { ...request, signal: AbortSignal.timeout(30_000) })
      break
    } catch (error) {
      lastError = error
      const code = error?.cause?.code
      if (!retryableCodes.has(code) || attempt === 2) break
      await new Promise((resolve) => setTimeout(resolve, 350 * (2 ** attempt)))
    }
  }
  if (!upstream) {
    const error = new Error('Could not reach the TypeSafe API. Check container DNS and internet connectivity, then try again.')
    error.status = 502
    error.cause = lastError
    throw error
  }
  const text = await upstream.text()
  let data
  try { data = JSON.parse(text) } catch { data = { error: text || 'Unreadable TypeSafe response.' } }
  if (!upstream.ok) {
    const error = new Error(data?.detail?.message || data?.message || data?.error || 'TypeSafe rejected the request.')
    error.status = upstream.status
    error.data = data
    throw error
  }
  return data
}

app.get('/api/auth/google', handleRoute(async (_request, response) => {
  if (!googleClientId || !googleClientSecret) return response.status(503).json({ error: 'Google SSO is not configured.' })
  const db = await getDb()
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  await db.collection('oauth_states').insertOne({ stateHash: hashKey(state), nonce, expiresAt: new Date(Date.now() + 10 * 60 * 1000), createdAt: new Date() })
  response.setHeader('Set-Cookie', oauthCookie(state))
  const authorizationUrl = new URL(googleAuthorizationEndpoint)
  authorizationUrl.search = new URLSearchParams({ client_id: googleClientId, redirect_uri: googleRedirectUri, response_type: 'code', scope: 'openid email profile', state, nonce, prompt: 'select_account' })
  response.redirect(authorizationUrl.toString())
}))

app.get('/api/auth/google/callback', handleRoute(async (request, response) => {
  const state = String(request.query.state || '')
  const code = String(request.query.code || '')
  const cookieState = parseCookies(request).jev_oauth_state
  if (!code || !state || !cookieState || !safeEqual(state, cookieState)) return response.status(400).send('Invalid Google sign-in state.')
  const db = await getDb()
  const stateRecord = await db.collection('oauth_states').findOneAndDelete({ stateHash: hashKey(state), expiresAt: { $gt: new Date() } })
  if (!stateRecord) return response.status(400).send('This Google sign-in request has expired.')
  const idToken = await exchangeGoogleCode(code)
  const profile = await verifyGoogleIdToken(idToken, stateRecord.nonce)
  if (!profile?.sub || !profile.email || !profile.email_verified) return response.status(401).send('A verified Google account is required.')
  const now = new Date()
  const user = await db.collection('users').findOneAndUpdate(
    { googleSub: profile.sub },
    {
      $set: { email: profile.email.toLowerCase(), name: profile.name || profile.email, picture: profile.picture || null, lastLoginAt: now, updatedAt: now },
      $setOnInsert: { id: id('usr'), googleSub: profile.sub, createdAt: now },
    },
    { upsert: true, returnDocument: 'after' },
  )
  const workspace = await ensurePersonalWorkspace(db, user, profile)
  const rawToken = randomBytes(32).toString('base64url')
  await db.collection('sessions').insertOne({
    id: id('ses'), tokenHash: hashKey(rawToken), userId: user.id, workspaceId: workspace.id,
    createdAt: now, lastSeenAt: now, expiresAt: new Date(now.getTime() + sessionDays * 24 * 60 * 60 * 1000),
  })
  response.setHeader('Set-Cookie', [sessionCookie(rawToken), oauthCookie('', 0)])
  response.redirect('/')
}))

app.get('/api/auth/session', requireSession, handleRoute(async (request, response) => {
  const db = await getDb()
  const counter = await db.collection('usage_counters').findOne({ workspaceId: request.workspaceId, period: currentPeriod(), metric: 'jev_executions' })
  const { user, workspace, membership } = request.auth
  response.json({
    authenticated: true,
    user: { id: user.id, email: user.email, name: user.name, picture: user.picture, isPlatformAdmin: platformAdminEmails.has(user.email) },
    workspace: { id: workspace.id, name: workspace.name, plan: workspace.plan, role: membership.role },
    quota: {
      classifiers: { used: workspace.usage?.activeClassifiers || 0, limit: workspace.quotas?.maxClassifiers ?? freeQuotas.maxClassifiers },
      apiCalls: { used: counter?.used || 0, limit: workspace.quotas?.monthlyApiCalls ?? freeQuotas.monthlyApiCalls, period: currentPeriod(), resetsAt: nextPeriodStart() },
    },
  })
}))

app.post('/api/auth/logout', requireSession, handleRoute(async (request, response) => {
  const db = await getDb()
  await db.collection('sessions').deleteOne({ id: request.auth.session.id })
  response.setHeader('Set-Cookie', sessionCookie('', 0))
  response.status(204).end()
}))

app.get('/api/health', handleRoute(async (_request, response) => {
  let mongo = false
  try { await getDb(); mongo = true } catch {}
  response.json({
    mongo,
    openai: Boolean(process.env.OPENAI_API_KEY),
    typesafe: Boolean(process.env.TYPESAFE_API_KEY),
    authConfigured: Boolean(googleClientId && googleClientSecret),
    model: process.env.OPENAI_MODEL || 'gpt-6-luna',
  })
}))

app.use('/api/classifiers', requireSession)
app.use('/api/builder', requireSession)
app.use('/api/keys', requireSession)
app.use('/api/analytics', requireSession)
app.use('/api/admin', requireSession)

app.get('/api/classifiers', handleRoute(async (request, response) => {
  const db = await getDb()
  const items = await db.collection('classifiers').find({ workspaceId: request.workspaceId, archivedAt: null }, { projection: { _id: 0, deployments: 0 } }).sort({ updatedAt: -1 }).toArray()
  response.json({ items })
}))

app.get('/api/classifiers/:id', handleRoute(async (request, response) => {
  const db = await getDb()
  const classifier = cleanDocument(await db.collection('classifiers').findOne({ id: request.params.id, workspaceId: request.workspaceId }))
  if (!classifier) return response.status(404).json({ error: 'Classifier not found.' })
  response.json(classifier)
}))

app.post('/api/builder/sessions', handleRoute(async (request, response) => {
  const db = await getDb()
  const now = new Date()
  const session = {
    id: id('build'),
    workspaceId: request.workspaceId,
    userId: request.auth.user.id,
    messages: [{ role: 'assistant', content: 'What decision do you want your classifier to make? Tell me about the input it will receive and what your software needs to know.', createdAt: now }],
    draft: { name: 'New classifier', description: '', questions: {}, ready: false },
    createdAt: now,
    updatedAt: now,
  }
  await db.collection('builder_sessions').insertOne(session)
  response.status(201).json(cleanDocument(session))
}))

app.get('/api/builder/sessions/:id', handleRoute(async (request, response) => {
  const db = await getDb()
  const session = cleanDocument(await db.collection('builder_sessions').findOne({ id: request.params.id, workspaceId: request.workspaceId }))
  if (!session) return response.status(404).json({ error: 'Builder session not found.' })
  response.json(session)
}))

app.post('/api/builder/sessions/:id/messages', handleRoute(async (request, response) => {
  const content = String(request.body?.message || '').trim()
  if (!content) return response.status(400).json({ error: 'Write a message first.' })
  if (!process.env.OPENAI_API_KEY) return response.status(503).json({ error: 'Add OPENAI_API_KEY to .env to use the classifier builder.' })

  const db = await getDb()
  const collection = db.collection('builder_sessions')
  const session = await collection.findOne({ id: request.params.id, workspaceId: request.workspaceId })
  if (!session) return response.status(404).json({ error: 'Builder session not found.' })

  const userMessage = { role: 'user', content, createdAt: new Date() }
  const conversation = [...session.messages, userMessage]
  const currentDraft = session.draft || { name: '', description: '', questions: {} }
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  const apiResponse = await openai.responses.create({
    model: process.env.OPENAI_MODEL || 'gpt-6-luna',
    reasoning: { effort: 'low' },
    store: false,
    input: [
      { role: 'system', content: builderInstructions },
      ...conversation.map((message) => ({ role: message.role, content: message.content })),
      { role: 'system', content: `Current structured draft JSON:\n${JSON.stringify({ suggested_name: currentDraft.name, suggested_description: currentDraft.description, questions: draftToBuilderQuestions(currentDraft.questions) })}` },
    ],
    text: { format: { type: 'json_schema', name: 'jev_classifier_builder', strict: true, schema: builderSchema } },
  })

  if (!apiResponse.output_text) throw new Error('The builder did not return a usable response.')
  const result = JSON.parse(apiResponse.output_text)
  const draft = normalizeDraft(result)
  const assistantMessage = { role: 'assistant', content: result.assistant_message, createdAt: new Date() }
  await collection.updateOne(
    { id: session.id, workspaceId: request.workspaceId },
    { $set: { draft, updatedAt: new Date() }, $push: { messages: { $each: [userMessage, assistantMessage] } } },
  )
  response.json({ message: assistantMessage, draft, ready: draft.ready })
}))

app.post('/api/builder/sessions/:id/create', handleRoute(async (request, response) => {
  const db = await getDb()
  const session = await db.collection('builder_sessions').findOne({ id: request.params.id, workspaceId: request.workspaceId })
  if (!session) return response.status(404).json({ error: 'Builder session not found.' })
  if (!session.draft?.ready || !Object.keys(session.draft.questions || {}).length) return response.status(400).json({ error: 'The classifier draft is not ready yet.' })
  const validationError = validateQuestions(session.draft.questions)
  if (validationError) return response.status(400).json({ error: validationError })
  const workspace = await db.collection('workspaces').findOneAndUpdate(
    { id: request.workspaceId, 'usage.activeClassifiers': { $lt: request.auth.workspace.quotas?.maxClassifiers ?? freeQuotas.maxClassifiers } },
    { $inc: { 'usage.activeClassifiers': 1 }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after' },
  )
  if (!workspace) return response.status(403).json({ error: 'Free plan classifier limit reached.', code: 'classifier_quota_exceeded' })
  const now = new Date()
  const classifier = {
    id: id('cls'),
    workspaceId: request.workspaceId,
    createdBy: request.auth.user.id,
    name: session.draft.name,
    description: session.draft.description,
    questions: session.draft.questions,
    deployedVersion: null,
    deployments: [],
    deploymentEvents: [],
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await db.collection('classifiers').insertOne(classifier)
  } catch (error) {
    await db.collection('workspaces').updateOne({ id: request.workspaceId }, { $inc: { 'usage.activeClassifiers': -1 } })
    throw error
  }
  await db.collection('builder_sessions').updateOne({ id: session.id, workspaceId: request.workspaceId }, { $set: { classifierId: classifier.id, updatedAt: now } })
  response.status(201).json(cleanDocument(classifier))
}))

app.put('/api/classifiers/:id', handleRoute(async (request, response) => {
  const { name, description, questions } = request.body || {}
  if (!String(name || '').trim()) return response.status(400).json({ error: 'A classifier name is required.' })
  const validationError = validateQuestions(questions)
  if (validationError) return response.status(400).json({ error: validationError })
  const db = await getDb()
  const result = await db.collection('classifiers').findOneAndUpdate(
    { id: request.params.id, workspaceId: request.workspaceId },
    { $set: { name: String(name).trim(), description: String(description || '').trim(), questions, updatedAt: new Date() } },
    { returnDocument: 'after' },
  )
  if (!result) return response.status(404).json({ error: 'Classifier not found.' })
  response.json(cleanDocument(result))
}))

app.post('/api/classifiers/:id/test', handleRoute(async (request, response) => {
  const states = Array.isArray(request.body?.states) ? request.body.states.map(String).map((item) => item.trim()).filter(Boolean) : []
  if (!states.length) return response.status(400).json({ error: 'Add at least one test state.' })
  if (states.length > 20) return response.status(400).json({ error: 'A test run supports up to 20 states.' })
  const db = await getDb()
  const classifier = await db.collection('classifiers').findOne({ id: request.params.id, workspaceId: request.workspaceId })
  if (!classifier) return response.status(404).json({ error: 'Classifier not found.' })
  const validationError = validateQuestions(classifier.questions)
  if (validationError) return response.status(400).json({ error: validationError })
  const results = []
  for (const state of states) {
    await reserveJevExecution(db, request.auth.workspace)
    const startedAt = Date.now()
    try {
      const jevResponse = await callJev(state, classifier.questions)
      await recordApiCall(db, { workspaceId: request.workspaceId, classifierId: classifier.id, deploymentVersion: null, source: 'playground', status: 'success', httpStatus: 200, latencyMs: Date.now() - startedAt })
      results.push({ state, response: jevResponse })
    } catch (error) {
      await recordApiCall(db, { workspaceId: request.workspaceId, classifierId: classifier.id, deploymentVersion: null, source: 'playground', status: 'error', httpStatus: error.status || 500, errorCode: error.code || 'jev_error', latencyMs: Date.now() - startedAt })
      throw error
    }
  }
  response.json({ classifierId: classifier.id, ephemeral: true, results })
}))

app.post('/api/classifiers/:id/deploy', handleRoute(async (request, response) => {
  const db = await getDb()
  const collection = db.collection('classifiers')
  const classifier = await collection.findOne({ id: request.params.id, workspaceId: request.workspaceId })
  if (!classifier) return response.status(404).json({ error: 'Classifier not found.' })
  const validationError = validateQuestions(classifier.questions)
  if (validationError) return response.status(400).json({ error: validationError })
  const version = Math.max(0, ...(classifier.deployments || []).map((item) => item.version)) + 1
  const snapshot = { version, name: classifier.name, description: classifier.description, questions: classifier.questions, deployedAt: new Date() }
  await collection.updateOne(
    { id: classifier.id, workspaceId: request.workspaceId },
    { $set: { deployedVersion: version, updatedAt: new Date() }, $push: { deployments: snapshot, deploymentEvents: { version, action: 'deploy', createdAt: new Date() } } },
  )
  response.status(201).json(snapshot)
}))

app.post('/api/classifiers/:id/activate/:version', handleRoute(async (request, response) => {
  const version = Number(request.params.version)
  const db = await getDb()
  const collection = db.collection('classifiers')
  const classifier = await collection.findOne({ id: request.params.id, workspaceId: request.workspaceId, 'deployments.version': version })
  if (!classifier) return response.status(404).json({ error: 'Deployment version not found.' })
  await collection.updateOne(
    { id: classifier.id, workspaceId: request.workspaceId },
    { $set: { deployedVersion: version, updatedAt: new Date() }, $push: { deploymentEvents: { version, action: 'activate', createdAt: new Date() } } },
  )
  response.json({ deployedVersion: version })
}))

app.get('/api/keys', handleRoute(async (request, response) => {
  const db = await getDb()
  const key = await db.collection('api_keys').findOne({ workspaceId: request.workspaceId, revokedAt: null }, { sort: { createdAt: -1 } })
  response.json({ active: Boolean(key), prefix: key?.prefix || null, createdAt: key?.createdAt || null })
}))

app.post('/api/keys/rotate', handleRoute(async (request, response) => {
  const db = await getDb()
  const collection = db.collection('api_keys')
  await collection.updateMany({ workspaceId: request.workspaceId, revokedAt: null }, { $set: { revokedAt: new Date() } })
  const secret = `jv_live_${randomBytes(24).toString('base64url')}`
  const record = { id: id('key'), workspaceId: request.workspaceId, createdBy: request.auth.user.id, keyHash: hashKey(secret), prefix: `${secret.slice(0, 14)}…`, createdAt: new Date(), revokedAt: null }
  await collection.insertOne(record)
  response.status(201).json({ key: secret, prefix: record.prefix, createdAt: record.createdAt, shownOnce: true })
}))

app.delete('/api/keys/current', handleRoute(async (request, response) => {
  const db = await getDb()
  await db.collection('api_keys').updateMany({ workspaceId: request.workspaceId, revokedAt: null }, { $set: { revokedAt: new Date() } })
  response.status(204).end()
}))

function analyticsRange(query) {
  const now = new Date()
  const earliest = new Date(now.getTime() - analyticsRetentionSeconds * 1000)
  const requestedFrom = query.from ? new Date(String(query.from)) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
  const requestedTo = query.to ? new Date(String(query.to)) : now
  return {
    from: Number.isNaN(requestedFrom.getTime()) || requestedFrom < earliest ? earliest : requestedFrom,
    to: Number.isNaN(requestedTo.getTime()) || requestedTo > now ? now : requestedTo,
  }
}

app.get('/api/analytics', handleRoute(async (request, response) => {
  const db = await getDb()
  const { from, to } = analyticsRange(request.query)
  const match = { workspaceId: request.workspaceId, timestamp: { $gte: from, $lte: to } }
  if (request.query.classifierId) match.classifierId = String(request.query.classifierId)
  const [analytics] = await db.collection('api_call_events').aggregate([
    { $match: match },
    { $facet: {
      summary: [{ $group: {
        _id: null,
        calls: { $sum: 1 },
        successes: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
        failures: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
        quotaDenied: { $sum: { $cond: [{ $eq: ['$status', 'quota_denied'] }, 1, 0] } },
        averageLatencyMs: { $avg: '$latencyMs' },
        latencyPercentiles: { $percentile: { input: '$latencyMs', p: [0.5, 0.95], method: 'approximate' } },
      } }],
      timeline: [
        { $group: { _id: { $dateTrunc: { date: '$timestamp', unit: 'day' } }, calls: { $sum: 1 }, successes: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } }, failures: { $sum: { $cond: [{ $ne: ['$status', 'success'] }, 1, 0] } } } },
        { $sort: { _id: 1 } },
      ],
      byClassifier: [
        { $group: { _id: '$classifierId', calls: { $sum: 1 }, successes: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } }, averageLatencyMs: { $avg: '$latencyMs' } } },
        { $sort: { calls: -1 } },
      ],
      bySource: [{ $group: { _id: '$source', calls: { $sum: 1 } } }, { $sort: { calls: -1 } }],
    } },
  ]).toArray()
  const classifiers = await db.collection('classifiers').find({ workspaceId: request.workspaceId }, { projection: { _id: 0, id: 1, name: 1 } }).toArray()
  const names = Object.fromEntries(classifiers.map((classifier) => [classifier.id, classifier.name]))
  const summary = analytics.summary[0] || { calls: 0, successes: 0, failures: 0, quotaDenied: 0, averageLatencyMs: 0, latencyPercentiles: [0, 0] }
  const counter = await db.collection('usage_counters').findOne({ workspaceId: request.workspaceId, period: currentPeriod(), metric: 'jev_executions' })
  response.json({
    range: { from, to },
    summary: { ...summary, p50LatencyMs: summary.latencyPercentiles?.[0] || 0, p95LatencyMs: summary.latencyPercentiles?.[1] || 0, latencyPercentiles: undefined },
    timeline: analytics.timeline.map((item) => ({ date: item._id, calls: item.calls, successes: item.successes, failures: item.failures })),
    byClassifier: analytics.byClassifier.map((item) => ({ classifierId: item._id, name: names[item._id] || 'Deleted classifier', calls: item.calls, successes: item.successes, averageLatencyMs: item.averageLatencyMs })),
    bySource: analytics.bySource.map((item) => ({ source: item._id, calls: item.calls })),
    quota: { used: counter?.used || 0, limit: request.auth.workspace.quotas?.monthlyApiCalls ?? freeQuotas.monthlyApiCalls, period: currentPeriod(), resetsAt: nextPeriodStart() },
  })
}))

app.get('/api/admin/analytics', handleRoute(async (request, response) => {
  if (!platformAdminEmails.has(request.auth.user.email)) return response.status(403).json({ error: 'Platform administrator access is required.' })
  const db = await getDb()
  const { from, to } = analyticsRange(request.query)
  const [analytics] = await db.collection('api_call_events').aggregate([
    { $match: { timestamp: { $gte: from, $lte: to } } },
    { $facet: {
      summary: [{ $group: {
        _id: null,
        calls: { $sum: 1 },
        successes: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
        failures: { $sum: { $cond: [{ $ne: ['$status', 'success'] }, 1, 0] } },
        averageLatencyMs: { $avg: '$latencyMs' },
        latencyPercentiles: { $percentile: { input: '$latencyMs', p: [0.5, 0.95], method: 'approximate' } },
      } }],
      timeline: [
        { $group: { _id: { $dateTrunc: { date: '$timestamp', unit: 'day' } }, calls: { $sum: 1 }, successes: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } }, failures: { $sum: { $cond: [{ $ne: ['$status', 'success'] }, 1, 0] } } } },
        { $sort: { _id: 1 } },
      ],
      byWorkspace: [
        { $group: { _id: '$workspaceId', calls: { $sum: 1 }, successes: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } }, failures: { $sum: { $cond: [{ $ne: ['$status', 'success'] }, 1, 0] } }, averageLatencyMs: { $avg: '$latencyMs' } } },
        { $sort: { calls: -1 } },
      ],
    } },
  ]).toArray()
  const [workspaces, users] = await Promise.all([
    db.collection('workspaces').find({}, { projection: { _id: 0, id: 1, name: 1, plan: 1, usage: 1, createdAt: 1 } }).sort({ createdAt: -1 }).toArray(),
    db.collection('users').countDocuments(),
  ])
  const usage = Object.fromEntries(analytics.byWorkspace.map((row) => [row._id, row]))
  const summary = analytics.summary[0] || { calls: 0, successes: 0, failures: 0, averageLatencyMs: 0, latencyPercentiles: [0, 0] }
  response.json({
    range: { from, to },
    summary: { ...summary, p50LatencyMs: summary.latencyPercentiles?.[0] || 0, p95LatencyMs: summary.latencyPercentiles?.[1] || 0, latencyPercentiles: undefined, workspaces: workspaces.length, users },
    timeline: analytics.timeline.map((item) => ({ date: item._id, calls: item.calls, successes: item.successes, failures: item.failures })),
    workspaces: workspaces.map((workspace) => ({ workspaceId: workspace.id, name: workspace.name, plan: workspace.plan, classifiers: workspace.usage?.activeClassifiers || 0, createdAt: workspace.createdAt, calls: usage[workspace.id]?.calls || 0, successes: usage[workspace.id]?.successes || 0, failures: usage[workspace.id]?.failures || 0, averageLatencyMs: usage[workspace.id]?.averageLatencyMs || 0 })).sort((left, right) => right.calls - left.calls),
  })
}))

async function requireProjectKey(request, response, next) {
  try {
    const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : ''
    const supplied = request.headers['x-api-key'] || bearer
    if (!supplied) return response.status(401).json({ error: 'A project API key is required.' })
    const db = await getDb()
    const record = await db.collection('api_keys').findOne({ keyHash: hashKey(String(supplied)), revokedAt: null })
    if (!record) return response.status(401).json({ error: 'Invalid or revoked project API key.' })
    request.apiKey = record
    request.workspaceId = record.workspaceId
    next()
  } catch (error) {
    response.status(503).json({ error: 'Could not verify the project API key.', detail: error.message })
  }
}

app.post('/api/classify', requireProjectKey, handleRoute(async (request, response) => {
  const startedAt = Date.now()
  const requestId = id('req')
  const classifierId = String(request.body?.classifier_id || '')
  const state = String(request.body?.state || '').trim()
  if (!classifierId || !state) return response.status(400).json({ error: 'classifier_id and state are required.' })
  const db = await getDb()
  const workspace = await db.collection('workspaces').findOne({ id: request.workspaceId })
  if (!workspace) return response.status(401).json({ error: 'The API key workspace no longer exists.' })
  const classifier = await db.collection('classifiers').findOne({ id: classifierId, workspaceId: request.workspaceId })
  if (!classifier) return response.status(404).json({ error: 'Classifier not found.' })
  if (!classifier.deployedVersion) return response.status(409).json({ error: 'This classifier has not been deployed.' })
  const deployment = classifier.deployments.find((item) => item.version === classifier.deployedVersion)
  if (!deployment) return response.status(409).json({ error: 'The active deployment could not be resolved.' })
  try {
    await reserveJevExecution(db, workspace)
    const result = await callJev(state, deployment.questions)
    await recordApiCall(db, { timestamp: new Date(), requestId, workspaceId: request.workspaceId, classifierId, deploymentVersion: deployment.version, apiKeyId: request.apiKey.id, source: 'api', status: 'success', httpStatus: 200, latencyMs: Date.now() - startedAt })
    response.setHeader('X-Request-Id', requestId)
    response.json(result)
  } catch (error) {
    await recordApiCall(db, { timestamp: new Date(), requestId, workspaceId: request.workspaceId, classifierId, deploymentVersion: deployment.version, apiKeyId: request.apiKey.id, source: 'api', status: error.code === 'quota_exceeded' ? 'quota_denied' : 'error', httpStatus: error.status || 500, errorCode: error.code || 'jev_error', latencyMs: Date.now() - startedAt }).catch((analyticsError) => console.error('Could not record API call event', analyticsError))
    throw error
  }
}))

const currentDir = dirname(fileURLToPath(import.meta.url))
const distDir = join(currentDir, 'dist')
if (existsSync(distDir)) {
  app.use(express.static(distDir))
  app.get('*path', (_request, response) => response.sendFile(join(distDir, 'index.html')))
}

const server = app.listen(port, host, () => console.log(`Jev-It Studio listening on http://${host}:${port}`))

async function shutdown() {
  server.close()
  await mongoClient?.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

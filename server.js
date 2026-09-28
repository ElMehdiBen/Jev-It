import 'dotenv/config'
import express from 'express'
import OpenAI from 'openai'
import { MongoClient } from 'mongodb'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const app = express()
const port = Number(process.env.PORT || 3001)
const host = process.env.HOST || '127.0.0.1'
const jevUrl = 'https://api.typesafe.ai/v1/systemone'
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017'
const databaseName = process.env.MONGODB_DATABASE || 'jev_studio'

app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))

let mongoClient
let database

async function getDb() {
  if (database) return database
  mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 2500 })
  await mongoClient.connect()
  database = mongoClient.db(databaseName)
  await Promise.all([
    database.collection('classifiers').createIndex({ id: 1 }, { unique: true }),
    database.collection('builder_sessions').createIndex({ id: 1 }, { unique: true }),
    database.collection('api_keys').createIndex({ keyHash: 1 }, { unique: true }),
  ])
  return database
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
        detail: isMongo ? 'Start MongoDB and verify MONGODB_URI in .env.' : undefined,
        upstream: error.data,
      })
    }
  }
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

app.get('/api/health', handleRoute(async (_request, response) => {
  let mongo = false
  try { await getDb(); mongo = true } catch {}
  response.json({
    mongo,
    openai: Boolean(process.env.OPENAI_API_KEY),
    typesafe: Boolean(process.env.TYPESAFE_API_KEY),
    model: process.env.OPENAI_MODEL || 'gpt-6-luna',
  })
}))

app.get('/api/classifiers', handleRoute(async (_request, response) => {
  const db = await getDb()
  const items = await db.collection('classifiers').find({}, { projection: { _id: 0, deployments: 0 } }).sort({ updatedAt: -1 }).toArray()
  response.json({ items })
}))

app.get('/api/classifiers/:id', handleRoute(async (request, response) => {
  const db = await getDb()
  const classifier = cleanDocument(await db.collection('classifiers').findOne({ id: request.params.id }))
  if (!classifier) return response.status(404).json({ error: 'Classifier not found.' })
  response.json(classifier)
}))

app.post('/api/builder/sessions', handleRoute(async (_request, response) => {
  const db = await getDb()
  const now = new Date()
  const session = {
    id: id('build'),
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
  const session = cleanDocument(await db.collection('builder_sessions').findOne({ id: request.params.id }))
  if (!session) return response.status(404).json({ error: 'Builder session not found.' })
  response.json(session)
}))

app.post('/api/builder/sessions/:id/messages', handleRoute(async (request, response) => {
  const content = String(request.body?.message || '').trim()
  if (!content) return response.status(400).json({ error: 'Write a message first.' })
  if (!process.env.OPENAI_API_KEY) return response.status(503).json({ error: 'Add OPENAI_API_KEY to .env to use the classifier builder.' })

  const db = await getDb()
  const collection = db.collection('builder_sessions')
  const session = await collection.findOne({ id: request.params.id })
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
    { id: session.id },
    { $set: { draft, updatedAt: new Date() }, $push: { messages: { $each: [userMessage, assistantMessage] } } },
  )
  response.json({ message: assistantMessage, draft, ready: draft.ready })
}))

app.post('/api/builder/sessions/:id/create', handleRoute(async (request, response) => {
  const db = await getDb()
  const session = await db.collection('builder_sessions').findOne({ id: request.params.id })
  if (!session) return response.status(404).json({ error: 'Builder session not found.' })
  if (!session.draft?.ready || !Object.keys(session.draft.questions || {}).length) return response.status(400).json({ error: 'The classifier draft is not ready yet.' })
  const validationError = validateQuestions(session.draft.questions)
  if (validationError) return response.status(400).json({ error: validationError })
  const now = new Date()
  const classifier = {
    id: id('cls'),
    name: session.draft.name,
    description: session.draft.description,
    questions: session.draft.questions,
    deployedVersion: null,
    deployments: [],
    deploymentEvents: [],
    createdAt: now,
    updatedAt: now,
  }
  await db.collection('classifiers').insertOne(classifier)
  await db.collection('builder_sessions').updateOne({ id: session.id }, { $set: { classifierId: classifier.id, updatedAt: now } })
  response.status(201).json(cleanDocument(classifier))
}))

app.put('/api/classifiers/:id', handleRoute(async (request, response) => {
  const { name, description, questions } = request.body || {}
  if (!String(name || '').trim()) return response.status(400).json({ error: 'A classifier name is required.' })
  const validationError = validateQuestions(questions)
  if (validationError) return response.status(400).json({ error: validationError })
  const db = await getDb()
  const result = await db.collection('classifiers').findOneAndUpdate(
    { id: request.params.id },
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
  const classifier = await db.collection('classifiers').findOne({ id: request.params.id })
  if (!classifier) return response.status(404).json({ error: 'Classifier not found.' })
  const validationError = validateQuestions(classifier.questions)
  if (validationError) return response.status(400).json({ error: validationError })
  const results = []
  for (const state of states) results.push({ state, response: await callJev(state, classifier.questions) })
  response.json({ classifierId: classifier.id, ephemeral: true, results })
}))

app.post('/api/classifiers/:id/deploy', handleRoute(async (request, response) => {
  const db = await getDb()
  const collection = db.collection('classifiers')
  const classifier = await collection.findOne({ id: request.params.id })
  if (!classifier) return response.status(404).json({ error: 'Classifier not found.' })
  const validationError = validateQuestions(classifier.questions)
  if (validationError) return response.status(400).json({ error: validationError })
  const version = Math.max(0, ...(classifier.deployments || []).map((item) => item.version)) + 1
  const snapshot = { version, name: classifier.name, description: classifier.description, questions: classifier.questions, deployedAt: new Date() }
  await collection.updateOne(
    { id: classifier.id },
    { $set: { deployedVersion: version, updatedAt: new Date() }, $push: { deployments: snapshot, deploymentEvents: { version, action: 'deploy', createdAt: new Date() } } },
  )
  response.status(201).json(snapshot)
}))

app.post('/api/classifiers/:id/activate/:version', handleRoute(async (request, response) => {
  const version = Number(request.params.version)
  const db = await getDb()
  const collection = db.collection('classifiers')
  const classifier = await collection.findOne({ id: request.params.id, 'deployments.version': version })
  if (!classifier) return response.status(404).json({ error: 'Deployment version not found.' })
  await collection.updateOne(
    { id: classifier.id },
    { $set: { deployedVersion: version, updatedAt: new Date() }, $push: { deploymentEvents: { version, action: 'activate', createdAt: new Date() } } },
  )
  response.json({ deployedVersion: version })
}))

app.get('/api/keys', handleRoute(async (_request, response) => {
  const db = await getDb()
  const key = await db.collection('api_keys').findOne({ revokedAt: null }, { sort: { createdAt: -1 } })
  response.json({ active: Boolean(key), prefix: key?.prefix || null, createdAt: key?.createdAt || null })
}))

app.post('/api/keys/rotate', handleRoute(async (_request, response) => {
  const db = await getDb()
  const collection = db.collection('api_keys')
  await collection.updateMany({ revokedAt: null }, { $set: { revokedAt: new Date() } })
  const secret = `jv_live_${randomBytes(24).toString('base64url')}`
  const record = { id: id('key'), keyHash: hashKey(secret), prefix: `${secret.slice(0, 14)}…`, createdAt: new Date(), revokedAt: null }
  await collection.insertOne(record)
  response.status(201).json({ key: secret, prefix: record.prefix, createdAt: record.createdAt, shownOnce: true })
}))

app.delete('/api/keys/current', handleRoute(async (_request, response) => {
  const db = await getDb()
  await db.collection('api_keys').updateMany({ revokedAt: null }, { $set: { revokedAt: new Date() } })
  response.status(204).end()
}))

async function requireProjectKey(request, response, next) {
  try {
    const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : ''
    const supplied = request.headers['x-api-key'] || bearer
    if (!supplied) return response.status(401).json({ error: 'A project API key is required.' })
    const db = await getDb()
    const record = await db.collection('api_keys').findOne({ keyHash: hashKey(String(supplied)), revokedAt: null })
    if (!record) return response.status(401).json({ error: 'Invalid or revoked project API key.' })
    next()
  } catch (error) {
    response.status(503).json({ error: 'Could not verify the project API key.', detail: error.message })
  }
}

app.post('/api/classify', requireProjectKey, handleRoute(async (request, response) => {
  const classifierId = String(request.body?.classifier_id || '')
  const state = String(request.body?.state || '').trim()
  if (!classifierId || !state) return response.status(400).json({ error: 'classifier_id and state are required.' })
  const db = await getDb()
  const classifier = await db.collection('classifiers').findOne({ id: classifierId })
  if (!classifier) return response.status(404).json({ error: 'Classifier not found.' })
  if (!classifier.deployedVersion) return response.status(409).json({ error: 'This classifier has not been deployed.' })
  const deployment = classifier.deployments.find((item) => item.version === classifier.deployedVersion)
  if (!deployment) return response.status(409).json({ error: 'The active deployment could not be resolved.' })
  response.json(await callJev(state, deployment.questions))
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

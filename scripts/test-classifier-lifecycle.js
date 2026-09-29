import 'dotenv/config'
import { createHash, randomBytes } from 'node:crypto'
import { MongoClient } from 'mongodb'

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017'
const databaseName = process.env.MONGODB_DATABASE || 'jev_studio'
const apiOrigin = process.env.TEST_API_ORIGIN || 'http://127.0.0.1:3001'
const suffix = randomBytes(6).toString('hex')
const ids = {
  user: `test_usr_${suffix}`,
  workspace: `test_ws_${suffix}`,
  membership: `test_mem_${suffix}`,
  session: `test_ses_${suffix}`,
  classifier: `test_cls_${suffix}`,
  apiKey: `test_key_${suffix}`,
  builder: `test_build_${suffix}`,
}
const sessionToken = randomBytes(24).toString('base64url')
const apiKey = `jv_live_test_${randomBytes(24).toString('base64url')}`
const client = new MongoClient(mongoUri)
let connected = false

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function expectStatus(response, status, label) {
  if (response.status === status) return response
  const body = await response.text()
  throw new Error(`${label}: expected ${status}, received ${response.status}: ${body}`)
}

try {
  await client.connect()
  connected = true
  const db = client.db(databaseName)
  const now = new Date()
  const auth = { Cookie: `jev_session=${sessionToken}` }
  const request = (path, options = {}) => fetch(`${apiOrigin}${path}`, {
    ...options,
    headers: { ...auth, ...options.headers },
  })

  await Promise.all([
    db.collection('users').insertOne({ id: ids.user, googleSub: `test_${suffix}`, email: `${suffix}@example.test`, name: 'Lifecycle test', createdAt: now }),
    db.collection('workspaces').insertOne({ id: ids.workspace, name: 'Lifecycle test', plan: 'free', quotas: { maxClassifiers: 5, monthlyApiCalls: 1000 }, usage: { activeClassifiers: 1 }, createdAt: now }),
    db.collection('workspace_memberships').insertOne({ id: ids.membership, userId: ids.user, workspaceId: ids.workspace, role: 'owner', createdAt: now }),
    db.collection('sessions').insertOne({ id: ids.session, tokenHash: hash(sessionToken), userId: ids.user, workspaceId: ids.workspace, createdAt: now, expiresAt: new Date(Date.now() + 60_000) }),
    db.collection('api_keys').insertOne({ id: ids.apiKey, workspaceId: ids.workspace, createdBy: ids.user, keyHash: hash(apiKey), prefix: 'jv_live_test_…', createdAt: now, revokedAt: null }),
    db.collection('classifiers').insertOne({
      id: ids.classifier,
      workspaceId: ids.workspace,
      createdBy: ids.user,
      name: 'Lifecycle test',
      description: 'Temporary integration fixture',
      language: 'fr',
      questions: { sentiment: { type: 'choice', instructions: 'Classez le sentiment.', options: { positive: 'Positif', negative: 'Négatif' } } },
      deployedVersion: 1,
      deployments: [{
        version: 1,
        name: 'Lifecycle test',
        description: 'Temporary integration fixture',
        language: 'fr',
        questions: { sentiment: { type: 'choice', instructions: 'Classez le sentiment.', options: { positive: 'Positif', negative: 'Négatif' } } },
        deployedAt: now,
      }],
      deploymentEvents: [{ version: 1, action: 'deploy', createdAt: now }],
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    }),
    db.collection('builder_sessions').insertOne({ id: ids.builder, workspaceId: ids.workspace, userId: ids.user, classifierId: ids.classifier, createdAt: now, updatedAt: now }),
  ])

  const activeBefore = await expectStatus(await request('/api/classifiers'), 200, 'list active classifiers')
  if (!(await activeBefore.json()).items.some((item) => item.id === ids.classifier)) throw new Error('Active classifier was missing from the active list.')

  await expectStatus(await request(`/api/classifiers/${ids.classifier}`, { method: 'DELETE' }), 409, 'delete active classifier')
  await expectStatus(await request(`/api/classifiers/${ids.classifier}/archive`, { method: 'POST' }), 200, 'archive classifier')

  const archivedWorkspace = await db.collection('workspaces').findOne({ id: ids.workspace })
  if (archivedWorkspace.usage.activeClassifiers !== 0) throw new Error('Archiving did not release classifier quota.')
  const activeAfter = await expectStatus(await request('/api/classifiers'), 200, 'list active classifiers after archive')
  if ((await activeAfter.json()).items.some((item) => item.id === ids.classifier)) throw new Error('Archived classifier remained in the active list.')
  const archiveList = await expectStatus(await request('/api/classifiers?archived=true'), 200, 'list archived classifiers')
  if (!(await archiveList.json()).items.some((item) => item.id === ids.classifier)) throw new Error('Classifier was missing from the archive.')

  await expectStatus(await fetch(`${apiOrigin}/api/classify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ classifier_id: ids.classifier, state: 'Très bon service' }),
  }), 404, 'classify with archived classifier')

  await expectStatus(await request(`/api/classifiers/${ids.classifier}/restore`, { method: 'POST' }), 200, 'restore classifier')
  const restoredWorkspace = await db.collection('workspaces').findOne({ id: ids.workspace })
  if (restoredWorkspace.usage.activeClassifiers !== 1) throw new Error('Restoring did not reserve classifier quota.')

  await expectStatus(await request(`/api/classifiers/${ids.classifier}/archive`, { method: 'POST' }), 200, 'archive classifier again')
  await expectStatus(await request(`/api/classifiers/${ids.classifier}`, { method: 'DELETE' }), 204, 'permanently delete classifier')
  if (await db.collection('classifiers').findOne({ id: ids.classifier })) throw new Error('Classifier remained after permanent deletion.')
  if (await db.collection('builder_sessions').findOne({ id: ids.builder })) throw new Error('Linked builder session remained after permanent deletion.')
  const deletedWorkspace = await db.collection('workspaces').findOne({ id: ids.workspace })
  if (deletedWorkspace.usage.activeClassifiers !== 0) throw new Error('Permanent deletion changed already released quota.')

  console.log('Classifier archive, restore, deletion, and quota integration test passed.')
} finally {
  if (connected) {
    const db = client.db(databaseName)
    await Promise.all([
      db.collection('builder_sessions').deleteMany({ id: ids.builder }),
      db.collection('classifiers').deleteMany({ id: ids.classifier }),
      db.collection('api_keys').deleteMany({ id: ids.apiKey }),
      db.collection('sessions').deleteMany({ id: ids.session }),
      db.collection('workspace_memberships').deleteMany({ id: ids.membership }),
      db.collection('workspaces').deleteMany({ id: ids.workspace }),
      db.collection('users').deleteMany({ id: ids.user }),
    ])
  }
  await client.close()
}

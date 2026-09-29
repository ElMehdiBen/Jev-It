import 'dotenv/config'
import { createHash, randomBytes } from 'node:crypto'
import { MongoClient } from 'mongodb'

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017'
const databaseName = process.env.MONGODB_DATABASE || 'jev_studio'
const apiOrigin = process.env.TEST_API_ORIGIN || 'http://127.0.0.1:3001'
const adminEmail = String(process.env.PLATFORM_ADMIN_EMAILS || '').split(',').map((value) => value.trim()).find(Boolean)
if (!adminEmail) throw new Error('PLATFORM_ADMIN_EMAILS must contain an address to run this integration test.')

const suffix = randomBytes(6).toString('hex')
const ids = {
  user: `test_admin_usr_${suffix}`,
  workspace: `test_admin_ws_${suffix}`,
  membership: `test_admin_mem_${suffix}`,
  session: `test_admin_ses_${suffix}`,
  activeClassifier: `test_admin_cls_active_${suffix}`,
  archivedClassifier: `test_admin_cls_archived_${suffix}`,
}
const sessionToken = randomBytes(24).toString('base64url')
const client = new MongoClient(mongoUri)
let connected = false

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

try {
  await client.connect()
  connected = true
  const db = client.db(databaseName)
  const now = new Date()

  await Promise.all([
    db.collection('users').insertOne({ id: ids.user, googleSub: `test_admin_${suffix}`, email: adminEmail.toLowerCase(), name: 'Analytics admin test', createdAt: now, lastLoginAt: now }),
    db.collection('workspaces').insertOne({ id: ids.workspace, name: 'Analytics fixture workspace', plan: 'free', quotas: { maxClassifiers: 5, monthlyApiCalls: 1000 }, usage: { activeClassifiers: 1 }, createdAt: now }),
    db.collection('workspace_memberships').insertOne({ id: ids.membership, userId: ids.user, workspaceId: ids.workspace, role: 'owner', createdAt: now }),
    db.collection('sessions').insertOne({ id: ids.session, tokenHash: hash(sessionToken), userId: ids.user, workspaceId: ids.workspace, createdAt: now, expiresAt: new Date(Date.now() + 60_000) }),
    db.collection('classifiers').insertMany([
      { id: ids.activeClassifier, workspaceId: ids.workspace, name: 'Active analytics fixture', description: 'Visible active classifier', language: 'en', deployedVersion: 2, archivedAt: null, createdAt: now, updatedAt: now },
      { id: ids.archivedClassifier, workspaceId: ids.workspace, name: 'Archived analytics fixture', description: 'Visible archived classifier', language: 'fr', deployedVersion: 1, archivedAt: now, createdAt: now, updatedAt: now },
    ]),
  ])

  const response = await fetch(`${apiOrigin}/api/admin/analytics`, { headers: { Cookie: `jev_session=${sessionToken}` } })
  if (!response.ok) throw new Error(`Admin analytics returned ${response.status}: ${await response.text()}`)
  const analytics = await response.json()
  const account = analytics.accounts.find((item) => item.userId === ids.user)
  const workspace = account?.workspaces.find((item) => item.workspaceId === ids.workspace)
  if (!account || !workspace) throw new Error('The admin account/workspace relationship was missing.')
  if (workspace.classifiers.length !== 2) throw new Error(`Expected two classifiers, received ${workspace.classifiers.length}.`)
  if (!workspace.classifiers.some((item) => item.id === ids.activeClassifier && item.deployedVersion === 2 && !item.archived)) throw new Error('The active classifier status was incorrect.')
  if (!workspace.classifiers.some((item) => item.id === ids.archivedClassifier && item.archived)) throw new Error('The archived classifier status was incorrect.')
  if ('questions' in workspace.classifiers[0] || 'deployments' in workspace.classifiers[0]) throw new Error('Admin analytics exposed classifier configuration data.')

  console.log('Admin account and classifier analytics integration test passed.')
} finally {
  if (connected) {
    const db = client.db(databaseName)
    await Promise.all([
      db.collection('classifiers').deleteMany({ id: { $in: [ids.activeClassifier, ids.archivedClassifier] } }),
      db.collection('sessions').deleteMany({ id: ids.session }),
      db.collection('workspace_memberships').deleteMany({ id: ids.membership }),
      db.collection('workspaces').deleteMany({ id: ids.workspace }),
      db.collection('users').deleteMany({ id: ids.user }),
    ])
  }
  await client.close()
}

import 'dotenv/config'
import { createHash, randomBytes } from 'node:crypto'
import { MongoClient } from 'mongodb'

const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017'
const databaseName = process.env.MONGODB_DATABASE || 'jev_studio'
const apiOrigin = process.env.TEST_API_ORIGIN || 'http://127.0.0.1:3001'
const suffix = randomBytes(6).toString('hex')
const ids = { user: `test_usr_${suffix}`, workspace: `test_ws_${suffix}`, membership: `test_mem_${suffix}`, session: `test_ses_${suffix}`, classifier: `test_cls_${suffix}` }
const token = randomBytes(24).toString('base64url')
const client = new MongoClient(mongoUri)
let connected = false

try {
  await client.connect()
  connected = true
  const db = client.db(databaseName)
  const now = new Date()
  await Promise.all([
    db.collection('users').insertOne({ id: ids.user, googleSub: `test_${suffix}`, email: `${suffix}@example.test`, name: 'Deployment test', createdAt: now }),
    db.collection('workspaces').insertOne({ id: ids.workspace, name: 'Deployment test', plan: 'free', quotas: { maxClassifiers: 5, monthlyApiCalls: 1000 }, usage: { activeClassifiers: 1 }, createdAt: now }),
    db.collection('workspace_memberships').insertOne({ id: ids.membership, userId: ids.user, workspaceId: ids.workspace, role: 'owner', createdAt: now }),
    db.collection('sessions').insertOne({ id: ids.session, tokenHash: createHash('sha256').update(token).digest('hex'), userId: ids.user, workspaceId: ids.workspace, createdAt: now, expiresAt: new Date(Date.now() + 60_000) }),
    db.collection('classifiers').insertOne({
      id: ids.classifier,
      workspaceId: ids.workspace,
      createdBy: ids.user,
      name: 'Idempotency test',
      description: 'Temporary integration fixture',
      questions: { is_valid: { type: 'noul', instructions: 'The state is valid.' } },
      deployedVersion: null,
      deployments: [],
      deploymentEvents: [],
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    }),
  ])

  const deploy = () => fetch(`${apiOrigin}/api/classifiers/${ids.classifier}/deploy`, { method: 'POST', headers: { Cookie: `jev_session=${token}` } })
  const simultaneous = await Promise.all([deploy(), deploy()])
  const statuses = simultaneous.map((response) => response.status).sort()
  if (statuses.join(',') !== '200,201') throw new Error(`Expected concurrent statuses 200,201; received ${statuses.join(',')}`)

  const repeated = await deploy()
  if (repeated.status !== 200) throw new Error(`Expected repeated deployment status 200; received ${repeated.status}`)
  const repeatedBody = await repeated.json()
  if (!repeatedBody.reused || repeatedBody.activated) throw new Error('Repeated deployment was not reported as an unchanged reuse.')

  const classifier = await db.collection('classifiers').findOne({ id: ids.classifier })
  if (classifier.deployments.length !== 1 || classifier.deploymentEvents.length !== 1 || classifier.deployedVersion !== 1) {
    throw new Error('Concurrent deployment created duplicate snapshots or events.')
  }

  await db.collection('classifiers').updateOne({ id: ids.classifier }, { $set: { language: 'fr', updatedAt: new Date() } })
  const languageDeployment = await deploy()
  if (languageDeployment.status !== 201) throw new Error(`Expected a language change to create a deployment; received ${languageDeployment.status}`)
  const languageBody = await languageDeployment.json()
  if (languageBody.version !== 2 || languageBody.language !== 'fr') throw new Error('Classifier language was not preserved in the immutable deployment.')

  console.log('Deployment idempotency integration test passed.')
} finally {
  if (connected) {
    const db = client.db(databaseName)
    await Promise.all([
      db.collection('classifiers').deleteMany({ id: ids.classifier }),
      db.collection('sessions').deleteMany({ id: ids.session }),
      db.collection('workspace_memberships').deleteMany({ id: ids.membership }),
      db.collection('workspaces').deleteMany({ id: ids.workspace }),
      db.collection('users').deleteMany({ id: ids.user }),
    ])
  }
  await client.close()
}

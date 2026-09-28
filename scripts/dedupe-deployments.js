import 'dotenv/config'
import { MongoClient } from 'mongodb'
import { deploymentContentHash } from '../deployment-utils.js'

const apply = process.argv.includes('--apply')
const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017'
const databaseName = process.env.MONGODB_DATABASE || 'jev_studio'
const client = new MongoClient(mongoUri)

function dedupeClassifier(classifier) {
  const deployments = classifier.deployments || []
  const groups = new Map()
  for (const deployment of deployments) {
    const contentHash = deploymentContentHash(deployment)
    const entries = groups.get(contentHash) || []
    entries.push({ ...deployment, contentHash })
    groups.set(contentHash, entries)
  }

  const kept = []
  const removedVersions = new Set()
  for (const entries of groups.values()) {
    const active = entries.find((entry) => entry.version === classifier.deployedVersion)
    const keeper = active || entries.reduce((earliest, entry) => entry.version < earliest.version ? entry : earliest)
    kept.push(keeper)
    for (const entry of entries) if (entry.version !== keeper.version) removedVersions.add(entry.version)
  }
  kept.sort((left, right) => left.version - right.version)

  return {
    deployments: kept,
    deploymentEvents: (classifier.deploymentEvents || []).filter((event) => !removedVersions.has(event.version)),
    removedVersions: [...removedVersions].sort((left, right) => left - right),
  }
}

try {
  await client.connect()
  const collection = client.db(databaseName).collection('classifiers')
  const classifiers = await collection.find({}, { projection: { id: 1, name: 1, deployedVersion: 1, deployments: 1, deploymentEvents: 1 } }).toArray()
  let duplicateCount = 0
  let changedClassifiers = 0

  for (const classifier of classifiers) {
    const result = dedupeClassifier(classifier)
    duplicateCount += result.removedVersions.length
    const hashesMissing = (classifier.deployments || []).some((deployment) => !deployment.contentHash)
    if (!result.removedVersions.length && !hashesMissing) continue
    changedClassifiers += 1
    console.log(`${apply ? 'Updating' : 'Would update'} ${classifier.name || classifier.id}: removing versions ${result.removedVersions.join(', ') || 'none'}${hashesMissing ? '; backfilling hashes' : ''}`)
    if (apply) {
      await collection.updateOne(
        { _id: classifier._id },
        { $set: { deployments: result.deployments, deploymentEvents: result.deploymentEvents, updatedAt: new Date() } },
      )
    }
  }

  console.log(`${apply ? 'Updated' : 'Checked'} ${classifiers.length} classifiers; ${duplicateCount} exact duplicate deployments ${apply ? 'removed' : 'found'} across ${changedClassifiers} classifiers.`)
} finally {
  await client.close()
}

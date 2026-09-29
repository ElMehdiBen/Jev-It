import { createHash } from 'node:crypto'

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

export function deploymentContent(value) {
  return {
    name: String(value?.name || '').trim(),
    description: String(value?.description || '').trim(),
    language: ['auto', 'en', 'fr', 'ar'].includes(value?.language) ? value.language : 'auto',
    questions: value?.questions || {},
  }
}

export function deploymentContentHash(value) {
  const canonical = JSON.stringify(canonicalize(deploymentContent(value)))
  return createHash('sha256').update(canonical).digest('hex')
}

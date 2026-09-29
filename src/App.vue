<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, Archive, ArchiveRestore, BarChart3, CheckCircle2, Clock3, Copy, Eye, Fingerprint, KeyRound, Languages, Layers3, LogOut, Plus, RefreshCw, Rocket, Send, Trash2, Users } from '@lucide/vue'
import { supportedLocales } from '@/i18n'
import studioPreview from '../docs/screenshots/studio-builder.png'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const { t, locale } = useI18n()
const health = ref({ mongo: false, openai: false, typesafe: false, authConfigured: false, model: 'gpt-6-luna' })
const booting = ref(true)
const auth = ref({ authenticated: false, user: null, workspace: null, quota: null })
const classifiers = ref([])
const archivedClassifiers = ref([])
const archiveLoading = ref(false)
const currentView = ref('builder')
const session = ref(null)
const draft = ref({ name: 'New classifier', description: '', questions: {}, ready: false })
const chatInput = ref('')
const sending = ref(false)
const creating = ref(false)
const pageError = ref('')
const selected = ref(null)
const classifierDraft = ref(null)
const activeTab = ref('configure')
const saving = ref(false)
const testing = ref(false)
const testInput = ref('')
const testResults = ref([])
const deploying = ref(false)
const keyStatus = ref({ active: false })
const revealedKey = ref('')
const toast = ref('')
const chatLog = ref(null)
const analytics = ref(null)
const adminAnalytics = ref(null)
const analyticsScope = ref('workspace')
const analyticsLoading = ref(false)

watch(locale, (value) => {
  localStorage.setItem('jev_locale', value)
  document.documentElement.lang = value
  document.documentElement.dir = 'ltr'
}, { immediate: true })

function normalizeClassifierLanguage(value) {
  return ['auto', 'en', 'fr'].includes(value) ? value : 'auto'
}

const questionEntries = computed(() => Object.entries(classifierDraft.value?.questions || {}))
const draftEntries = computed(() => Object.entries(draft.value?.questions || {}))
const draftName = computed(() => ['New classifier', 'Nouveau classificateur'].includes(draft.value?.name) ? t('builder.newClassifier') : draft.value?.name)
const deployedSnapshot = computed(() => selected.value?.deployments?.find((item) => item.version === selected.value.deployedVersion))
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  return value
}
function classifierContent(value) {
  return canonicalize({ name: String(value?.name || '').trim(), description: String(value?.description || '').trim(), language: normalizeClassifierLanguage(value?.language), questions: value?.questions || {} })
}
const hasUnsavedChanges = computed(() => Boolean(selected.value && classifierDraft.value)
  && JSON.stringify(classifierContent(classifierDraft.value)) !== JSON.stringify(classifierContent(selected.value)))
const hasSavedDeploymentChanges = computed(() => Boolean(selected.value)
  && (!deployedSnapshot.value || JSON.stringify(classifierContent(selected.value)) !== JSON.stringify(classifierContent(deployedSnapshot.value))))
const canDeploy = computed(() => !deploying.value && !hasUnsavedChanges.value && hasSavedDeploymentChanges.value)
const deployLabel = computed(() => deploying.value ? t('actions.deploying') : hasUnsavedChanges.value ? t('actions.saveFirst') : hasSavedDeploymentChanges.value ? t('actions.deployDraft') : t('actions.upToDate'))
const platformOrigin = computed(() => window.location.origin)
const endpointExample = computed(() => JSON.stringify({ classifier_id: selected.value?.id || 'cls_your_classifier', state: t('api.exampleState') }, null, 2))
function questionsForLanguage(questions = {}, language = 'auto') {
  const directives = {
    en: 'Interpret the supplied state in English.',
    fr: 'Interprétez l’état fourni en français.',
  }
  const directive = directives[language]
  if (!directive) return questions
  return Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, { ...question, instructions: `${directive} ${question.instructions}` }]))
}
const directJevPayload = computed(() => JSON.stringify({
  state: t('api.exampleState'),
  model: 'jev-latest',
  questions: questionsForLanguage(deployedSnapshot.value?.questions || {}, deployedSnapshot.value?.language || 'auto'),
}, null, 2))
const platformCurl = computed(() => `curl -X POST ${platformOrigin.value}/api/classify \\
  -H 'Authorization: Bearer YOUR_PROJECT_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '${endpointExample.value}'`)
const directJevCurl = computed(() => `curl -X POST https://api.typesafe.ai/v1/systemone \\
  -H 'Authorization: Bearer YOUR_TYPESAFE_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '${directJevPayload.value}'`)
const visibleAnalytics = computed(() => analyticsScope.value === 'platform' ? adminAnalytics.value : analytics.value)
const maxTimelineCalls = computed(() => Math.max(1, ...(visibleAnalytics.value?.timeline || []).map((item) => item.calls)))
const pageTitle = computed(() => currentView.value === 'builder' ? t('page.builder') : currentView.value === 'keys' ? t('page.keys') : currentView.value === 'analytics' ? t('page.analytics') : currentView.value === 'archive' ? t('page.archive') : selected.value?.name)

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Accept-Language': locale.value, ...(options.headers || {}) },
  })
  if (response.status === 204) return null
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.code === 'openai_connection_timeout' ? t('error.openaiTimeout') : data.error || t('error.request'))
  return data
}

function messageContent(message, index) {
  return message.kind === 'greeting' || (index === 0 && message.role === 'assistant') ? t('builder.greeting') : message.content
}

function notify(message) {
  toast.value = message
  window.setTimeout(() => { if (toast.value === message) toast.value = '' }, 2600)
}

async function loadHealth() {
  try { health.value = await api('/api/health') } catch (error) { pageError.value = error.message }
}

async function loadAuthSession() {
  try {
    const response = await fetch('/api/auth/session')
    auth.value = response.ok ? await response.json() : { authenticated: false, user: null, workspace: null, quota: null }
  } catch {
    auth.value = { authenticated: false, user: null, workspace: null, quota: null }
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' })
  auth.value = { authenticated: false, user: null, workspace: null, quota: null }
  classifiers.value = []
  session.value = null
}

async function openAnalytics() {
  currentView.value = 'analytics'
  selected.value = null
  analyticsScope.value = 'workspace'
  analyticsLoading.value = true
  pageError.value = ''
  try {
    const requests = [api('/api/analytics')]
    if (auth.value.user?.isPlatformAdmin) requests.push(api('/api/admin/analytics'))
    const [workspaceUsage, platformUsage] = await Promise.all(requests)
    analytics.value = workspaceUsage
    adminAnalytics.value = platformUsage || null
    await loadAuthSession()
  } catch (error) { pageError.value = error.message }
  finally { analyticsLoading.value = false }
}

async function loadClassifiers() {
  if (!health.value.mongo) return
  try { classifiers.value = (await api('/api/classifiers')).items } catch (error) { pageError.value = error.message }
}

async function openArchive() {
  currentView.value = 'archive'
  selected.value = null
  archiveLoading.value = true
  pageError.value = ''
  try { archivedClassifiers.value = (await api('/api/classifiers?archived=true')).items } catch (error) { pageError.value = error.message }
  finally { archiveLoading.value = false }
}

async function loadKeyStatus() {
  if (!health.value.mongo) return
  try { keyStatus.value = await api('/api/keys') } catch {}
}

async function newBuilder() {
  currentView.value = 'builder'
  selected.value = null
  activeTab.value = 'configure'
  pageError.value = ''
  if (!health.value.mongo) return
  try {
    session.value = await api('/api/builder/sessions', { method: 'POST', body: JSON.stringify({ language: locale.value }) })
    draft.value = session.value.draft
  } catch (error) { pageError.value = error.message }
}

async function sendMessage() {
  const message = chatInput.value.trim()
  if (!message || sending.value || !session.value) return
  chatInput.value = ''
  pageError.value = ''
  session.value.messages.push({ role: 'user', content: message, createdAt: new Date() })
  sending.value = true
  await nextTick()
  chatLog.value?.scrollTo({ top: chatLog.value.scrollHeight, behavior: 'smooth' })
  try {
    const result = await api(`/api/builder/sessions/${session.value.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message, language: locale.value }),
    })
    session.value.messages.push(result.message)
    draft.value = result.draft
    await nextTick()
    chatLog.value?.scrollTo({ top: chatLog.value.scrollHeight, behavior: 'smooth' })
  } catch (error) {
    session.value.messages.pop()
    chatInput.value = message
    pageError.value = error.message
  } finally { sending.value = false }
}

async function createClassifier() {
  if (!draft.value.ready || creating.value) return
  creating.value = true
  try {
    const classifier = await api(`/api/builder/sessions/${session.value.id}/create`, { method: 'POST' })
    await Promise.all([loadClassifiers(), loadAuthSession()])
    notify(t('actions.created'))
    await openClassifier(classifier.id)
  } catch (error) { pageError.value = error.message }
  finally { creating.value = false }
}

async function openClassifier(classifierId) {
  pageError.value = ''
  currentView.value = 'classifier'
  activeTab.value = 'configure'
  classifierDraft.value = null
  try {
    selected.value = await api(`/api/classifiers/${classifierId}`)
    selected.value.language = normalizeClassifierLanguage(selected.value.language)
    classifierDraft.value = JSON.parse(JSON.stringify(selected.value))
    testInput.value = ''
    testResults.value = []
  } catch (error) { pageError.value = error.message }
}

function updateQuestionKey(oldKey, event) {
  const newKey = event.target.value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  if (!newKey || newKey === oldKey || classifierDraft.value.questions[newKey]) {
    event.target.value = oldKey
    return
  }
  const next = {}
  for (const [key, value] of Object.entries(classifierDraft.value.questions)) next[key === oldKey ? newKey : key] = value
  classifierDraft.value.questions = next
}

function changeQuestionType(question) {
  const language = classifierDraft.value?.language === 'auto' ? locale.value : classifierDraft.value?.language
  const defaults = {
    en: { first: 'First outcome', second: 'Second outcome', low: 'Low', medium: 'Medium', high: 'High' },
    fr: { first: 'Premier résultat', second: 'Deuxième résultat', low: 'Faible', medium: 'Moyen', high: 'Élevé' },
  }[language] || { first: 'First outcome', second: 'Second outcome', low: 'Low', medium: 'Medium', high: 'High' }
  if (question.type === 'choice') question.criteria = { option_a: defaults.first, option_b: defaults.second }
  else if (question.type === 'score') question.criteria = [defaults.low, defaults.medium, defaults.high]
  else delete question.criteria
}

function addQuestion() {
  let index = questionEntries.value.length + 1
  while (classifierDraft.value.questions[`question_${index}`]) index += 1
  const language = classifierDraft.value?.language === 'auto' ? locale.value : classifierDraft.value?.language
  const instructions = { en: 'The state meets this condition.', fr: 'L’état remplit cette condition.' }[language] || 'The state meets this condition.'
  classifierDraft.value.questions[`question_${index}`] = { type: 'noul', instructions }
}

function removeQuestion(key) {
  const next = { ...classifierDraft.value.questions }
  delete next[key]
  classifierDraft.value.questions = next
}

function addChoice(question) {
  let index = Object.keys(question.criteria || {}).length + 1
  while (question.criteria[`option_${index}`]) index += 1
  const language = classifierDraft.value?.language === 'auto' ? locale.value : classifierDraft.value?.language
  question.criteria[`option_${index}`] = { en: 'Describe this outcome', fr: 'Décrivez ce résultat' }[language] || 'Describe this outcome'
}

function addScoreLevel(question) {
  const language = classifierDraft.value?.language === 'auto' ? locale.value : classifierDraft.value?.language
  question.criteria.push({ en: 'New level', fr: 'Nouveau niveau' }[language] || 'New level')
}

function renameChoice(question, oldKey, value) {
  const newKey = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  if (!newKey || newKey === oldKey || question.criteria[newKey]) return
  const next = {}
  for (const [key, description] of Object.entries(question.criteria)) next[key === oldKey ? newKey : key] = description
  question.criteria = next
}

async function saveClassifier() {
  saving.value = true
  pageError.value = ''
  try {
    selected.value = await api(`/api/classifiers/${selected.value.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: classifierDraft.value.name,
        description: classifierDraft.value.description,
        language: classifierDraft.value.language || 'auto',
        questions: classifierDraft.value.questions,
      }),
    })
    classifierDraft.value = JSON.parse(JSON.stringify(selected.value))
    await loadClassifiers()
    notify(t('actions.saved'))
  } catch (error) { pageError.value = error.message }
  finally { saving.value = false }
}

async function runTests() {
  const states = testInput.value.split(/\n\s*---+\s*\n/).map((item) => item.trim()).filter(Boolean)
  if (!states.length) return
  testing.value = true
  pageError.value = ''
  testResults.value = []
  try {
    const result = await api(`/api/classifiers/${selected.value.id}/test`, {
      method: 'POST',
      body: JSON.stringify({ states }),
    })
    testResults.value = result.results
    await loadAuthSession()
  } catch (error) { pageError.value = error.message }
  finally { testing.value = false }
}

async function deploy() {
  if (!canDeploy.value) return
  deploying.value = true
  try {
    const result = await api(`/api/classifiers/${selected.value.id}/deploy`, { method: 'POST' })
    await openClassifier(selected.value.id)
    activeTab.value = 'deploy'
    notify(result.reused ? (result.activated ? t('deployment.existingActivated', { version: result.version }) : t('deployment.already')) : t('deployment.new'))
  } catch (error) { pageError.value = error.message }
  finally { deploying.value = false }
}

async function activateVersion(version) {
  try {
    await api(`/api/classifiers/${selected.value.id}/activate/${version}`, { method: 'POST' })
    await openClassifier(selected.value.id)
    activeTab.value = 'deploy'
    notify(t('deployment.activated', { version }))
  } catch (error) { pageError.value = error.message }
}

async function archiveClassifier() {
  if (!selected.value || !window.confirm(t('classifier.archiveConfirm', { name: selected.value.name }))) return
  try {
    await api(`/api/classifiers/${selected.value.id}/archive`, { method: 'POST' })
    selected.value = null
    classifierDraft.value = null
    await Promise.all([loadClassifiers(), loadAuthSession()])
    notify(t('classifier.archivedNotice'))
    await openArchive()
  } catch (error) { pageError.value = error.message }
}

async function restoreClassifier(classifier) {
  try {
    await api(`/api/classifiers/${classifier.id}/restore`, { method: 'POST' })
    await Promise.all([openArchive(), loadClassifiers(), loadAuthSession()])
    notify(t('archive.restored'))
  } catch (error) { pageError.value = error.message }
}

async function deleteClassifier(classifier) {
  if (!window.confirm(t('archive.deleteConfirm', { name: classifier.name }))) return
  try {
    await api(`/api/classifiers/${classifier.id}`, { method: 'DELETE' })
    await openArchive()
    notify(t('archive.deleted'))
  } catch (error) { pageError.value = error.message }
}

async function rotateKey() {
  try {
    const result = await api('/api/keys/rotate', { method: 'POST' })
    revealedKey.value = result.key
    await loadKeyStatus()
  } catch (error) { pageError.value = error.message }
}

async function revokeKey() {
  if (!window.confirm(t('keys.revokeConfirm'))) return
  try {
    await api('/api/keys/current', { method: 'DELETE' })
    revealedKey.value = ''
    await loadKeyStatus()
    notify(t('keys.revoked'))
  } catch (error) { pageError.value = error.message }
}

async function copy(value) {
  await navigator.clipboard.writeText(value)
  notify(t('actions.copied'))
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat(locale.value, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'
}

function answerValue(answer) {
  if (answer.type === 'choice') return answer.choice
  if (answer.type === 'score') return answer.score
  return t('testing.trueValue', { value: Math.round(answer.noul * 100) })
}

onMounted(async () => {
  await loadHealth()
  if (health.value.mongo) await loadAuthSession()
  if (auth.value.authenticated) {
    await Promise.all([loadClassifiers(), loadKeyStatus()])
    await newBuilder()
  }
  booting.value = false
})
</script>

<template>
  <section v-if="booting" class="auth-screen auth-loading"><span class="brand-bars"><i></i><i></i><i></i></span><p>{{ t('auth.opening') }}</p></section>

  <section v-else-if="!auth.authenticated" class="auth-screen">
    <div class="auth-brand"><span class="brand-bars"><i></i><i></i><i></i></span><span>Jev-It <b>Studio</b></span></div>
    <div class="auth-actions">
      <a class="github-link" href="https://github.com/ElMehdiBen/Jev-It" target="_blank" rel="noreferrer" :aria-label="t('auth.github')"><svg aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.27 3.38.97.1-.75.4-1.27.74-1.56-2.57-.3-5.28-1.29-5.28-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18A10.9 10.9 0 0 1 12 6.1c.98 0 1.95.13 2.87.39 2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.39-5.29 5.68.42.36.79 1.07.79 2.16v3.25c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z"/></svg><span>{{ t('auth.github') }}</span></a>
      <label class="locale-picker auth-locale"><Languages aria-hidden="true" /><span class="sr-only">{{ t('common.language') }}</span><select v-model="locale"><option v-for="item in supportedLocales" :key="item.code" :value="item.code">{{ item.label }}</option></select></label>
    </div>
    <div class="auth-content">
      <div class="auth-copy">
        <span class="overline">{{ t('auth.overline') }}</span>
        <h1>{{ t('auth.title') }}<br><em>{{ t('auth.titleEm') }}</em></h1>
        <p>{{ t('auth.description') }}</p>
        <Button v-if="health.mongo && health.authConfigured" as-child class="google-button">
          <a href="/api/auth/google"><span>G</span> {{ t('auth.continueGoogle') }} <b>→</b></a>
        </Button>
        <div v-else class="auth-setup">
          <b>{{ !health.mongo ? t('auth.mongoMissing') : t('auth.googleMissing') }}</b>
          <code v-if="!health.authConfigured">GOOGLE_CLIENT_ID=…<br>GOOGLE_CLIENT_SECRET=…</code>
          <Button type="button" @click="loadHealth().then(loadAuthSession)">{{ t('auth.check') }}</Button>
        </div>
      </div>
      <figure class="auth-preview">
        <div><span><i></i>{{ t('auth.previewLabel') }}</span><span>JEV-IT / STUDIO</span></div>
        <img :src="studioPreview" :alt="t('auth.previewAlt')">
      </figure>
      </div>
    <div class="auth-foot"><span>{{ t('auth.freeClassifiers') }}</span><span>{{ t('auth.monthlyCalls') }}</span><span>{{ t('auth.privateWorkspace') }}</span></div>
  </section>

  <div v-else class="studio-shell">
    <aside class="sidebar">
      <a class="studio-brand" href="#" @click.prevent="newBuilder">
        <span class="brand-bars"><i></i><i></i><i></i></span>
        <span>Jev-It <span>Studio</span></span>
      </a>

      <Button class="new-button" variant="outline" type="button" @click="newBuilder"><Plus aria-hidden="true" /> {{ t('nav.newClassifier') }}</Button>

      <nav class="classifier-nav">
        <p>{{ t('nav.classifiers') }} <span>{{ classifiers.length }}</span></p>
        <button
          v-for="classifier in classifiers"
          :key="classifier.id"
          type="button"
          :class="{ active: selected?.id === classifier.id && currentView === 'classifier' }"
          @click="openClassifier(classifier.id)"
        >
          <span class="nav-icon">{{ classifier.name.slice(0, 1).toUpperCase() }}</span>
          <span><b>{{ classifier.name }}</b><small>{{ classifier.deployedVersion ? `${t('common.live')} · v${classifier.deployedVersion}` : t('common.draft') }}</small></span>
          <i>›</i>
        </button>
        <div v-if="!classifiers.length" class="empty-nav">{{ t('nav.empty') }}</div>
      </nav>

      <div class="sidebar-bottom">
        <button type="button" :class="{ active: currentView === 'analytics' }" @click="openAnalytics">
          <BarChart3 aria-hidden="true" /> {{ t('page.analytics') }}
        </button>
        <button type="button" :class="{ active: currentView === 'keys' }" @click="currentView = 'keys'; selected = null">
          <KeyRound aria-hidden="true" /> {{ t('page.keys') }} <i :class="['tiny-dot', { on: keyStatus.active }]"></i>
        </button>
        <button type="button" :class="{ active: currentView === 'archive' }" @click="openArchive">
          <Archive aria-hidden="true" /> {{ t('nav.archived') }}
        </button>
        <div class="quota-mini" v-if="auth.quota">
          <div><span>{{ t('nav.freePlan') }}</span><b>{{ auth.quota.apiCalls.used }} / {{ auth.quota.apiCalls.limit }} {{ t('common.calls') }}</b></div>
          <Progress class="quota-progress" :model-value="Math.min(100, auth.quota.apiCalls.used / auth.quota.apiCalls.limit * 100)" />
        </div>
        <div class="account-mini">
          <Avatar class="account-avatar">
            <AvatarImage v-if="auth.user.picture" :src="auth.user.picture" referrer-policy="no-referrer" />
            <AvatarFallback>{{ auth.user.name.slice(0, 1) }}</AvatarFallback>
          </Avatar>
          <div><b>{{ auth.user.name }}</b><small>{{ auth.user.email }}</small></div>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger as-child><Button variant="ghost" size="icon-xs" type="button" :aria-label="t('common.signOut')" @click="logout"><LogOut aria-hidden="true" /></Button></TooltipTrigger>
              <TooltipContent side="right">{{ t('common.signOut') }}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div class="service-state">
          <span><i :class="{ on: health.mongo }"></i> MongoDB</span>
          <span><i :class="{ on: health.openai }"></i> Luna</span>
          <span><i :class="{ on: health.typesafe }"></i> JEV</span>
        </div>
      </div>
    </aside>

    <main class="studio-main">
      <header class="studio-topbar">
        <div>
          <span class="crumb">{{ t('common.workspace') }} /</span>
          <b>{{ pageTitle }}</b>
        </div>
        <div class="topbar-actions">
          <label class="locale-picker"><Languages aria-hidden="true" /><span class="sr-only">{{ t('common.language') }}</span><select v-model="locale"><option v-for="item in supportedLocales" :key="item.code" :value="item.code">{{ item.short }}</option></select></label>
          <div class="top-status"><i></i> {{ auth.workspace.name }}</div>
        </div>
      </header>

      <div v-if="pageError" class="global-error"><span>!</span>{{ pageError }}<button @click="pageError = ''">×</button></div>

      <section v-if="currentView === 'builder'" class="builder-view">
        <div v-if="!health.mongo" class="setup-screen">
          <span class="setup-number">01</span>
          <h1>{{ t('setup.title') }}<br><em>{{ t('setup.titleEm') }}</em></h1>
          <p>{{ t('setup.description') }}</p>
          <code>MONGODB_URI=mongodb://127.0.0.1:27017</code>
          <button type="button" @click="loadHealth().then(newBuilder)">{{ t('setup.check') }} →</button>
        </div>

        <template v-else-if="session">
          <div class="chat-pane">
            <div class="pane-heading">
              <span class="overline">{{ t('builder.overline') }}</span>
              <h1>{{ t('builder.title') }}</h1>
              <p>{{ t('builder.description') }}</p>
            </div>

            <div ref="chatLog" class="chat-log">
              <div v-for="(message, index) in session.messages" :key="index" class="message" :class="message.role">
                <span class="message-avatar">{{ message.role === 'assistant' ? 'J' : 'Y' }}</span>
                <div><small>{{ message.role === 'assistant' ? t('builder.architect') : t('builder.you') }}</small><p>{{ messageContent(message, index) }}</p></div>
              </div>
              <div v-if="sending" class="message assistant">
                <span class="message-avatar">J</span><div><small>{{ t('builder.architect') }}</small><p class="thinking"><i></i><i></i><i></i></p></div>
              </div>
            </div>

            <form class="chat-composer" @submit.prevent="sendMessage">
              <Textarea v-model="chatInput" :disabled="sending || !health.openai" :placeholder="t('builder.placeholder')" rows="2" @keydown.meta.enter.prevent="sendMessage" @keydown.ctrl.enter.prevent="sendMessage" />
              <div>
                <span>{{ health.openai ? `${health.model} · ${t('builder.lowReasoning')}` : t('builder.missingKey') }}</span>
                <Button type="submit" :disabled="!chatInput.trim() || sending">{{ sending ? t('builder.thinking') : t('builder.send') }} <Send aria-hidden="true" /></Button>
              </div>
            </form>
          </div>

          <aside class="live-draft">
            <div class="draft-header">
              <div><span class="live-pill"><i></i> {{ t('builder.liveDraft') }}</span><small>{{ t('builder.updates') }}</small></div>
              <Badge class="question-count" variant="outline">{{ draftEntries.length }} Q</Badge>
            </div>
            <div class="draft-identity">
              <span>{{ t('builder.classifierName') }}</span>
              <h2>{{ draftName }}</h2>
              <p>{{ draft.description || t('builder.purposePending') }}</p>
            </div>
            <div class="draft-questions">
              <article v-for="([key, question], index) in draftEntries" :key="key">
                <div><span>{{ String(index + 1).padStart(2, '0') }}</span><Badge class="question-type" :class="question.type">{{ question.type }}</Badge></div>
                <h3>{{ key.replaceAll('_', ' ') }}</h3>
                <p>{{ question.instructions }}</p>
                <div v-if="question.criteria" class="criteria-preview">
                  <span v-for="(_, label) in question.criteria" :key="label">{{ Array.isArray(question.criteria) ? _ : label }}</span>
                </div>
              </article>
              <div v-if="!draftEntries.length" class="empty-draft"><span>◇</span><p>{{ t('builder.questionsPending') }}</p></div>
            </div>
            <div class="draft-footer">
              <p v-if="!draft.ready"><i></i> {{ t('builder.needsDetail') }}</p>
              <p v-else class="ready"><i></i> {{ t('builder.ready') }}</p>
              <button type="button" :disabled="!draft.ready || creating" @click="createClassifier">{{ creating ? t('builder.creating') : t('builder.create') }} <span>→</span></button>
            </div>
          </aside>
        </template>
      </section>

      <section v-else-if="currentView === 'classifier' && classifierDraft" class="classifier-view">
        <div class="classifier-hero">
          <div>
            <span class="overline">{{ selected.deployedVersion ? t('classifier.productionVersion', { version: selected.deployedVersion }) : t('classifier.undeployed') }}</span>
            <h1>{{ selected.name }}</h1>
            <p>{{ selected.description || t('classifier.noDescription') }}</p>
          </div>
          <Button class="deploy-button" type="button" :disabled="!canDeploy" @click="deploy">{{ deployLabel }} <Rocket aria-hidden="true" /></Button>
        </div>

        <Tabs v-model="activeTab" class="classifier-tabs">
          <TabsList class="tabs">
            <TabsTrigger v-for="tab in ['configure', 'test', 'deploy', 'api']" :key="tab" :value="tab">{{ t(`classifier.${tab}`) }}</TabsTrigger>
          </TabsList>
        </Tabs>

        <div v-if="activeTab === 'configure'" class="configure-layout">
          <div class="editor-main">
            <div class="form-section identity-editor">
              <div class="section-title"><span>01</span><div><h2>{{ t('classifier.identity') }}</h2><p>{{ t('classifier.identityHelp') }}</p></div></div>
              <label>{{ t('classifier.name') }}<Input v-model="classifierDraft.name" /></label>
              <label>{{ t('classifier.description') }}<Textarea v-model="classifierDraft.description" rows="3" /></label>
              <label>{{ t('classifier.contentLanguage') }}<select v-model="classifierDraft.language" class="language-select"><option value="auto">{{ t('classifier.autoLanguage') }}</option><option v-for="item in supportedLocales" :key="item.code" :value="item.code">{{ item.label }}</option></select><small class="field-help">{{ t('classifier.contentLanguageHelp') }}</small></label>
            </div>

            <div class="form-section">
              <div class="section-title"><span>02</span><div><h2>{{ t('classifier.questions') }}</h2><p>{{ t('classifier.questionsHelp') }}</p></div><button type="button" @click="addQuestion">＋ {{ t('classifier.addQuestion') }}</button></div>
              <article v-for="([key, question], index) in questionEntries" :key="key" class="question-editor">
                <div class="question-editor-head">
                  <span>{{ String(index + 1).padStart(2, '0') }}</span>
                  <Input class="key-input" :model-value="key" @change="updateQuestionKey(key, $event)" />
                  <select v-model="question.type" @change="changeQuestionType(question)"><option value="noul">Noul</option><option value="choice">Choice</option><option value="score">Score</option></select>
                  <button type="button" :aria-label="t('classifier.removeQuestion')" @click="removeQuestion(key)">×</button>
                </div>
                <label>{{ t('classifier.instructions') }}<Textarea v-model="question.instructions" rows="2" /></label>
                <div v-if="question.type === 'choice'" class="criteria-editor">
                  <span>{{ t('classifier.choiceOptions') }}</span>
                  <div v-for="(description, optionKey) in question.criteria" :key="optionKey">
                    <Input :model-value="optionKey" @change="renameChoice(question, optionKey, $event.target.value)" />
                    <Input v-model="question.criteria[optionKey]" />
                    <button type="button" @click="delete question.criteria[optionKey]">×</button>
                  </div>
                  <button type="button" @click="addChoice(question)">＋ {{ t('classifier.addOption') }}</button>
                </div>
                <div v-if="question.type === 'score'" class="criteria-editor">
                  <span>{{ t('classifier.scoreLevels') }}</span>
                  <div v-for="(_, levelIndex) in question.criteria" :key="levelIndex">
                    <b>{{ levelIndex }}</b><Input v-model="question.criteria[levelIndex]" /><button type="button" @click="question.criteria.splice(levelIndex, 1)">×</button>
                  </div>
                  <button type="button" @click="addScoreLevel(question)">＋ {{ t('classifier.addLevel') }}</button>
                </div>
              </article>
            </div>
          </div>
          <aside class="editor-aside">
            <div><span>{{ t('classifier.id') }}</span><code>{{ selected.id }}</code><button @click="copy(selected.id)"><Copy aria-hidden="true" /> {{ t('common.copy') }}</button></div>
            <div><span>{{ t('classifier.draftQuestions') }}</span><strong>{{ questionEntries.length }}</strong></div>
            <div><span>{{ t('classifier.production') }}</span><strong>{{ selected.deployedVersion ? `v${selected.deployedVersion}` : t('classifier.notDeployed') }}</strong></div>
            <button class="save-button" type="button" :disabled="saving" @click="saveClassifier">{{ saving ? t('classifier.saving') : t('classifier.saveDraft') }} <span>→</span></button>
            <p>{{ t('classifier.saveHelp') }}</p>
            <button class="archive-button" type="button" @click="archiveClassifier"><Archive aria-hidden="true" /> {{ t('classifier.archive') }}</button>
          </aside>
        </div>

        <div v-else-if="activeTab === 'test'" class="test-layout">
          <div class="test-input-panel">
            <span class="overline">{{ t('testing.overline') }}</span><h2>{{ t('testing.title') }}</h2>
            <p>{{ t('testing.description') }}</p>
            <Textarea v-model="testInput" :placeholder="t('testing.placeholder')" />
            <Button type="button" :disabled="!testInput.trim() || testing" @click="runTests">{{ testing ? t('testing.running') : t('testing.run') }} <span>→</span></Button>
          </div>
          <div class="test-results">
            <div v-if="!testResults.length" class="test-empty"><span>⌁</span><h3>{{ t('testing.emptyTitle') }}</h3><p>{{ t('testing.emptyDescription') }}</p></div>
            <article v-for="(result, resultIndex) in testResults" :key="resultIndex" class="test-result">
              <div class="result-state"><span>{{ t('testing.state', { number: resultIndex + 1 }) }}</span><p>{{ result.state }}</p></div>
              <div class="answer-list">
                <div v-for="(answer, key) in result.response.answers" :key="key">
                  <Badge class="question-type" :class="answer.type">{{ answer.type }}</Badge>
                  <b>{{ key.replaceAll('_', ' ') }}</b><strong>{{ answerValue(answer) }}</strong>
                  <small v-if="answer.confidence !== undefined">{{ t('testing.confidence', { value: Math.round(answer.confidence * 100) }) }}</small>
                </div>
              </div>
              <Collapsible v-slot="{ open }" class="raw-response">
                <CollapsibleTrigger class="raw-response-trigger">
                  <span>{{ t('testing.raw') }}</span><small>{{ t('testing.rawHelp') }}</small><b :class="{ open }">⌄</b>
                </CollapsibleTrigger>
                <CollapsibleContent class="raw-response-content">
                  <div class="raw-response-body">
                    <Button variant="outline" size="sm" type="button" @click="copy(JSON.stringify(result.response, null, 2))">{{ t('testing.copyJson') }}</Button>
                    <pre>{{ JSON.stringify(result.response, null, 2) }}</pre>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </article>
          </div>
        </div>

        <div v-else-if="activeTab === 'deploy'" class="deploy-layout">
          <div class="deploy-summary">
            <span class="overline">{{ t('deployment.overline') }}</span><h2>{{ selected.deployedVersion ? t('deployment.live', { version: selected.deployedVersion }) : t('deployment.empty') }}</h2>
            <p>{{ t('deployment.description') }}</p>
            <button type="button" :disabled="!canDeploy" @click="deploy">{{ hasSavedDeploymentChanges && !hasUnsavedChanges && !deploying ? t('deployment.deployCurrent') : deployLabel }} <span>↗</span></button>
          </div>
          <div class="version-list">
            <div class="section-title"><span>{{ t('deployment.history') }}</span><div><h2>{{ t('deployment.versions') }}</h2><p>{{ t('deployment.versionsHelp') }}</p></div></div>
            <article v-for="version in [...(selected.deployments || [])].reverse()" :key="version.version" :class="{ active: version.version === selected.deployedVersion }">
              <span class="version-number">v{{ version.version }}</span>
              <div><b>{{ version.name }}</b><small>{{ t('deployment.versionMeta', { count: Object.keys(version.questions).length, date: formatDate(version.deployedAt) }) }}</small></div>
              <span v-if="version.version === selected.deployedVersion" class="live-badge"><i></i> {{ t('common.live') }}</span>
              <button v-else type="button" @click="activateVersion(version.version)">{{ t('deployment.activate') }}</button>
            </article>
            <div v-if="!selected.deployments?.length" class="no-versions">{{ t('deployment.none') }}</div>
          </div>
        </div>

        <div v-else class="api-layout">
          <div class="api-intro">
            <span class="overline">{{ t('api.overline') }}</span>
            <h2>{{ t('api.title') }}<br>{{ t('api.titleEm') }}</h2>
            <p>{{ t('api.description') }}</p>
          </div>
          <div class="api-examples">
            <section class="api-example">
              <div class="api-example-title">
                <span>01</span>
                <div><h3>{{ t('api.studio') }}</h3><p>{{ t('api.studioHelp') }}</p></div>
              </div>
              <div class="code-card">
                <div><span>cURL</span><button class="copy-action" type="button" @click="copy(platformCurl)"><Copy aria-hidden="true" /> {{ t('api.copyRequest') }}</button></div>
                <pre><i>curl</i> -X POST {{ platformOrigin }}/api/classify \
  -H <em>'Authorization: Bearer YOUR_PROJECT_KEY'</em> \
  -H <em>'Content-Type: application/json'</em> \
  -d <em>'{{ endpointExample }}'</em></pre>
              </div>
            </section>
            <section class="api-example">
              <div class="api-example-title">
                <span>02</span>
                <div><h3>{{ t('api.direct') }}</h3><p>{{ t('api.directHelp', { version: selected.deployedVersion || '—' }) }}</p></div>
              </div>
              <div class="code-card direct-jev-card" :class="{ disabled: !deployedSnapshot }">
                <div>
                  <span>POST /v1/systemone</span>
                  <span class="code-actions">
                    <button class="copy-action" type="button" :disabled="!deployedSnapshot" @click="copy(directJevPayload)"><Copy aria-hidden="true" /> {{ t('api.copyInput') }}</button>
                    <button class="copy-action" type="button" :disabled="!deployedSnapshot" @click="copy(directJevCurl)"><Copy aria-hidden="true" /> {{ t('api.copyCurl') }}</button>
                  </span>
                </div>
                <pre v-if="deployedSnapshot"><i>curl</i> -X POST https://api.typesafe.ai/v1/systemone \
  -H <em>'Authorization: Bearer YOUR_TYPESAFE_API_KEY'</em> \
  -H <em>'Content-Type: application/json'</em> \
  -d <em>'{{ directJevPayload }}'</em></pre>
                <div v-else class="undeployed-export">{{ t('api.deployToExport') }}</div>
              </div>
            </section>
          </div>
          <div class="api-note"><span>→</span><p><b>{{ t('api.activeSnapshot') }}</b> {{ deployedSnapshot ? t('api.snapshot', { version: deployedSnapshot.version, date: formatDate(deployedSnapshot.deployedAt) }) : t('api.deployBefore') }}</p></div>
        </div>
      </section>

      <section v-else-if="currentView === 'archive'" class="archive-view">
        <div class="archive-hero"><span class="overline">{{ t('archive.overline') }}</span><h1>{{ t('archive.title') }}</h1><p>{{ t('archive.description') }}</p></div>
        <div v-if="archiveLoading" class="archive-empty">{{ t('analytics.calculating') }}</div>
        <div v-else-if="!archivedClassifiers.length" class="archive-empty"><Archive aria-hidden="true" /><h2>{{ t('archive.empty') }}</h2></div>
        <div v-else class="archive-list">
          <article v-for="classifier in archivedClassifiers" :key="classifier.id">
            <span class="nav-icon">{{ classifier.name.slice(0, 1).toUpperCase() }}</span>
            <div><h2>{{ classifier.name }}</h2><p>{{ classifier.description || t('classifier.noDescription') }}</p><small>{{ t('archive.archivedOn', { date: formatDate(classifier.archivedAt) }) }}</small></div>
            <div class="archive-actions"><Button variant="outline" type="button" @click="restoreClassifier(classifier)"><ArchiveRestore aria-hidden="true" /> {{ t('archive.restore') }}</Button><Button variant="ghost" type="button" @click="deleteClassifier(classifier)"><Trash2 aria-hidden="true" /> {{ t('archive.delete') }}</Button></div>
          </article>
        </div>
      </section>

      <section v-else-if="currentView === 'keys'" class="keys-view">
        <div class="keys-hero"><span class="overline">{{ t('keys.overline') }}</span><h1>{{ t('keys.title') }}</h1><p>{{ t('keys.description') }}</p></div>
        <div class="key-card">
          <div class="key-card-head"><div class="key-symbol"><KeyRound aria-hidden="true" /></div><div><h2>{{ keyStatus.active ? t('keys.production') : t('keys.none') }}</h2><p>{{ keyStatus.active ? t('keys.created', { date: formatDate(keyStatus.createdAt) }) : t('keys.generateHelp') }}</p></div><span v-if="keyStatus.active" class="active-key"><CheckCircle2 aria-hidden="true" /> {{ t('common.active') }}</span></div>
          <div v-if="revealedKey" class="revealed-key"><span>{{ t('keys.shownNow') }}</span><div><code>{{ revealedKey }}</code><button @click="copy(revealedKey)"><Copy aria-hidden="true" /> {{ t('common.copy') }}</button></div></div>
          <div v-else-if="keyStatus.active" class="masked-key"><code>{{ keyStatus.prefix }}••••••••••••••••••••••</code><span>{{ t('keys.hashed') }}</span></div>
          <div class="key-actions"><button class="primary" type="button" @click="rotateKey"><RefreshCw aria-hidden="true" /> {{ keyStatus.active ? t('keys.rotate') : t('keys.generate') }} <span>→</span></button><button v-if="keyStatus.active" type="button" @click="revokeKey">{{ t('keys.revoke') }}</button></div>
        </div>
        <div class="security-grid"><article><span><Eye aria-hidden="true" /></span><h3>{{ t('keys.shownOnce') }}</h3><p>{{ t('keys.shownOnceHelp') }}</p></article><article><span><Fingerprint aria-hidden="true" /></span><h3>{{ t('keys.hashedAtRest') }}</h3><p>{{ t('keys.hashedAtRestHelp') }}</p></article><article><span><RefreshCw aria-hidden="true" /></span><h3>{{ t('keys.instantRotation') }}</h3><p>{{ t('keys.instantRotationHelp') }}</p></article></div>
      </section>

      <section v-else class="analytics-view">
        <div v-if="auth.user.isPlatformAdmin" class="analytics-scope">
          <button type="button" :class="{ active: analyticsScope === 'workspace' }" @click="analyticsScope = 'workspace'">{{ t('analytics.mine') }}</button>
          <button type="button" :class="{ active: analyticsScope === 'platform' }" @click="analyticsScope = 'platform'">{{ t('analytics.platform') }}</button>
          <span>{{ t('analytics.admin') }}</span>
        </div>
        <div class="analytics-hero">
          <div><span class="overline">{{ t('analytics.last30', { scope: analyticsScope === 'platform' ? t('analytics.platform') : t('analytics.mine') }) }}</span><h1>{{ analyticsScope === 'platform' ? t('analytics.platformTitle') : t('analytics.workspaceTitle') }}</h1><p>{{ analyticsScope === 'platform' ? t('analytics.platformDescription') : t('analytics.workspaceDescription') }}</p></div>
          <div class="quota-card" v-if="analyticsScope === 'workspace' && auth.quota"><span>{{ t('analytics.monthlyQuota') }}</span><strong>{{ auth.quota.apiCalls.used.toLocaleString(locale) }} <small>/ {{ auth.quota.apiCalls.limit.toLocaleString(locale) }}</small></strong><i><b :style="{ width: `${Math.min(100, auth.quota.apiCalls.used / auth.quota.apiCalls.limit * 100)}%` }"></b></i><p>{{ t('analytics.resets', { date: formatDate(auth.quota.apiCalls.resetsAt) }) }}</p></div>
          <div class="quota-card platform-card" v-else-if="adminAnalytics"><span>{{ t('analytics.footprint') }}</span><strong>{{ adminAnalytics.summary.workspaces }} <small>{{ t('analytics.workspaces') }}</small></strong><p>{{ t('analytics.registeredUsers', { count: adminAnalytics.summary.users }, adminAnalytics.summary.users) }}</p></div>
        </div>
        <div v-if="analyticsLoading" class="analytics-loading">{{ t('analytics.calculating') }}</div>
        <template v-else-if="visibleAnalytics">
          <div v-if="analyticsScope === 'workspace'" class="kpi-grid">
            <article><span><Activity aria-hidden="true" /> {{ t('analytics.totalCalls') }}</span><strong>{{ analytics.summary.calls.toLocaleString(locale) }}</strong><small>{{ t('analytics.playgroundApi') }}</small></article>
            <article><span><CheckCircle2 aria-hidden="true" /> {{ t('analytics.successRate') }}</span><strong>{{ analytics.summary.calls ? Math.round(analytics.summary.successes / analytics.summary.calls * 100) : 0 }}%</strong><small>{{ t('analytics.failed', { count: analytics.summary.failures }) }}</small></article>
            <article><span><Clock3 aria-hidden="true" /> {{ t('analytics.medianLatency') }}</span><strong>{{ Math.round(analytics.summary.p50LatencyMs) }}<small> ms</small></strong><small>p95 {{ Math.round(analytics.summary.p95LatencyMs) }} ms</small></article>
            <article><span><Layers3 aria-hidden="true" /> {{ t('analytics.classifiers') }}</span><strong>{{ auth.quota.classifiers.used }}<small> / {{ auth.quota.classifiers.limit }}</small></strong><small>{{ t('analytics.activeFree') }}</small></article>
          </div>
          <div v-else class="kpi-grid">
            <article><span><Activity aria-hidden="true" /> {{ t('analytics.platformCalls') }}</span><strong>{{ adminAnalytics.summary.calls.toLocaleString(locale) }}</strong><small>{{ t('analytics.allSources') }}</small></article>
            <article><span><CheckCircle2 aria-hidden="true" /> {{ t('analytics.successRate') }}</span><strong>{{ adminAnalytics.summary.calls ? Math.round(adminAnalytics.summary.successes / adminAnalytics.summary.calls * 100) : 0 }}%</strong><small>{{ t('analytics.failed', { count: adminAnalytics.summary.failures }) }}</small></article>
            <article><span><Clock3 aria-hidden="true" /> {{ t('analytics.medianLatency') }}</span><strong>{{ Math.round(adminAnalytics.summary.p50LatencyMs) }}<small> ms</small></strong><small>p95 {{ Math.round(adminAnalytics.summary.p95LatencyMs) }} ms</small></article>
            <article><span><Users aria-hidden="true" /> {{ t('analytics.accounts') }}</span><strong>{{ adminAnalytics.summary.users }}</strong><small>{{ adminAnalytics.summary.workspaces }} {{ t('analytics.workspaces') }}</small></article>
          </div>
          <div class="analytics-grid">
            <article class="usage-chart">
              <div class="analytics-title"><div><span><BarChart3 aria-hidden="true" /> {{ t('analytics.callsOverTime') }}</span><h2>{{ t('analytics.daily') }}</h2></div><small>{{ visibleAnalytics.range.from.slice(0, 10) }} → {{ visibleAnalytics.range.to.slice(0, 10) }}</small></div>
              <div v-if="visibleAnalytics.timeline.length" class="bar-chart">
                <div v-for="item in visibleAnalytics.timeline" :key="item.date"><span :style="{ height: `${Math.max(4, item.calls / maxTimelineCalls * 100)}%` }"><b>{{ item.calls }}</b></span><small>{{ new Date(item.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }}</small></div>
              </div>
              <div v-else class="analytics-empty">{{ t('analytics.timelineEmpty') }}</div>
            </article>
            <article v-if="analyticsScope === 'workspace'" class="classifier-usage">
              <div class="analytics-title"><div><span><Layers3 aria-hidden="true" /> {{ t('analytics.breakdown') }}</span><h2>{{ t('analytics.byClassifier') }}</h2></div></div>
              <div v-for="item in analytics.byClassifier" :key="item.classifierId" class="usage-row"><div><b>{{ item.name }}</b><small>{{ t('analytics.rowMeta', { successes: item.successes, latency: Math.round(item.averageLatencyMs) }) }}</small></div><strong>{{ item.calls }}</strong></div>
              <div v-if="!analytics.byClassifier.length" class="analytics-empty">{{ t('analytics.activityEmpty') }}</div>
            </article>
            <article v-else class="classifier-usage workspace-usage">
              <div class="analytics-title"><div><span><Users aria-hidden="true" /> {{ t('analytics.tenants') }}</span><h2>{{ t('analytics.byWorkspace') }}</h2></div><small>{{ t('analytics.totalLabel', { count: adminAnalytics.workspaces.length }) }}</small></div>
              <div v-for="item in adminAnalytics.workspaces" :key="item.workspaceId" class="usage-row"><div><b>{{ item.name }}</b><small>{{ t('analytics.workspaceMeta', { plan: item.plan, classifiers: item.classifiers, successes: item.successes }) }}</small></div><strong>{{ item.calls }}</strong></div>
              <div v-if="!adminAnalytics.workspaces.length" class="analytics-empty">{{ t('analytics.workspacesEmpty') }}</div>
            </article>
          </div>
        </template>
      </section>
    </main>

    <Transition name="toast"><div v-if="toast" class="toast">✓ {{ toast }}</div></Transition>
  </div>
</template>

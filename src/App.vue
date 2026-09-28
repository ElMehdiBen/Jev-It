<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { Activity, BarChart3, CheckCircle2, Clock3, Copy, KeyRound, Layers3, LogOut, Plus, Rocket, Send, Users } from '@lucide/vue'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const health = ref({ mongo: false, openai: false, typesafe: false, authConfigured: false, model: 'gpt-6-luna' })
const booting = ref(true)
const auth = ref({ authenticated: false, user: null, workspace: null, quota: null })
const classifiers = ref([])
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

const questionEntries = computed(() => Object.entries(classifierDraft.value?.questions || {}))
const draftEntries = computed(() => Object.entries(draft.value?.questions || {}))
const deployedSnapshot = computed(() => selected.value?.deployments?.find((item) => item.version === selected.value.deployedVersion))
const endpointExample = computed(() => JSON.stringify({ classifier_id: selected.value?.id || 'cls_your_classifier', state: 'The state you want JEV to evaluate' }, null, 2))
const directJevPayload = computed(() => JSON.stringify({
  state: 'The state you want JEV to evaluate',
  model: 'jev-latest',
  questions: deployedSnapshot.value?.questions || {},
}, null, 2))
const platformCurl = computed(() => `curl -X POST http://localhost:3001/api/classify \\
  -H 'Authorization: Bearer YOUR_PROJECT_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '${endpointExample.value}'`)
const directJevCurl = computed(() => `curl -X POST https://api.typesafe.ai/v1/systemone \\
  -H 'Authorization: Bearer YOUR_TYPESAFE_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '${directJevPayload.value}'`)
const visibleAnalytics = computed(() => analyticsScope.value === 'platform' ? adminAnalytics.value : analytics.value)
const maxTimelineCalls = computed(() => Math.max(1, ...(visibleAnalytics.value?.timeline || []).map((item) => item.calls)))
const pageTitle = computed(() => currentView.value === 'builder' ? 'Classifier builder' : currentView.value === 'keys' ? 'API keys' : currentView.value === 'analytics' ? 'Usage analytics' : selected.value?.name)

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  if (response.status === 204) return null
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Request failed.')
  return data
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
    session.value = await api('/api/builder/sessions', { method: 'POST' })
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
      body: JSON.stringify({ message }),
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
    notify('Classifier created')
    await openClassifier(classifier.id)
  } catch (error) { pageError.value = error.message }
  finally { creating.value = false }
}

async function openClassifier(classifierId) {
  pageError.value = ''
  currentView.value = 'classifier'
  activeTab.value = 'configure'
  try {
    selected.value = await api(`/api/classifiers/${classifierId}`)
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
  if (question.type === 'choice') question.criteria = { option_a: 'First outcome', option_b: 'Second outcome' }
  else if (question.type === 'score') question.criteria = ['Low', 'Medium', 'High']
  else delete question.criteria
}

function addQuestion() {
  let index = questionEntries.value.length + 1
  while (classifierDraft.value.questions[`question_${index}`]) index += 1
  classifierDraft.value.questions[`question_${index}`] = { type: 'noul', instructions: 'The state meets this condition.' }
}

function removeQuestion(key) {
  const next = { ...classifierDraft.value.questions }
  delete next[key]
  classifierDraft.value.questions = next
}

function addChoice(question) {
  let index = Object.keys(question.criteria || {}).length + 1
  while (question.criteria[`option_${index}`]) index += 1
  question.criteria[`option_${index}`] = 'Describe this outcome'
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
        questions: classifierDraft.value.questions,
      }),
    })
    classifierDraft.value = JSON.parse(JSON.stringify(selected.value))
    await loadClassifiers()
    notify('Draft saved')
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
  deploying.value = true
  try {
    await api(`/api/classifiers/${selected.value.id}/deploy`, { method: 'POST' })
    await openClassifier(selected.value.id)
    activeTab.value = 'deploy'
    notify('New version deployed')
  } catch (error) { pageError.value = error.message }
  finally { deploying.value = false }
}

async function activateVersion(version) {
  try {
    await api(`/api/classifiers/${selected.value.id}/activate/${version}`, { method: 'POST' })
    await openClassifier(selected.value.id)
    activeTab.value = 'deploy'
    notify(`Version ${version} is now active`)
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
  if (!window.confirm('Revoke the active API key? Existing integrations will stop working.')) return
  try {
    await api('/api/keys/current', { method: 'DELETE' })
    revealedKey.value = ''
    await loadKeyStatus()
    notify('API key revoked')
  } catch (error) { pageError.value = error.message }
}

async function copy(value) {
  await navigator.clipboard.writeText(value)
  notify('Copied to clipboard')
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—'
}

function answerValue(answer) {
  if (answer.type === 'choice') return answer.choice
  if (answer.type === 'score') return answer.score
  return `${Math.round(answer.noul * 100)}% true`
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
  <section v-if="booting" class="auth-screen auth-loading"><span class="brand-bars"><i></i><i></i><i></i></span><p>Opening Jev-It Studio…</p></section>

  <section v-else-if="!auth.authenticated" class="auth-screen">
    <div class="auth-brand"><span class="brand-bars"><i></i><i></i><i></i></span><span>Jev-It <b>Studio</b></span></div>
    <div class="auth-copy">
      <span class="overline">Your classifier workspace</span>
      <h1>Build decisions<br><em>through conversation.</em></h1>
      <p>Sign in to keep your classifiers, deployments, API keys, quotas, and usage analytics inside your own private workspace.</p>
      <Button v-if="health.mongo && health.authConfigured" as-child class="google-button">
        <a href="/api/auth/google"><span>G</span> Continue with Google <b>→</b></a>
      </Button>
      <div v-else class="auth-setup">
        <b>{{ !health.mongo ? 'MongoDB is not connected.' : 'Google SSO is not configured.' }}</b>
        <code v-if="!health.authConfigured">GOOGLE_CLIENT_ID=…<br>GOOGLE_CLIENT_SECRET=…</code>
        <Button type="button" @click="loadHealth().then(loadAuthSession)">Check configuration</Button>
      </div>
    </div>
    <div class="auth-foot"><span>5 classifiers on Free</span><span>1,000 monthly JEV calls</span><span>Private by workspace</span></div>
  </section>

  <div v-else class="studio-shell">
    <aside class="sidebar">
      <a class="studio-brand" href="#" @click.prevent="newBuilder">
        <span class="brand-bars"><i></i><i></i><i></i></span>
        <span>Jev-It <span>Studio</span></span>
      </a>

      <Button class="new-button" variant="outline" type="button" @click="newBuilder"><Plus aria-hidden="true" /> New classifier</Button>

      <nav class="classifier-nav">
        <p>Your classifiers <span>{{ classifiers.length }}</span></p>
        <button
          v-for="classifier in classifiers"
          :key="classifier.id"
          type="button"
          :class="{ active: selected?.id === classifier.id && currentView === 'classifier' }"
          @click="openClassifier(classifier.id)"
        >
          <span class="nav-icon">{{ classifier.name.slice(0, 1).toUpperCase() }}</span>
          <span><b>{{ classifier.name }}</b><small>{{ classifier.deployedVersion ? `Live · v${classifier.deployedVersion}` : 'Draft' }}</small></span>
          <i>›</i>
        </button>
        <div v-if="!classifiers.length" class="empty-nav">Your first classifier will appear here.</div>
      </nav>

      <div class="sidebar-bottom">
        <button type="button" :class="{ active: currentView === 'analytics' }" @click="openAnalytics">
          <BarChart3 aria-hidden="true" /> Usage analytics
        </button>
        <button type="button" :class="{ active: currentView === 'keys' }" @click="currentView = 'keys'; selected = null">
          <KeyRound aria-hidden="true" /> API keys <i :class="['tiny-dot', { on: keyStatus.active }]"></i>
        </button>
        <div class="quota-mini" v-if="auth.quota">
          <div><span>Free plan</span><b>{{ auth.quota.apiCalls.used }} / {{ auth.quota.apiCalls.limit }} calls</b></div>
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
              <TooltipTrigger as-child><Button variant="ghost" size="icon-xs" type="button" aria-label="Sign out" @click="logout"><LogOut aria-hidden="true" /></Button></TooltipTrigger>
              <TooltipContent side="right">Sign out</TooltipContent>
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
          <span class="crumb">Workspace /</span>
          <b>{{ pageTitle }}</b>
        </div>
        <div class="top-status"><i></i> {{ auth.workspace.name }}</div>
      </header>

      <div v-if="pageError" class="global-error"><span>!</span>{{ pageError }}<button @click="pageError = ''">×</button></div>

      <section v-if="currentView === 'builder'" class="builder-view">
        <div v-if="!health.mongo" class="setup-screen">
          <span class="setup-number">01</span>
          <h1>Connect MongoDB<br><em>to begin.</em></h1>
          <p>Jev-It Studio stores classifier drafts, conversations, deployments, and hashed API keys in MongoDB.</p>
          <code>MONGODB_URI=mongodb://127.0.0.1:27017</code>
          <button type="button" @click="loadHealth().then(newBuilder)">Check connection →</button>
        </div>

        <template v-else-if="session">
          <div class="chat-pane">
            <div class="pane-heading">
              <span class="overline">Build with Luna</span>
              <h1>Describe the decision.</h1>
              <p>Your assistant will turn the need into atomic, typed JEV questions.</p>
            </div>

            <div ref="chatLog" class="chat-log">
              <div v-for="(message, index) in session.messages" :key="index" class="message" :class="message.role">
                <span class="message-avatar">{{ message.role === 'assistant' ? 'J' : 'Y' }}</span>
                <div><small>{{ message.role === 'assistant' ? 'JEV Architect' : 'You' }}</small><p>{{ message.content }}</p></div>
              </div>
              <div v-if="sending" class="message assistant">
                <span class="message-avatar">J</span><div><small>JEV Architect</small><p class="thinking"><i></i><i></i><i></i></p></div>
              </div>
            </div>

            <form class="chat-composer" @submit.prevent="sendMessage">
              <Textarea v-model="chatInput" :disabled="sending || !health.openai" placeholder="Describe what the classifier should decide…" rows="2" @keydown.meta.enter.prevent="sendMessage" @keydown.ctrl.enter.prevent="sendMessage" />
              <div>
                <span>{{ health.openai ? `${health.model} · low reasoning` : 'Add OPENAI_API_KEY to .env' }}</span>
                <Button type="submit" :disabled="!chatInput.trim() || sending">{{ sending ? 'Thinking…' : 'Send' }} <Send aria-hidden="true" /></Button>
              </div>
            </form>
          </div>

          <aside class="live-draft">
            <div class="draft-header">
              <div><span class="live-pill"><i></i> Live draft</span><small>Updates as you chat</small></div>
              <Badge class="question-count" variant="outline">{{ draftEntries.length }} Q</Badge>
            </div>
            <div class="draft-identity">
              <span>Classifier name</span>
              <h2>{{ draft.name }}</h2>
              <p>{{ draft.description || 'The purpose will take shape as the conversation continues.' }}</p>
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
              <div v-if="!draftEntries.length" class="empty-draft"><span>◇</span><p>Your typed questions will appear here as the intent becomes clear.</p></div>
            </div>
            <div class="draft-footer">
              <p v-if="!draft.ready"><i></i> Keep chatting—the classifier still needs detail.</p>
              <p v-else class="ready"><i></i> Ready for your review.</p>
              <button type="button" :disabled="!draft.ready || creating" @click="createClassifier">{{ creating ? 'Creating…' : 'Create classifier' }} <span>→</span></button>
            </div>
          </aside>
        </template>
      </section>

      <section v-else-if="currentView === 'classifier' && classifierDraft" class="classifier-view">
        <div class="classifier-hero">
          <div>
            <span class="overline">{{ selected.deployedVersion ? `Production · v${selected.deployedVersion}` : 'Undeployed draft' }}</span>
            <h1>{{ selected.name }}</h1>
            <p>{{ selected.description || 'No description yet.' }}</p>
          </div>
          <Button class="deploy-button" type="button" :disabled="deploying" @click="deploy">{{ deploying ? 'Deploying…' : 'Deploy draft' }} <Rocket aria-hidden="true" /></Button>
        </div>

        <Tabs v-model="activeTab" class="classifier-tabs">
          <TabsList class="tabs">
            <TabsTrigger v-for="tab in ['configure', 'test', 'deploy', 'api']" :key="tab" :value="tab">{{ tab }}</TabsTrigger>
          </TabsList>
        </Tabs>

        <div v-if="activeTab === 'configure'" class="configure-layout">
          <div class="editor-main">
            <div class="form-section identity-editor">
              <div class="section-title"><span>01</span><div><h2>Identity</h2><p>The human-readable details for this classifier.</p></div></div>
              <label>Name<Input v-model="classifierDraft.name" /></label>
              <label>Description<Textarea v-model="classifierDraft.description" rows="3" /></label>
            </div>

            <div class="form-section">
              <div class="section-title"><span>02</span><div><h2>Questions</h2><p>Each question is evaluated independently against the same state.</p></div><button type="button" @click="addQuestion">＋ Add question</button></div>
              <article v-for="([key, question], index) in questionEntries" :key="key" class="question-editor">
                <div class="question-editor-head">
                  <span>{{ String(index + 1).padStart(2, '0') }}</span>
                  <Input class="key-input" :model-value="key" @change="updateQuestionKey(key, $event)" />
                  <select v-model="question.type" @change="changeQuestionType(question)"><option value="noul">Noul</option><option value="choice">Choice</option><option value="score">Score</option></select>
                  <button type="button" aria-label="Remove question" @click="removeQuestion(key)">×</button>
                </div>
                <label>Instructions<Textarea v-model="question.instructions" rows="2" /></label>
                <div v-if="question.type === 'choice'" class="criteria-editor">
                  <span>Choice options</span>
                  <div v-for="(description, optionKey) in question.criteria" :key="optionKey">
                    <Input :model-value="optionKey" @change="renameChoice(question, optionKey, $event.target.value)" />
                    <Input v-model="question.criteria[optionKey]" />
                    <button type="button" @click="delete question.criteria[optionKey]">×</button>
                  </div>
                  <button type="button" @click="addChoice(question)">＋ Add option</button>
                </div>
                <div v-if="question.type === 'score'" class="criteria-editor">
                  <span>Ordered score levels</span>
                  <div v-for="(_, levelIndex) in question.criteria" :key="levelIndex">
                    <b>{{ levelIndex }}</b><Input v-model="question.criteria[levelIndex]" /><button type="button" @click="question.criteria.splice(levelIndex, 1)">×</button>
                  </div>
                  <button type="button" @click="question.criteria.push('New level')">＋ Add level</button>
                </div>
              </article>
            </div>
          </div>
          <aside class="editor-aside">
            <div><span>Classifier ID</span><code>{{ selected.id }}</code><button @click="copy(selected.id)"><Copy aria-hidden="true" /> Copy</button></div>
            <div><span>Draft questions</span><strong>{{ questionEntries.length }}</strong></div>
            <div><span>Production</span><strong>{{ selected.deployedVersion ? `v${selected.deployedVersion}` : 'Not deployed' }}</strong></div>
            <button class="save-button" type="button" :disabled="saving" @click="saveClassifier">{{ saving ? 'Saving…' : 'Save draft' }} <span>→</span></button>
            <p>Saving does not affect production until you deploy.</p>
          </aside>
        </div>

        <div v-else-if="activeTab === 'test'" class="test-layout">
          <div class="test-input-panel">
            <span class="overline">Ephemeral test bench</span><h2>Try real states.</h2>
            <p>Test one state, or separate multiple examples with a line containing <code>---</code>. Nothing is saved.</p>
            <Textarea v-model="testInput" placeholder="Paste a state for this classifier to evaluate…\n\n---\n\nAdd another state…" />
            <Button type="button" :disabled="!testInput.trim() || testing" @click="runTests">{{ testing ? 'Running JEV…' : 'Run test' }} <span>→</span></Button>
          </div>
          <div class="test-results">
            <div v-if="!testResults.length" class="test-empty"><span>⌁</span><h3>No results yet</h3><p>Run the draft against real examples before deploying it.</p></div>
            <article v-for="(result, resultIndex) in testResults" :key="resultIndex" class="test-result">
              <div class="result-state"><span>State {{ resultIndex + 1 }}</span><p>{{ result.state }}</p></div>
              <div class="answer-list">
                <div v-for="(answer, key) in result.response.answers" :key="key">
                  <Badge class="question-type" :class="answer.type">{{ answer.type }}</Badge>
                  <b>{{ key.replaceAll('_', ' ') }}</b><strong>{{ answerValue(answer) }}</strong>
                  <small v-if="answer.confidence !== undefined">{{ Math.round(answer.confidence * 100) }}% confidence</small>
                </div>
              </div>
              <Collapsible v-slot="{ open }" class="raw-response">
                <CollapsibleTrigger class="raw-response-trigger">
                  <span>Raw JEV response</span><small>Complete, unmodified JSON</small><b :class="{ open }">⌄</b>
                </CollapsibleTrigger>
                <CollapsibleContent class="raw-response-content">
                  <div class="raw-response-body">
                    <Button variant="outline" size="sm" type="button" @click="copy(JSON.stringify(result.response, null, 2))">Copy JSON</Button>
                    <pre>{{ JSON.stringify(result.response, null, 2) }}</pre>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </article>
          </div>
        </div>

        <div v-else-if="activeTab === 'deploy'" class="deploy-layout">
          <div class="deploy-summary">
            <span class="overline">Production control</span><h2>{{ selected.deployedVersion ? `Version ${selected.deployedVersion} is live.` : 'Nothing deployed yet.' }}</h2>
            <p>Deployments are immutable snapshots. Editing your draft never changes the active production classifier.</p>
            <button type="button" :disabled="deploying" @click="deploy">{{ deploying ? 'Deploying…' : 'Deploy current draft' }} <span>↗</span></button>
          </div>
          <div class="version-list">
            <div class="section-title"><span>History</span><div><h2>Available versions</h2><p>Select any previous snapshot to roll production back.</p></div></div>
            <article v-for="version in [...(selected.deployments || [])].reverse()" :key="version.version" :class="{ active: version.version === selected.deployedVersion }">
              <span class="version-number">v{{ version.version }}</span>
              <div><b>{{ version.name }}</b><small>{{ Object.keys(version.questions).length }} questions · {{ formatDate(version.deployedAt) }}</small></div>
              <span v-if="version.version === selected.deployedVersion" class="live-badge"><i></i> Live</span>
              <button v-else type="button" @click="activateVersion(version.version)">Activate</button>
            </article>
            <div v-if="!selected.deployments?.length" class="no-versions">Your first deployment will appear here.</div>
          </div>
        </div>

        <div v-else class="api-layout">
          <div class="api-intro">
            <span class="overline">Production endpoint</span>
            <h2>One state in.<br>Typed answers out.</h2>
            <p>Use the managed endpoint, or export the complete deployed structure and call TypeSafe directly. Both examples use the active immutable snapshot.</p>
          </div>
          <div class="api-examples">
            <section class="api-example">
              <div class="api-example-title">
                <span>01</span>
                <div><h3>Through Jev-It Studio</h3><p>Send only the classifier ID and state. The backend resolves the active deployment.</p></div>
              </div>
              <div class="code-card">
                <div><span>cURL</span><button type="button" @click="copy(platformCurl)">Copy request</button></div>
                <pre><i>curl</i> -X POST http://localhost:3001/api/classify \
  -H <em>'Authorization: Bearer YOUR_PROJECT_KEY'</em> \
  -H <em>'Content-Type: application/json'</em> \
  -d <em>'{{ endpointExample }}'</em></pre>
              </div>
            </section>
            <section class="api-example">
              <div class="api-example-title">
                <span>02</span>
                <div><h3>Direct to TypeSafe</h3><p>A portable request containing the exact questions from deployed version {{ selected.deployedVersion || '—' }}.</p></div>
              </div>
              <div class="code-card direct-jev-card" :class="{ disabled: !deployedSnapshot }">
                <div>
                  <span>POST /v1/systemone</span>
                  <span class="code-actions">
                    <button type="button" :disabled="!deployedSnapshot" @click="copy(directJevPayload)">Copy input JSON</button>
                    <button type="button" :disabled="!deployedSnapshot" @click="copy(directJevCurl)">Copy cURL</button>
                  </span>
                </div>
                <pre v-if="deployedSnapshot"><i>curl</i> -X POST https://api.typesafe.ai/v1/systemone \
  -H <em>'Authorization: Bearer YOUR_TYPESAFE_API_KEY'</em> \
  -H <em>'Content-Type: application/json'</em> \
  -d <em>'{{ directJevPayload }}'</em></pre>
                <div v-else class="undeployed-export">Deploy the classifier to generate a portable JEV request.</div>
              </div>
            </section>
          </div>
          <div class="api-note"><span>→</span><p><b>Active snapshot:</b> {{ deployedSnapshot ? `Version ${deployedSnapshot.version}, deployed ${formatDate(deployedSnapshot.deployedAt)}` : 'Deploy this classifier before calling the endpoint.' }}</p></div>
        </div>
      </section>

      <section v-else-if="currentView === 'keys'" class="keys-view">
        <div class="keys-hero"><span class="overline">Project access</span><h1>API keys</h1><p>Keys authenticate calls to your deployed classifiers. JEV and OpenAI credentials always remain server-side.</p></div>
        <div class="key-card">
          <div class="key-card-head"><div class="key-symbol">⌁</div><div><h2>{{ keyStatus.active ? 'Production key' : 'No active key' }}</h2><p>{{ keyStatus.active ? `Created ${formatDate(keyStatus.createdAt)}` : 'Generate a key to call /api/classify.' }}</p></div><span v-if="keyStatus.active" class="active-key"><i></i> Active</span></div>
          <div v-if="revealedKey" class="revealed-key"><span>Copy this key now—it won’t be shown again.</span><div><code>{{ revealedKey }}</code><button @click="copy(revealedKey)">Copy</button></div></div>
          <div v-else-if="keyStatus.active" class="masked-key"><code>{{ keyStatus.prefix }}••••••••••••••••••••••</code><span>Stored as a SHA-256 hash</span></div>
          <div class="key-actions"><button class="primary" type="button" @click="rotateKey">{{ keyStatus.active ? 'Rotate key' : 'Generate key' }} <span>→</span></button><button v-if="keyStatus.active" type="button" @click="revokeKey">Revoke</button></div>
        </div>
        <div class="security-grid"><article><span>01</span><h3>Shown once</h3><p>The plaintext secret is returned only when it is generated.</p></article><article><span>02</span><h3>Hashed at rest</h3><p>MongoDB stores a one-way SHA-256 digest, never the original key.</p></article><article><span>03</span><h3>Instant rotation</h3><p>Rotating revokes the old key before creating the replacement.</p></article></div>
      </section>

      <section v-else class="analytics-view">
        <div v-if="auth.user.isPlatformAdmin" class="analytics-scope">
          <button type="button" :class="{ active: analyticsScope === 'workspace' }" @click="analyticsScope = 'workspace'">My workspace</button>
          <button type="button" :class="{ active: analyticsScope === 'platform' }" @click="analyticsScope = 'platform'">Jev-It platform</button>
          <span>Admin view</span>
        </div>
        <div class="analytics-hero">
          <div><span class="overline">Last 30 days · {{ analyticsScope }}</span><h1>{{ analyticsScope === 'platform' ? 'The whole platform.' : 'Usage, at a glance.' }}</h1><p>{{ analyticsScope === 'platform' ? 'Aggregate activity across every Jev-It workspace and classifier.' : 'Every playground and production call, without storing states or model responses.' }}</p></div>
          <div class="quota-card" v-if="analyticsScope === 'workspace' && auth.quota"><span>Monthly quota</span><strong>{{ auth.quota.apiCalls.used.toLocaleString() }} <small>/ {{ auth.quota.apiCalls.limit.toLocaleString() }}</small></strong><i><b :style="{ width: `${Math.min(100, auth.quota.apiCalls.used / auth.quota.apiCalls.limit * 100)}%` }"></b></i><p>Resets {{ formatDate(auth.quota.apiCalls.resetsAt) }}</p></div>
          <div class="quota-card platform-card" v-else-if="adminAnalytics"><span>Platform footprint</span><strong>{{ adminAnalytics.summary.workspaces }} <small>workspaces</small></strong><p>{{ adminAnalytics.summary.users }} registered {{ adminAnalytics.summary.users === 1 ? 'user' : 'users' }}</p></div>
        </div>
        <div v-if="analyticsLoading" class="analytics-loading">Calculating usage…</div>
        <template v-else-if="visibleAnalytics">
          <div v-if="analyticsScope === 'workspace'" class="kpi-grid">
            <article><span><Activity aria-hidden="true" /> Total calls</span><strong>{{ analytics.summary.calls.toLocaleString() }}</strong><small>Playground + API</small></article>
            <article><span><CheckCircle2 aria-hidden="true" /> Success rate</span><strong>{{ analytics.summary.calls ? Math.round(analytics.summary.successes / analytics.summary.calls * 100) : 0 }}%</strong><small>{{ analytics.summary.failures }} failed</small></article>
            <article><span><Clock3 aria-hidden="true" /> Median latency</span><strong>{{ Math.round(analytics.summary.p50LatencyMs) }}<small> ms</small></strong><small>p95 {{ Math.round(analytics.summary.p95LatencyMs) }} ms</small></article>
            <article><span><Layers3 aria-hidden="true" /> Classifiers</span><strong>{{ auth.quota.classifiers.used }}<small> / {{ auth.quota.classifiers.limit }}</small></strong><small>Active on Free</small></article>
          </div>
          <div v-else class="kpi-grid">
            <article><span><Activity aria-hidden="true" /> Platform calls</span><strong>{{ adminAnalytics.summary.calls.toLocaleString() }}</strong><small>All sources</small></article>
            <article><span><CheckCircle2 aria-hidden="true" /> Success rate</span><strong>{{ adminAnalytics.summary.calls ? Math.round(adminAnalytics.summary.successes / adminAnalytics.summary.calls * 100) : 0 }}%</strong><small>{{ adminAnalytics.summary.failures }} failed</small></article>
            <article><span><Clock3 aria-hidden="true" /> Median latency</span><strong>{{ Math.round(adminAnalytics.summary.p50LatencyMs) }}<small> ms</small></strong><small>p95 {{ Math.round(adminAnalytics.summary.p95LatencyMs) }} ms</small></article>
            <article><span><Users aria-hidden="true" /> Accounts</span><strong>{{ adminAnalytics.summary.users }}</strong><small>{{ adminAnalytics.summary.workspaces }} workspaces</small></article>
          </div>
          <div class="analytics-grid">
            <article class="usage-chart">
              <div class="analytics-title"><div><span><BarChart3 aria-hidden="true" /> Calls over time</span><h2>Daily activity</h2></div><small>{{ visibleAnalytics.range.from.slice(0, 10) }} → {{ visibleAnalytics.range.to.slice(0, 10) }}</small></div>
              <div v-if="visibleAnalytics.timeline.length" class="bar-chart">
                <div v-for="item in visibleAnalytics.timeline" :key="item.date"><span :style="{ height: `${Math.max(4, item.calls / maxTimelineCalls * 100)}%` }"><b>{{ item.calls }}</b></span><small>{{ new Date(item.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }}</small></div>
              </div>
              <div v-else class="analytics-empty">Calls will appear here as you test and use deployed classifiers.</div>
            </article>
            <article v-if="analyticsScope === 'workspace'" class="classifier-usage">
              <div class="analytics-title"><div><span><Layers3 aria-hidden="true" /> Breakdown</span><h2>By classifier</h2></div></div>
              <div v-for="item in analytics.byClassifier" :key="item.classifierId" class="usage-row"><div><b>{{ item.name }}</b><small>{{ item.successes }} successful · {{ Math.round(item.averageLatencyMs) }} ms avg</small></div><strong>{{ item.calls }}</strong></div>
              <div v-if="!analytics.byClassifier.length" class="analytics-empty">No classifier activity yet.</div>
            </article>
            <article v-else class="classifier-usage workspace-usage">
              <div class="analytics-title"><div><span><Users aria-hidden="true" /> Tenants</span><h2>By workspace</h2></div><small>{{ adminAnalytics.workspaces.length }} total</small></div>
              <div v-for="item in adminAnalytics.workspaces" :key="item.workspaceId" class="usage-row"><div><b>{{ item.name }}</b><small>{{ item.plan }} · {{ item.classifiers }} classifiers · {{ item.successes }} successful</small></div><strong>{{ item.calls }}</strong></div>
              <div v-if="!adminAnalytics.workspaces.length" class="analytics-empty">No workspaces yet.</div>
            </article>
          </div>
        </template>
      </section>
    </main>

    <Transition name="toast"><div v-if="toast" class="toast">✓ {{ toast }}</div></Transition>
  </div>
</template>

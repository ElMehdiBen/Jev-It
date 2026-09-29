# Jev-It

**Jev-It Studio — build classifiers at the speed of conversation.**

Jev-It turns a conversation about a decision you need to make into a reusable TypeSafe AI JEV classifier. Describe the outcome you want, review the generated typed questions, test them against real examples, then deploy an immutable version behind a workspace API key—or copy the exact request and call JEV directly.

## Product tour

### Build by conversation

The AI builder works alongside the structured draft, so every generated Choice, Score, or Noul question remains visible and editable before the classifier is created.

![Jev-It Studio conversational classifier builder with a structured draft](docs/screenshots/studio-builder.png)

### Integrate your way

Each deployment includes ready-to-copy requests for the managed Jev-It endpoint and the direct TypeSafe API, including the exact deployed input JSON.

![Jev-It Studio API integration page with managed and direct request examples](docs/screenshots/api-integration.png)

### Understand usage

Workspace analytics show quota consumption, success rate, latency, daily activity, and usage by classifier without retaining states or model responses.

![Jev-It Studio workspace usage analytics dashboard](docs/screenshots/usage-analytics.png)

## How it works

1. Describe the classification decision in a conversation.
2. Review and edit the generated JEV questions and answer types.
3. Test one state or a batch without saving the test inputs or responses.
4. Deploy a content-idempotent, immutable snapshot and roll back when needed.
5. Call the active version through Jev-It or copy its payload for direct JEV use.

## What it does

- Uses GPT-6 Luna as a conversational classifier architect.
- Produces JEV-native Choice, Score, and Noul questions.
- Keeps a live structured draft beside the builder conversation.
- Allows full manual editing after creation.
- Runs ephemeral single-state or batch tests against JEV.
- Deploys immutable versions and allows instant rollback to any previous version.
- Archives classifiers without losing deployments or analytics, restores them when quota is available, and permits permanent deletion only from the archive.
- Exposes a protected `/api/classify` endpoint that resolves the active deployment.
- Exports the exact deployed request structure for direct TypeSafe/JEV API calls.
- Builds copy-ready managed API examples from the current deployment URL rather than a hard-coded localhost address.
- Shows both readable classifier answers and the complete raw JEV response.
- Generates rotatable `jv_live_...` project keys and stores only SHA-256 hashes.
- Authenticates users with Google SSO and isolates every resource by workspace.
- Enforces Free plan classifier and monthly JEV-call quotas.
- Tracks privacy-conscious usage analytics without storing input states or model responses.
- Localizes the Studio in English and French and persists the chosen locale.
- Gives each classifier an explicit English, French, or automatic/multilingual language policy that is preserved in every deployment.

## Technology

- Vue 3, Vite, Tailwind CSS, and shadcn-vue for the Studio interface.
- Node.js and Express for authentication, classifier management, and API orchestration.
- MongoDB for workspace-scoped classifiers, deployments, sessions, keys, and usage aggregates.
- OpenAI for the conversational builder and TypeSafe AI JEV for classifier execution.

## Setup

Requirements: Node.js 22+ and MongoDB.

```bash
npm install
cp .env.example .env
```

Configure `.env`:

```env
OPENAI_API_KEY=sk_...
OPENAI_MODEL=gpt-6-luna

TYPESAFE_API_KEY=...
TYPESAFE_MODEL=jev-latest

GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3001/api/auth/google/callback
PLATFORM_ADMIN_EMAILS=you@example.com

MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=jev_studio
PORT=3001
```

Create a Google OAuth **Web application** client and register the exact redirect URI shown above. Jev-It requests only `openid`, `email`, and `profile`; it stores its own hashed, expiring browser sessions and does not retain Google access or refresh tokens.

On first sign-in, Jev-It creates a personal Free workspace. Existing unowned data from an earlier single-user installation is claimed by the first workspace so local classifiers are preserved.

## Free plan

- 5 active classifiers per workspace.
- 1,000 JEV executions per UTC calendar month.
- Playground tests and production API calls both count toward usage.
- Validated requests reserve quota before contacting JEV; requests rejected before that point do not consume quota.
- Raw API-call analytics are retained for 90 days, while daily aggregates are retained indefinitely.

## Classifier lifecycle and language

Archiving a classifier immediately disables its production endpoint and releases its active-classifier quota slot. Its immutable deployment history and usage analytics remain available. Restoring it reclaims a slot and resumes its previously active deployment; if the workspace is at its plan limit, another classifier must be archived first. Permanent deletion is deliberately available only from the archive. Historical aggregate analytics are retained and identify the removed classifier as deleted.

The Studio interface supports English and French. The locale selector changes interface copy and date formatting, and the choice is saved in the browser. Classifier language is separate from interface language:

- **English or French** keeps builder responses and all human-readable classifier content in that language. During execution, JEV receives an explicit instruction to interpret the state in that language.
- **Automatic / multilingual** follows the language used in the builder conversation and does not force an execution language, making it suitable for mixed-language inputs.

Machine-readable question and option keys remain ASCII `snake_case` in every mode so integrations are stable across languages. Because language is part of an immutable deployment snapshot, changing it requires deploying the saved draft before production behavior changes.

## Docker development (recommended)

The development stack runs the Vue frontend, Express API, and MongoDB with persistent data and hot reload:

```bash
npm run docker:dev
```

Open `http://localhost:5173`. Source files are bind-mounted into the app container. Vite uses polling so updates are detected reliably across Linux, macOS, and Docker Desktop. Express uses Node's watch mode and reloads when `server.js` changes.

Useful commands:

```bash
npm run docker:logs
npm run docker:down
```

MongoDB data and container dependencies are stored in named volumes. `docker:down` preserves them; use `docker compose -f compose.dev.yml down -v` only when you intentionally want to erase local development data.

The Compose stack uses `DEV_DNS` as its external resolver because some Linux installations expose only the `systemd-resolved` loopback stub to Docker. If your network changes and external APIs stop resolving, run `resolvectl dns` and update `DEV_DNS` in `.env` to the active network DNS address.

## Host development

If MongoDB is already installed on your machine, run:

```bash
npm run dev
```

Open `http://localhost:5173`.

## Calling a deployed classifier

Generate a project key from **API keys**, deploy a classifier, then call:

```bash
curl -X POST http://127.0.0.1:3001/api/classify \
  -H "Authorization: Bearer jv_live_your_project_key" \
  -H "Content-Type: application/json" \
  -d '{
    "classifier_id": "cls_your_classifier_id",
    "state": "The state to evaluate"
  }'
```

The endpoint returns the complete raw TypeSafe/JEV response. Draft edits do not affect this endpoint until a new version is explicitly deployed.

The API page in Jev-It Studio renders this request with the browser's current origin, so a production installation automatically shows its public HTTPS URL. If the application is served below a URL path prefix, make sure the reverse proxy preserves that prefix or adjust the copied endpoint accordingly.

Deployments are content-idempotent. Deploying an unchanged saved draft reuses its existing immutable version, including under concurrent requests. To audit older databases and remove exact duplicate snapshots while preserving the active version, run a dry check before applying the cleanup:

```bash
npm run db:dedupe-deployments -- --dry-run
npm run db:dedupe-deployments -- --apply
```

## Production

```bash
cp .env.production.example .env.production
# Fill in the production domain, independent MongoDB passwords, and provider credentials.
docker compose --env-file .env.production -f compose.prod.yml up -d --build
```

The production stack builds the Vue application and API into one minimal non-root Node image on a configurable upstream port, ready for Nginx Proxy Manager or another external reverse proxy. Authenticated MongoDB remains on a private Docker network with no published database port. An optional bundled Caddy profile is also available. See the complete [production deployment guide](docs/DEPLOYMENT.md) for DNS, proxy configuration, Google OAuth, secrets, backups, updates, and firewall rules.

## Contributing

Contributions are welcome. `main` is protected, so all changes must be proposed through a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review workflow.

## License

Jev-It is available under the [MIT License](LICENSE).

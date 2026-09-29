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
- Exposes a protected `/api/classify` endpoint that resolves the active deployment.
- Exports the exact deployed request structure for direct TypeSafe/JEV API calls.
- Shows both readable classifier answers and the complete raw JEV response.
- Generates rotatable `jv_live_...` project keys and stores only SHA-256 hashes.
- Authenticates users with Google SSO and isolates every resource by workspace.
- Enforces Free plan classifier and monthly JEV-call quotas.
- Tracks privacy-conscious usage analytics without storing input states or model responses.

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

Deployments are content-idempotent. Deploying an unchanged saved draft reuses its existing immutable version, including under concurrent requests. To audit older databases and remove exact duplicate snapshots while preserving the active version, run a dry check before applying the cleanup:

```bash
npm run db:dedupe-deployments -- --dry-run
npm run db:dedupe-deployments -- --apply
```

## Production

```bash
npm run build
npm start
```

Express serves the compiled Vue application and all API routes on port `3001` by default.

## Contributing

Contributions are welcome. `main` is protected, so all changes must be proposed through a pull request. See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review workflow.

## License

Jev-It is available under the [MIT License](LICENSE).

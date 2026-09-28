# Jev-It

**Jev-It Studio for building classifiers at the speed of conversation.**

Jev-It is a single-user workspace for building, testing, versioning, and deploying reusable TypeSafe AI JEV classifiers.

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

MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DATABASE=jev_studio
PORT=3001
```

## Docker development (recommended)

The development stack runs the Vue frontend, Express API, and MongoDB with persistent data and hot reload:

```bash
npm run docker:dev
```

Open `http://127.0.0.1:5173`. Source files are bind-mounted into the app container. Vite uses polling so updates are detected reliably across Linux, macOS, and Docker Desktop. Express uses Node's watch mode and reloads when `server.js` changes.

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

Open `http://127.0.0.1:5173`.

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

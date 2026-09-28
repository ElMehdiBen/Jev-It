# Contributing to Jev-It

Thanks for helping improve Jev-It.

## Development workflow

1. Fork the repository and create a branch from `main`.
2. Copy `.env.example` to `.env` and add your own credentials. Never commit secrets.
3. Start the hot-reloading development stack with `npm run docker:dev`.
4. Make a focused change and verify it with `npm run build`.
5. Open a pull request against `main` describing the change and how it was tested.

Direct pushes to `main` are disabled. Every contribution, including maintainer changes after the initial import, should go through a pull request.

## Code expectations

- Keep API credentials server-side and out of browser bundles and logs.
- Preserve deployed classifier snapshots as immutable versions.
- Keep tests ephemeral unless a feature explicitly introduces persisted test data.
- Include clear setup or migration notes when configuration changes.

By contributing, you agree that your contributions will be licensed under the MIT License.

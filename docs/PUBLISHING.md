# Publishing

The public source repository is https://github.com/lucamattiazzi/public-queue.
The source workspace is private to prevent accidental publication of the repository root.
Publish only built distribution packages, never the workspace root.

## Prepare SDK and agent

Use Node.js 24+ and the pinned pnpm version from `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm exec tsx --test tests/agent-config.test.ts tests/agent-cli-gui.test.ts
pnpm smoke:packages
(cd dist/packages/sdk && npm publish --access public --dry-run)
(cd dist/packages/agent && npm publish --access public --dry-run)
```

The smoke check installs the archives into an isolated consumer, verifies SDK imports
and TypeScript declarations, and runs the agent CLI and packaged native helper on macOS.
The server is distributed as source with Docker deployment instructions.

## Publish to npm

The packages are `@lucamattiazzi/public-queue-sdk` and
`@lucamattiazzi/public-queue-agent`. Publication requires the `lucamattiazzi`
npm account or an explicitly authorized maintainer.

```sh
npm login
npm whoami
(cd dist/packages/sdk && npm publish --access public)
(cd dist/packages/agent && npm publish --access public)
npm view @lucamattiazzi/public-queue-sdk version
npm view @lucamattiazzi/public-queue-agent version
```

Complete npm's authentication/2FA prompts locally; never store credentials in the
repository. A published version cannot be reused. Update the version in
`scripts/build.mjs` before subsequent releases.

## GitHub release

Attach the tested `dist/tarballs/lucamattiazzi-public-queue-agent-0.1.1.tgz` and
`dist/tarballs/lucamattiazzi-public-queue-sdk-0.1.1.tgz` to the matching GitHub version tag.
GitHub archive availability does not mean the packages are published on npm.
The macOS helper is universal Intel/Apple Silicon and ad-hoc signed, not notarized.

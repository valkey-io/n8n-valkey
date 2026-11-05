# Contributing to Valkey Vector Store for n8n

Thank you for contributing. This repository contains an n8n community node that uses Valkey as a vector store. Contributions are welcome from everyone.

## Scope

See the [README](README.md) for this repository's audience and purpose. Contributions that fall outside that scope will be redirected during review.

## Getting started

1. **Open an issue first** for new features or behavior changes, and wait for a maintainer to approve it before starting implementation. This avoids wasted work on changes that don't fit the project. Bug fixes, documentation updates, and dependency updates can go straight to a pull request.
2. **Fork the repository** and create a branch from `main`.
3. **Set up a local environment.** You need a running Valkey instance with Valkey Search, for example:

   ```bash
   docker run -d --name valkey -p 6379:6379 valkey/valkey-bundle:9.1.4
   ```

   Install dependencies and build the node:

   ```bash
   npm install
   npm run build
   ```

   `npm install` runs the `prepare` script, which installs the Git hooks (see
   [Git hooks](#git-hooks)).

   Run the checks:

   ```bash
   npm run lint          # ESLint via the n8n node CLI
   npm run format:check  # Prettier
   npm run test:unit     # unit tests
   npm run test:int      # integration tests (needs the Valkey instance above)
   ```

   The integration tests connect to `localhost:6379` by default. Set
   `VALKEY_HOST` and `VALKEY_PORT` (and the other `VALKEY_*` variables) to use
   another server.

   To try the node in a local n8n instance, build it, then link it into n8n's
   custom nodes directory:

   ```bash
   npm run build
   npm link
   mkdir -p ~/.n8n/custom
   cd ~/.n8n/custom && npm link n8n-nodes-valkey-vector-store
   ```

   Restart n8n; the Valkey Vector Store node appears in the node panel.

4. **Make your change**, add or update tests, and sign off every commit (see [DCO](#developer-certificate-of-origin-dco)).
5. **Open a pull request** following the [pull request guidelines](#pull-request-guidelines).

## Git hooks

Git hooks are managed by [Husky](https://typicode.github.io/husky/) and installed
automatically when you run `npm install`:

- **`pre-commit`** runs `npm run lint`, `npm run format:check`, `npm run test:unit`,
  and `npm run test:int`. The integration tests need a running Valkey instance; set
  `VALKEY_HOST` / `VALKEY_PORT` to point at it, or skip the hook for a single commit
  with `git commit --no-verify`.
- **`commit-msg`** adds the DCO `Signed-off-by` trailer when it is missing, then
  checks the message against [Conventional Commits](https://www.conventionalcommits.org/)
  with commitlint.

## License

All contributions are made under the [BSD-3-Clause License](LICENSE). By submitting a pull request, you agree that your contributions will be licensed under the same terms.

## Developer Certificate of Origin (DCO)

All commits **must** include a `Signed-off-by` trailer certifying you have the right to submit the contribution. This is mandatory across all `valkey-io` repositories.

```
Signed-off-by: Your Name <your.email@example.com>
```

Use `git commit -s` (or `--signoff`) to add this automatically. The `commit-msg` hook
also adds it when it is missing. PRs that fail the DCO check will not be merged.

## Vendor neutrality

The default setup path must work with self-hosted Valkey with Valkey Search (`valkey/valkey-bundle`) and no cloud account. Managed services that provide Valkey Search are welcome as clearly labeled optional sections. Disclose any affiliation with a vendor whose product you document.

## Pull request guidelines

- One logical change per pull request.
- Link related issues (`Fixes #N` or `Relates to #N`).
- Rebase on `main` before requesting review.
- At least one maintainer approval is required before merge.

## Writing style

- **Be concise** — respect the reader's time
- **Show, don't tell** — working code over lengthy explanations
- **Use consistent terminology** -- "Valkey" (not "Redis"), "Valkey Search" (not "RediSearch")
- **Explain "why"** — briefly explain design choices, not just "what"
- **No vendor lock-in** — keep examples cloud-agnostic; if a cloud service is used, note alternatives
- **Cite quantitative claims** — if you state a performance number, link to the benchmark or methodology. Unsourced claims will be removed in review.

## Commit messages

Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<optional scope>): <description>
```

The allowed types are `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`,
`style`, and `chore`. For example:

```text
feat(credentials): add TLS option
fix(insert): handle empty metadata
docs: update installation section
```

Pull requests with non-conforming commit messages will fail CI.

Always sign off: `git commit -s`.


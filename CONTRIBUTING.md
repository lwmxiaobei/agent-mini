# Contributing to xbcode

Thanks for contributing to `xbcode`.

## Before You Start

Please open an issue before starting large changes so the direction can be aligned early. Small fixes and documentation improvements can usually go straight to a pull request.

## Development Setup

1. Use a recent Node.js version. Node.js 20 or newer is recommended.
2. Install dependencies:

```bash
npm install
```

3. Run the CLI locally:

```bash
npm run dev
```

4. Run the validation commands before opening a pull request:

```bash
npm run build
npm run test
```

## Project Scope

- Keep changes focused and minimal.
- Prefer readable implementations over clever abstractions.
- Do not add speculative features that are not required by the change.
- Preserve the terminal-first workflow and the small, hackable project shape.

## Pull Request Guidelines

- Write a clear title and explain the user-facing impact.
- Link the related issue when one exists.
- Keep pull requests small enough to review comfortably.
- Update documentation when behavior or commands change.
- Add or update tests when logic changes.

## Code Style

- Follow the existing TypeScript and ESM conventions used in the repository.
- Keep modules cohesive and avoid unnecessary coupling across features.
- Use descriptive names and straightforward control flow.
- If behavior is non-obvious, explain the intent in comments near the code.

## Reporting Bugs

When opening a bug report, include:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Your environment, including Node.js version and operating system
- Relevant logs, screenshots, or terminal output

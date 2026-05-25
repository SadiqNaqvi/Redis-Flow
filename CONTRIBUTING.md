# Contributing to Redis-Flow

Thank you for your interest in contributing ❤️

This project aims to make Redis easier and safer to work with using a fully TypeScript-first approach.

We welcome:contributions of all sizes:

- Bug fixes
- New features
- Performance improvements
- Documentation improvements
- Tests
- Examples

---
# Philosophy

This project prioritizes:

- Strict TypeScript typings
- Beginner-friendly APIs
- Predictable behavior
- Atomic operations
- Driver-agnostic compatibility
- Clean and maintainable abstractions

Please try to keep these principles in mind when contributing.
---

## Development Setup

### 1. Fork the repository

Click the "Fork" button on GitHub.

### 2. Clone your fork

```bash
git clone https://github.com/SadiqNaqvi/Redis-Flow.git
cd Redis-Flow
```

### 3. Install dependencies

```bash
npm install
```

### 4. Run the project

```bash
npm run dev
```

## Coding Standards

### Please follow these guidelines:

- Write clear, readable code
- Add comments where necessary
- Use meaningful variable names
- Keep functions small and focused
- Follow existing project style

### Prefer:

- generics
- inferred types
- reusable utility types
- explicit return types for public APIs

## Code Style

### Please write:

- small focused functions
- descriptive variable names
- readable logic
- comments only where necessary

Avoid overly complex abstractions unless clearly beneficial.

# Versioning

This project follows Semantic Versioning (SemVer):

MAJOR.MINOR.PATCH

Examples:
- 1.0.0 -> Initial stable release
- 1.1.0 -> New backward-compatible feature
- 1.1.1 -> Bug fix
- 2.0.0 -> Breaking API changes

Please consider backward compatibility when contributing changes.

## Backward Compatibility

Please avoid breaking existing APIs unless necessary.

If a change is breaking:

- explain why
- document migration steps
- discuss it in an issue first

## Testing

Before opening a PR:

```
npm test
```

Please add or update tests when:

- fixing bugs
- adding features
- changing behavior

## Pull Requests

### Before submitting

Make sure:

- tests pass
- linting passes
- documentation is updated if needed
- typings are correct
- examples still work

### Steps

1. Create a new branch
2. Make your changes
3. Commit changes
4. Push to your fork
5. Open a Pull Request

## PR Guidelines

Please:

- keep PRs focused
- avoid unrelated changes
- explain the reasoning behind changes
- include examples if introducing new APIs

Small PRs are preferred over massive rewrites.


## Commit Message Guidelines

### Use descriptive commit messages.

Recommended format:

```
fix: resolve memory leak in parser
feat: add caching support
docs: improve installation guide
refactor: simplify pipeline parser
```

## Reporting Issues

### When opening an issue, please include:

- Redis driver used
- Node.js version
- TypeScript version
- Steps to reproduce
- Expected behavior
- Actual behavior
- Screenshots/logs if applicable

## Feature Requests

Feature requests are welcome.

### Please explain:

- The problem you're solving
- Proposed solution
- Alternatives considered

## Beginner Contributions

Beginner-friendly contributions are welcome.

### Good first contributions include:

- improving docs
- adding examples
- fixing typos
- improving test coverage
- simplifying APIs

## Questions & Discussions

If you're unsure about something:

- open an issue
- start a discussion
- ask before implementing large changes

## License

By contributing, you agree that your contributions will be licensed under the project's license.
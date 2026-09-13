# Support

## Before reporting a problem

Run the local Doctor and the public-safe release check:

```text
npm run doctor
npm run doctor:release
```

Do not attach Chat transcripts, source files, cookies, tokens, Chat URLs, account identifiers, `.env` files, or the project-local `.codex/codex-bridge-chatgpt` directory.

## Useful information

Include the package version, operating system, Node.js version, Doctor status, stable error code, and the smallest reproducible sequence. State whether the failure occurred during setup, Chat binding, send, response recovery, adoption, execution, state migration, or packaging.

Security reports should follow [SECURITY.md](SECURITY.md). General defects can be reported through the repository issue tracker after removing private project information.

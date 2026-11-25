# Contributing

Thanks for wanting to help. agent-bar is a small personal project, so a few simple rules:

- **Open an issue first** for anything bigger than a typo, so we agree on it before you spend time.
- **Bug reports:** include your macOS version, the agent and how it was started (terminal, VS Code, Claude app), and what you expected. The output of `npm run dump` (run from source) helps a lot — it prints what the widget sees. Remove project names and paths you don't want to share.
- **Adding an agent:** write `src/readers/<agent>.js` that returns sessions in the common format and add it to `READERS` in `src/sessions.js`. The format and how the existing readers work are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- agent-bar must stay read-only towards agents: no hooks, no changes to their configs, no network.

## Run from source

```bash
npm install
npm start
```

Issues and pull requests in English or Russian are both fine.

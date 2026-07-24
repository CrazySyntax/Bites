# Bites

TypeScript + Express boilerplate.

## Getting started

```bash
npm install
npm run dev
```

The server starts on `http://localhost:3000` (override with the `PORT` env var).

## Scripts

- `npm run dev` — run in watch mode with nodemon + ts-node
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run the compiled output from `dist/`

## Endpoints

- `GET /health` — returns `{ "status": "ok" }`

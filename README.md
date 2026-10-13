# Pokemon Battle Royale

A real-time Pokémon Battle Royale fan-game prototype.

## Run locally

```powershell
cd codigo-extraido
npm install
node server/index.cjs --port 3210 --host 127.0.0.1 --root-dir .
```

Open http://127.0.0.1:3210.

## Accounts

Email/password registration and sign-in are built in. To enable **Continue with Google**, create an OAuth web client and configure `codigo-extraido/.env`. Follow the [Google login setup guide](codigo-extraido/GOOGLE_AUTH_SETUP.md). Never commit `.env` or publish `GOOGLE_CLIENT_SECRET`.

All current development work is on `feature/battle-royale-prototype`; it is not merged into `main`.

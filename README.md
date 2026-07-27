# Math Arcade — real-cash math quiz with PayPal payouts

A mobile-friendly math quiz game. Players solve equations to earn a real-dollar
balance, then withdraw straight to their PayPal account via the PayPal Payouts API.

## Stack

- **Backend:** Node.js + Express, JWT auth, bcrypt password hashing, flat-file JSON storage (no database needed)
- **Frontend:** single-file HTML/CSS/JS, dark-terminal aesthetic, no build step
- **Payouts:** PayPal Payouts API (sandbox or live)

## Project structure

```
mathgame/
├── server.js              # Express backend (auth, game, withdrawals)
├── package.json
├── .env.example            # copy to .env and fill in
├── data/
│   ├── users.json          # flat-file user store
│   └── withdrawals.json    # flat-file withdrawal history
└── public/
    └── index.html          # the whole frontend
```

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your values:
   ```
   cp .env.example .env
   ```

3. Get PayPal Payouts API credentials:
   - Go to https://developer.paypal.com/dashboard/applications
   - Create (or open) a REST API app to get a **Client ID** and **Secret**
   - For testing, use your **Sandbox** app credentials and set `PAYPAL_MODE=sandbox`
   - **Payouts must be enabled** on your PayPal Business account before going live — request access at https://www.paypal.com/bizsignup/entry/product/payouts if it's not already active
   - When ready for real money, switch to your **Live** app credentials and set `PAYPAL_MODE=live`

4. Run the server:
   ```
   npm start
   ```
   The app serves the frontend and API from the same origin — visit `http://localhost:3000`.

## Game economy (tune in `.env`)

- `POINTS_PER_CORRECT` — base points per correct answer (default 10)
- `USD_PER_POINT` — dollar value of each point (default $0.005, so a base correct answer = $0.05)
- Streaks add up to a +50% bonus multiplier the longer you stay correct
- `MIN_WITHDRAWAL_USD` — minimum payout amount (default $5.00)

Adjust these to match your margins — right now a played-out session of ~100 correct
answers at base difficulty earns roughly $5, so tune `USD_PER_POINT` down if you want
a slower payout curve.

## API endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/register` | — | Create account |
| POST | `/api/login` | — | Log in, get JWT |
| GET | `/api/me` | ✓ | Get current user |
| POST | `/api/game/question` | ✓ | Get a new equation |
| POST | `/api/game/submit` | ✓ | Submit an answer |
| POST | `/api/withdraw` | ✓ | Request a PayPal payout |
| GET | `/api/withdrawals` | ✓ | Withdrawal history |

## Deploying (Render)

1. Push this folder to a GitHub repo (e.g. under `Lona-web558`)
2. On Render: New → Web Service → connect the repo
3. Build command: `npm install`
4. Start command: `npm start`
5. Add the same environment variables from `.env` in Render's dashboard (never commit `.env`)
6. Note: `data/users.json` and `data/withdrawals.json` reset on redeploy unless you attach
   a Render persistent disk mounted at `/data` — for production, point the file paths in
   `server.js` to that mounted disk, or migrate to a small database later.

## Security notes before going live

- Set a long, random `JWT_SECRET` in production
- Serve over HTTPS only (Render does this by default)
- The current flat-file storage has no locking — fine for low concurrency, but if you
  expect many simultaneous withdrawals, consider moving to a proper database to avoid
  race conditions on the balance field
- Consider adding rate limiting on `/api/login` and `/api/withdraw`

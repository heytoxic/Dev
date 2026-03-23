# 🎲 Ludo King Pro

## Folder Structure
```
ludo-king-pro/
├── server.js          ← Node.js WebSocket + Express server
├── package.json       ← Dependencies
├── README.md
└── public/
    └── index.html     ← Full game frontend (Ludo King style UI)
```

## Setup & Run

### 1. Install dependencies
```bash
npm install
```

### 2. Start server
```bash
npm start
# or for dev with auto-restart:
npm run dev
```

### 3. Open in browser
Visit: http://localhost:3000

## Deploy to Render / Railway / Fly.io
- Set PORT env variable (auto-detected)
- Update `SERVER_URL` in index.html if deploying to custom domain:
  ```js
  const SERVER_URL = 'wss://your-app.onrender.com';
  ```

## Features
- ✅ Ludo King-style UI (colorful, 2nd image style)
- ✅ 2–8 players per room
- ✅ 6-digit numeric room codes
- ✅ Smart Ludo King dice logic (bias for stuck pieces)
- ✅ Turn timer (20s) → auto-move on timeout
- ✅ 3 timeout strikes → player removed
- ✅ Safe spots (⭐), blockades, piece cutting
- ✅ Player profiles with avatar upload (custom DP)
- ✅ Coins system with match rewards
- ✅ Match history saved per player
- ✅ Real-time chat with emojis
- ✅ Network ping indicator per player
- ✅ Reconnect with same room code
- ✅ Player stats (wins, streak, rating, level)
- ✅ Google Login (placeholder — add OAuth client ID)
- ✅ Name prompt on first visit
- ✅ Home page with stats, mode cards, nav bar
- ✅ Profile modal (3rd image stats style)

## Google Login Setup
In `public/index.html`, find `googleLogin()` function and replace with real Google Identity Services:
```js
// Add to <head>:
// <script src="https://accounts.google.com/gsi/client" async></script>

function googleLogin() {
  google.accounts.id.initialize({
    client_id: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
    callback: (response) => {
      send({ type: 'google_auth', idToken: response.credential });
    }
  });
  google.accounts.id.prompt();
}
```

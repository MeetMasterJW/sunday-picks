# Sunday Picks

A family NFL pick 'em for five players. You pick the straight-up winner of each game, with no spread. Each week has one winner, who gets a point, and the most points after Week 18 wins the season.

- **Schedule and live scores** come from ESPN's public scoreboard feed, fetched by the page itself. During games it refreshes every minute; otherwise every 10 minutes.
- **Picks, names and locks** are saved in Firebase Firestore, so every phone sees the same data live.
- **Weeks run Sunday through Saturday** (Eastern). A Thursday night game counts toward the Sunday before it.

## Set up

1. **Create a Firebase project.** In the [Firebase console](https://console.firebase.google.com), create a project (Analytics isn't needed). Then:
   - Go to **Build → Firestore Database → Create database**, choose production mode, and pick a US location.
   - Go to **Project settings → Your apps → Web** to register a web app.
   - Copy the `firebaseConfig` values into `config.js`.
2. **Set the security rules.** In **Firestore → Rules**, paste the contents of `firestore.rules` and click **Publish**.
3. **Copy existing picks** (optional). Put the exported `config/`, `picks/` and `locks/` folders in `./export`, then run:

   ```bash
   npm install
   npm run migrate -- ./export
   ```

   The script never overwrites a document that already exists in Firestore.
4. **Host it.** Push this folder to GitHub, then turn on **Settings → Pages → Deploy from branch → main / root**. Any static host works; there is no build step.

## Run locally

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080. The page is ES modules, so it needs to be served over http rather than opened as a file.

## Files

| File | What it does |
|---|---|
| `index.html` | The whole app: picks, all-picks grid, standings, family names |
| `espn.js` | Fetches ESPN weeks and regroups them into Sunday-to-Saturday pick weeks |
| `config.js` | Firebase web settings |
| `firestore.rules` | Who can write what (anyone with the link; no deletes) |
| `scripts/migrate.mjs` | One-time import of picks from the claude.ai version |

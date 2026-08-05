# Installing Sillara on a Mac

## There is no .dmg, and that is the design

Sillara installs from the browser. Chrome, Edge and Safari all turn it into a
real macOS application — its own window with no address bar, its own Dock icon,
its own entry in Launchpad, and it opens with the network unplugged.

That is not a compromise. A `.dmg` would mean:

| | PWA install | Electron `.dmg` |
|---|---|---|
| Download | ~110 KB | 80–150 MB |
| Updates | Next launch, silently | Ship a new build, chase every shop |
| Fixing a bug in Colombo | Deploy once | Wait for 400 shops to update |
| Apple notarization | Not needed | $99/yr + signing on every release |
| Windows / Android / iPad | Same install | Three more build pipelines |

For a POS sold to thousands of small shops, one fix reaching every counter at
once is worth more than a drag-to-Applications animation. Wrap it in Tauri
later **only** if you need something a browser genuinely cannot do — a USB
thermal printer or a cash-drawer kick — and even then, wrap this same build.

---

## Install it (30 seconds)

### Chrome or Edge — recommended

1. Open **http://localhost:5273**
2. Click the **install icon** in the address bar — a small monitor with a
   downward arrow, at the right-hand end. Or use the ⋮ menu → **Cast, save and
   share → Install page as app…**
3. Click **Install**.

`Sillara POS.app` now exists in `/Applications/Chrome Apps/`. Drag it to the
Dock. Launch it and you get a clean window with no browser furniture.

### Safari

1. Open **http://localhost:5273**
2. Menu bar: **File → Add to Dock…**
3. Name it *Sillara* and click **Add**.

Safari's version is slightly more limited (no install prompt API, no shortcut
menu) but the app, the icon and offline all work.

---

## If the install button does not appear

The browser hides it when the site does not qualify. In order of likelihood:

| Check | Expected |
|---|---|
| Is the page on `localhost` or `https://`? | Both count as secure. Plain `http://` on any other host will never offer install. |
| Already installed? | Chrome hides the button. Look in `/Applications/Chrome Apps/`. |
| Service worker running? | DevTools → Application → Service Workers → **activated** |
| Icons loading? | DevTools → Application → Manifest — the 192 and 512 icons must preview, not 404 |

To verify all of it in one shot, paste this into the DevTools console:

```js
navigator.serviceWorker.getRegistration().then(r => console.log('SW:', r?.active?.state));
fetch('/manifest.webmanifest').then(r => r.json()).then(m => console.log('icons:', m.icons.length, m.name));
```

Expect `SW: activated` and `icons: 4 Sillara POS`.

---

## Prove it really works offline

Worth doing once, because it is the thing the product is sold on.

1. Open the installed app and sign in.
2. Stop the servers: `pkill -f "vite preview"` and `pkill -f "tsx watch"`.
3. Ring up a sale. It completes, the receipt prints, change is calculated.
4. Start the servers again.
5. The sale appears on the server within seconds — **once**, with the receipt
   number it was given at the counter.

Step 3 with everything switched off is the whole pitch.

---

## Running it on a real shop counter

Localhost is for trying it. A real terminal points at your deployed API:

```bash
# pos/.env
VITE_API_URL=https://api.sillara.com
```

Then `npm run build` and host `dist/` anywhere static (Vercel, Netlify, Nginx).
**It must be served over HTTPS** — service workers and installation are both
refused on plain HTTP, so an unencrypted deployment silently loses offline
mode and the install button at the same time.

---

## What the shopkeeper sees

- **Dock icon** — indigo tile, launches straight into the till
- **No address bar** — it does not look or feel like a website
- **Survives reboot** — the session is kept, so the till is ready at open
- **Right-click the Dock icon** → *Sell* and *Receive goods* jump straight in
- **Updates itself** — next launch after you deploy, no prompt, no download

# Coffee Express Ordering

Customer ordering PWA + kitchen display (KDS) for Carriage Coffee Express (Gemco / The Gem).

- **Frontend**: `index.html` (customer order page) and `kds.html` (staff kitchen display), served as a Cloudflare Worker (`coffee-xpress-ordering`) on <https://coffee.gemcoplayers.org/>. Custom domain and DNS are managed on the `gemcoplayers.org` Cloudflare zone.
- **Backend**: Google Apps Script webapp (`code.js`) that serves the Loyverse menu, saves customer orders to a Google Sheet ("Coffee Orders"), and gates staff KDS actions with a PIN. Deployed as a webapp with **Execute as: Me**, **Who has access: Anyone**. The `/exec` URL is hardcoded into `kds.html` and `index.html` as `APPS_SCRIPT_URL` — if you create a new Apps Script deployment (rather than updating the existing one) the URL changes and both files must be updated to match.
- **PWA**: `sw.js` registers a cache-first service worker for the static assets in `manifest.json`. It intercepts all `fetch` events, so if the Apps Script backend is unreachable the KDS/customer page silently returns cached responses — clear site data (DevTools → Application → Storage) if you're seeing stale behaviour after a backend change.

## Staff PIN

The KDS is PIN-gated. The PIN is set as a Script Property `KDS_PIN` in the Apps Script project; if unset, the code falls back to `DEFAULT_PIN` at the top of `code.js` (`"4826"`). To change or inspect it, run these helpers from the Apps Script editor's Run menu:

- `setup_setPin` — edit the placeholder in the function body first, then Run.
- `setup_clearPin` — deletes the stored PIN so `DEFAULT_PIN` is used.
- `setup_showPin` — prints the effective PIN to the execution log for diagnosis.

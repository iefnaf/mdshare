# LAN Markdown Share: MVP design

Your nine items (a)–(i) are all accepted. Reviewing them turned up eight more gaps, numbered G1–G8 below; each fix is folded into the design.

- **G1 Seeding:** only the server fills a new document from the disk file. If browsers also inserted the text, every guest would add their own copy and the content would appear twice.
- **G2 Save race:** checking the file just before each save (compare-and-swap) closes the gap the file watcher's delay leaves open.
- **G3 Metadata:** Node has no API to copy extended attributes, so atomic replace needs a small native addon.
- **G4 mDNS:** macOS already announces `<LocalHostName>.local`, so the app needs no mDNS library of its own.
- **G5 Runtime:** tests must run inside Electron's built-in Node, not your system Node 26.
- **G6 Gatekeeper:** an ad-hoc-signed app still gets blocked by Gatekeeper, so users need an "Open Anyway" guide.
- **G7 macOS folder permission (TCC):** watching the parent folder in Documents, Desktop or Downloads can trigger a permission prompt.
- **G8 iCloud and symlinks:** files in iCloud Drive and symlinked files need explicit handling.

## Architecture
```
Electron main (Node) ── single process owns everything
 ├─ ShareSession {epoch, editToken, Y.Doc, frozen}
 ├─ HTTP: GET / , GET /assets/<hashed> , WS /ws   (nothing else → 404)
 ├─ SyncServer: y-protocols sync+awareness, ~200 LOC, our own (auth/epoch/limits)
 ├─ FileStore: read/validate, debounced CAS atomic save, backups, snapshot
 ├─ Watcher: fs.watch(parent dir) → stat+hash → freeze
 └─ native addon (napi-rs, Rust 1.94): copyfile(COPYFILE_METADATA)+fsync
Renderer (host UI): drop zone, URL+QR, Stop, freeze-resolution dialog
Guest browser: same CodeMirror 6 + y-codemirror.next bundle, no IndexedDB
```

## Decisions and reasons
| Decision | Why |
|---|---|
| Electron + Yjs on both ends, one lockfile | One CRDT implementation, so the two sides can't drift apart on protocol version |
| Our own small sync server built on y-protocols | We need hooks for token, epoch, size and freeze that the stock server doesn't give us |
| New `epoch` (random 128-bit) and new `editToken` on each Share | Content from an old session can't come back. Clients send `?e=&t=` on connect, and a wrong epoch gets close code 4001 |
| No IndexedDB; on any close, clients drop their Y.Doc and show a full-page "ended" state | No offline backlog and no resurrecting old content |
| Disk is the source of truth when a share starts; the server seeds the document from it (G1) | Guarantees the document matches the file at the start |
| Stop sharing: revoke the token, close every socket with code 4000, throw away the document | One clear end state |
| Address: `LocalHostName.local:port`, plus the IP in the QR (G4) | Android support for `.local` names is patchy |
| Bind to the LAN interface's IP; random port saved per install | Not reachable from other networks |
| Preview after the MVP; if added later: markdown-it `html:false`, DOMPurify, CSP `default-src 'self'; connect-src ws://<host>:<port>` | Keeps the attack surface small |
| No App Sandbox, ad-hoc signing, hardened runtime when Developer ID arrives | Direct download doesn't require the sandbox |
| Toolchain: CLT + electron-builder; system Node 26 for tooling only; tests use `ELECTRON_RUN_AS_NODE` (G5) | Tests run on the same runtime users get |

## Threat model and HTTP disclosure
Assumption: the home network is trusted. Even so, these are covered:
- **Unknown device on the network:** the 128-bit token is checked *before* the WebSocket upgrade (401). Max 8 connections.
- **DNS rebinding and cross-site WebSockets:** the Host header must be the current LAN IP or `.local` name plus our port (otherwise 421). Origin must equal the origin we served (otherwise 403). The allowlist is recomputed when the network changes.
- **Path traversal or file leaks:** only fixed routes; the page shows only the file's basename; `Referrer-Policy: no-referrer`; the token is passed in the URL fragment and sent only on the WebSocket URL.
- **Resource exhaustion:** WebSocket `maxPayload` of 256 KB; reject updates that would push the document past 2 MB; per-connection rate limit.
- **Not covered:** sniffing, and copying of the link.
- **Disclosure dialog** (on first share, plus a link in the window): *"Sharing uses unencrypted HTTP. Anyone on this Wi-Fi could read the document and the link. Use only on networks you trust."*

## Data safety
- **On open:** strict UTF-8 check (`TextDecoder fatal`); reject NUL bytes and files over 2 MB. Record the BOM and the main line-ending style (warn if line endings are mixed). Resolve symlinks to the real file; refuse files in iCloud Drive that aren't downloaded locally (G8).
- **Initial backup** before the first write of each session goes to `~/Library/Application Support/<App>/backups/<pathhash>/<ts>.md`, keeping the last 20.
- **Saving** (debounce 500 ms) uses compare-and-swap (G2):
  1. Stat and hash the disk file. If it differs from `lastKnown`, freeze instead of writing.
  2. Write a temp file in the same folder.
  3. Copy metadata from the original (mode, xattrs, Finder tags, ACLs) using the addon (G3).
  4. fsync, rename, fsync the folder.
  5. Set `lastKnown` to the new hash and modification time.
- **Watcher:** a debounced (150 ms) event on our basename triggers stat and hash. If the hash matches one we wrote, ignore it. If the file is different, renamed away or deleted, **freeze**:
  - the server stops applying updates;
  - guests switch to read-only with a banner;
  - the CRDT snapshot is saved.
  - The host then chooses **Keep shared version** (back up the disk version, then save) or **Load disk version** (back up the shared version, start a new epoch). Nothing is applied automatically.
- **Crash recovery:** a per-epoch `Y.encodeStateAsUpdate` snapshot is saved atomically every 5 s. On the next launch, if the snapshot doesn't match the disk, offer to save it as `name (recovered).md`. Never overwrite automatically.
- **Folder permission (G7):** dropping a file should grant access to the file itself. Test whether watching its folder in Documents prompts; if it does, ask for folder access once at drop time.

## Milestones
**M0 – Headless spike (core, no UI).** Done when every test below passes on macOS CI under Electron's built-in Node.

**M1 – Host app and guest editor.** Drag in a file, URL and QR, CodeMirror for guests. *Real two-device test* on a home Wi-Fi network (Mac host, iPhone Safari, and a second laptop running Chrome):
- the QR opens the editor in 10 s or less;
- remote keystrokes show up within 200 ms (p95, over 100 samples);
- a 30-minute, 3-person session ends with the disk file byte-identical to the editor.

**M2 – Security and lifecycle.**
- Stop closes every client within 1 s, and the old link returns 401.
- The next share gets a new token and epoch.
- Requests forged with curl (Host, Origin, token) are rejected.
- The disclosure dialog appears.
- The 9th connection is refused.

**M3 – Data safety.**
- External saves from VS Code, TextEdit, vim, `git checkout` and Finder-replace each freeze the session within 1 s, with the disk left untouched.
- Both resolution paths keep both versions in backups.
- Recovering after a kill -9 works.
- iCloud and symlink cases behave as specified.

**M4 – Package.**
- An ad-hoc-signed DMG, with a guide for the firewall prompt and "Open Anyway" (G6).
- 3 out of 3 nontechnical testers go from install to a friend editing in under 2 minutes.

## M0 spike: automated tests (node:test + Playwright)
1. **Convergence:** 3 Node clients make 1,000 random edits with random disconnects. All texts match, and the disk file equals the text after a flush.
2. **Seeding:** 5 clients join an existing document and the content is not duplicated.
3. **Epoch:** after a restart, a client with the old epoch gets 4001, and its content never shows up in the new document.
4. **Handshake:**
   - bad or missing token → 401, with no upgrade;
   - foreign Origin → 403;
   - `Host: evil.example` → 421;
   - a 300 KB message → close 1009.
5. **Routes:** `/../x`, `/assets/../main.js`, `/package.json` and `/%2e%2e/` all return 404.
6. **Crash safety:** kill -9 a writer 200 times at random points. The file is always either complete-old or complete-new, valid UTF-8.
7. **Save race:** change the file between the debounce and the save. No overwrite happens, and a freeze is emitted.
8. **Watcher:** an external atomic rename freezes within 1 s; our own saves never freeze.
9. **Round-trip:** LF, CRLF and BOM test files stay byte-identical after an edit that changes nothing; a Latin-1 file is rejected.
10. **Metadata:** mode 0640, a custom xattr and a Finder tag survive 10 saves.
11. **Playwright:** two Chromium contexts type at the same time, both converge, and a view stays read-only while frozen.

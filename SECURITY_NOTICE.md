# Security notice — malicious code removed

The original zip contained hidden, obfuscated JavaScript in **four** places. All were removed.

| File | How it ran |
|---|---|
| `init` | executed by `npm start` / `npm run build` (`node init && ...`) |
| `assets/expo.icon/Assets/public/fonts/fa-brand-400.orc` | a "font" that was really JS; run by `.vscode/tasks.json` automatically when the folder is opened in VS Code |
| `.vscode/tasks.json` | silent `runOn: folderOpen` task launching the file above |
| `App.js` (line 732) | same payload appended after ~150 spaces at the end of the file, so it ran inside the app itself |

Strings in the payload are encrypted, so its exact behaviour was not decoded, but this pattern (hidden loader, fake font, auto-run on folder open)
is typical of credential/wallet-stealing malware shipped in "test project" repositories.

**If you ever ran `npm start`/`npm run build` or opened this folder in VS Code (with tasks allowed) on the original zip:**
treat that computer as compromised — change passwords from a clean device, rotate GitHub/Expo/Firebase/Cashfree/cloud keys,
revoke active sessions, and check crypto wallets/browser-saved passwords. Rotate the Firebase API key in `config/firebase.js` too.

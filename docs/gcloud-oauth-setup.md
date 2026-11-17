# Google Cloud OAuth setup: what gcloud can script (todo pc-1760, step 1)

Settled 2026-11-17 from `gcloud ... --help` on Google Cloud SDK 580.0.0 (this PC); the console steps further down are from memory, not from `--help`. No gcloud command that changes anything was run, and `scripts/gcloud-oauth-setup.ps1` has never been run.

## What gcloud can do

| Step | Command | Source |
|---|---|---|
| Create the project (no parent folder or organization; also enables the default Cloud APIs unless `--no-enable-cloud-apis`) | `gcloud projects create <id> --name=<name>` | `gcloud projects create --help` |
| Enable the Drive API | `gcloud services enable drive.googleapis.com --project=<id>` | `gcloud services enable --help` |

Both need an active `gcloud auth login`, which is a browser sign-in only the account owner does. The script checks `gcloud auth list` (read-only) and stops with a message if nobody is signed in.

## What gcloud cannot do

- **The OAuth client an app signs in with (the "OAuth 2.0 Client ID" for Drive).** The one group that looks right, `gcloud iam oauth-clients` (create, credentials create, and so on), makes IAM OAuth clients for federated identities (its help says "federated identity"; the workforce-federation reading is an inference, UNVERIFIED). Its `--allowed-scopes` accepts only `cloud-platform`, `openid`, `email` and `groups`, so it cannot hold a Drive scope. Not a substitute.
- **The consent screen.** `gcloud iap oauth-brands` exists but is marked DEPRECATED in its own help: the help says support for the IAP OAuth Admin APIs ends 2026-01-19 (new projects cannot use them from then) and they shut down for good on 2026-03-19. Both dates are past, so treat the group as dead.
- A `gcloud alpha` or `beta` command for either was not found in `gcloud alpha --help` and `gcloud auth --help` (UNVERIFIED beyond those two listings: a component install could add one).

## Browser-only steps and what Joe types or clicks

The script prints these URLs for the project it just made. Menu wording and the exact paths are from memory of Google's "Google Auth Platform" console and are UNVERIFIED: check them on first use and correct this note.

1. **Branding (consent screen).** `https://console.cloud.google.com/auth/branding?project=<id>`. Type: app name, user support email, homepage URL, privacy policy URL (this project's is `https://sirbepy.github.io/claude_conductor/privacy-policy.html`), developer contact email. The homepage and privacy URLs are required before publishing a production app.
2. **Audience.** `.../auth/audience?project=<id>`. Choose External, add test users while in Testing, and press "Publish app" to leave Testing (refresh tokens of a Testing app expire after 7 days).
3. **Create the OAuth client.** `.../auth/clients?project=<id>`, Create client. Pick Desktop app, or Web application and add its redirect URIs. In the dialog press "Download JSON": the client secret may be visible only at that moment.
4. **Hand the JSON to the script**, which moves the values without printing them:

```powershell
scripts\gcloud-oauth-setup.ps1 -ClientJson $HOME\Downloads\client_secret_<n>.json -EnvFile <gitignored file> -DeleteJson
```

The script refuses to write unless `-EnvFile` is inside a git repo and `git check-ignore` says it is ignored (same rule as `request_secret`), writes `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (change with `-Prefix`), and with `-DeleteJson` deletes the download. A chat that runs it sees only the file names, never the values.

## Why a downloaded file and not `capture_secret_from_page`

The download is a file on disk, so the script can read it directly and nothing has to read the page. `capture_secret_from_page` (pc-1611) stays the fallback for a console that shows a value only on screen.

## Not done

- The script is unrun: its stage 1 creates a real project and stage 2 needs a real downloaded JSON. First run needs Joe's `gcloud auth login`, a project id, and the choice of Desktop or Web client (todo pc-1760 keeps these open).
- The browser steps are not recorded as a click-by-click recipe yet; that needs one real pass with Joe's account.

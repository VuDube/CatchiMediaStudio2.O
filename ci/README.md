# CI workflows — one browser step required

The GitHub App token used for automated commits does not include the
`workflow` scope, so GitHub blocks API writes into `.github/workflows/`.

**Fix (30 seconds, browser only):**

1. Open this repo on github.com.
2. Click **Add file → Create new file**, name it `.github/workflows/deploy.yml`,
   paste the contents of `ci/deploy.yml`, commit.
3. Repeat with `.github/workflows/maintenance.yml` ← `ci/maintenance.yml`.
4. Delete the `ci/` folder.

After that, every push to `main` auto-deploys and the daily asset
cleanup runs automatically.

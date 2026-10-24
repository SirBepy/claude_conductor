#!/usr/bin/env bash
# Uploads one signed .aab to a Google Play track through the Android Publisher v3
# edits API: open an edit, upload the bundle, point the track at it, commit.
#
# Usage: play-upload.sh <service-account.json> <package-name> <bundle.aab> [track] [status]
#   track   defaults to "internal"
#   status  defaults to "completed". Play refuses anything but "draft" while the
#           app has never had a release rolled out, which is why the very first
#           bundle goes up by hand in Play Console instead.
#
# Mints the OAuth token with openssl instead of a third-party action, so the
# only things that ever see the service-account key are this runner and Google.
# Needs bash, curl, jq and openssl, all present on ubuntu-latest.
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <service-account.json> <package-name> <bundle.aab> [track] [status]" >&2
  exit 2
fi

SA_JSON="$1"
PACKAGE="$2"
BUNDLE="$3"
TRACK="${4:-internal}"
STATUS="${5:-completed}"
API="https://androidpublisher.googleapis.com/androidpublisher/v3/applications/$PACKAGE"
UPLOAD_API="https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/$PACKAGE"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Prints Google's error body to stderr before failing. Piping curl straight into
# jq would swallow it, and the body is the only place Play says WHY it refused.
call() {
  local out
  if ! out=$(curl -sS --fail-with-body "$@"); then
    echo "$out" >&2
    exit 1
  fi
  printf '%s' "$out"
}

CLIENT_EMAIL=$(jq -r '.client_email' "$SA_JSON")
KEY_FILE=$(mktemp)
trap 'rm -f "$KEY_FILE"' EXIT
jq -r '.private_key' "$SA_JSON" > "$KEY_FILE"

NOW=$(date +%s)
HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
CLAIMS=$(jq -cn --arg iss "$CLIENT_EMAIL" --argjson iat "$NOW" --argjson exp "$((NOW + 3600))" \
  '{iss:$iss, scope:"https://www.googleapis.com/auth/androidpublisher",
    aud:"https://oauth2.googleapis.com/token", iat:$iat, exp:$exp}' | b64url)
SIGNATURE=$(printf '%s.%s' "$HEADER" "$CLAIMS" | openssl dgst -sha256 -sign "$KEY_FILE" | b64url)
JWT="$HEADER.$CLAIMS.$SIGNATURE"

# Kept out of `set -x` style logging on purpose: the token grants release rights.
TOKEN=$(call https://oauth2.googleapis.com/token \
  --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
  --data-urlencode "assertion=$JWT" | jq -r '.access_token')
echo "::add-mask::$TOKEN"
AUTH="Authorization: Bearer $TOKEN"

EDIT_ID=$(call -X POST -H "$AUTH" -H "Content-Length: 0" "$API/edits" | jq -r '.id')
echo "Opened edit $EDIT_ID"

VERSION_CODE=$(call -X POST -H "$AUTH" \
  -H "Content-Type: application/octet-stream" --data-binary "@$BUNDLE" \
  "$UPLOAD_API/edits/$EDIT_ID/bundles?uploadType=media" | jq -r '.versionCode')
echo "Uploaded bundle as versionCode $VERSION_CODE"

jq -cn --arg t "$TRACK" --arg v "$VERSION_CODE" --arg s "$STATUS" \
  '{track:$t, releases:[{versionCodes:[$v], status:$s}]}' |
  call -X PUT -H "$AUTH" -H "Content-Type: application/json" \
    --data-binary @- "$API/edits/$EDIT_ID/tracks/$TRACK" > /dev/null
echo "Track $TRACK now points at versionCode $VERSION_CODE ($STATUS)"

call -X POST -H "$AUTH" -H "Content-Length: 0" "$API/edits/$EDIT_ID:commit" > /dev/null
echo "Committed edit $EDIT_ID"

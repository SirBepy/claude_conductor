#!/usr/bin/env bash
# Runs play-upload.sh against a fake curl: checks the JWT it signs verifies
# against the service account's key, the four Play API calls happen in order,
# and a Play error body reaches stderr instead of vanishing into jq.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$WORK/key.pem" 2>/dev/null
openssl pkey -in "$WORK/key.pem" -pubout -out "$WORK/pub.pem"
jq -n --rawfile k "$WORK/key.pem" \
  '{client_email:"dummy-uploader@dummy-project.iam.gserviceaccount.com", private_key:$k}' > "$WORK/sa.json"
printf 'fake bundle bytes' > "$WORK/app.aab"

mkdir "$WORK/bin"
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
# Logs each call's URL and data args, answers with canned Play responses.
LOG="$CURL_LOG"
url=""
for a in "$@"; do
  case "$a" in https://*) url="$a" ;; esac
  case "$a" in assertion=*) printf '%s\n' "${a#assertion=}" > "$LOG.jwt" ;; esac
done
if [ "$a" = "-" ] || [[ " $* " == *" @- "* ]]; then cat > "$LOG.body"; fi
echo "$url" >> "$LOG"
if [ -n "${CURL_FAIL_ON:-}" ] && [[ "$url" == *"$CURL_FAIL_ON"* ]]; then
  echo '{"error":{"message":"Only releases with status draft may be created on draft app."}}'
  exit 22
fi
case "$url" in
  *oauth2.googleapis.com/token) echo '{"access_token":"dummy-token"}' ;;
  *:commit) echo '{}' ;;
  */bundles*) echo '{"versionCode":2003004}' ;;
  */tracks/*) echo '{}' ;;
  */edits) echo '{"id":"dummy-edit"}' ;;
esac
STUB
chmod +x "$WORK/bin/curl"

fail() { echo "FAIL: $1" >&2; exit 1; }

export CURL_LOG="$WORK/calls"
PATH="$WORK/bin:$PATH" bash "$HERE/play-upload.sh" "$WORK/sa.json" com.example.app "$WORK/app.aab" > "$WORK/out"

# Signature check: split the JWT and verify header.claims against the public key.
IFS=. read -r h c s < "$CURL_LOG.jwt"
pad() { local x="$1"; while [ $(( ${#x} % 4 )) -ne 0 ]; do x="$x="; done; printf '%s' "$x" | tr '_-' '/+'; }
pad "$s" | openssl base64 -d -A > "$WORK/sig"
printf '%s.%s' "$h" "$c" | openssl dgst -sha256 -verify "$WORK/pub.pem" -signature "$WORK/sig" > /dev/null \
  || fail "JWT signature does not verify"
pad "$c" | openssl base64 -d -A | jq -e '.scope == "https://www.googleapis.com/auth/androidpublisher"
  and .iss == "dummy-uploader@dummy-project.iam.gserviceaccount.com" and (.exp - .iat) == 3600' > /dev/null \
  || fail "JWT claims are wrong"
echo "PASS: JWT is RS256-signed by the service account key with the androidpublisher scope"

EXPECTED="https://oauth2.googleapis.com/token
https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/edits
https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/com.example.app/edits/dummy-edit/bundles?uploadType=media
https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/edits/dummy-edit/tracks/internal
https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/edits/dummy-edit:commit"
[ "$(cat "$CURL_LOG")" = "$EXPECTED" ] || fail "call sequence was: $(cat "$CURL_LOG")"
echo "PASS: token, open edit, upload bundle, set internal track, commit, in that order"

jq -e '.track == "internal" and .releases[0].versionCodes == ["2003004"] and .releases[0].status == "completed"' \
  "$CURL_LOG.body" > /dev/null || fail "track body was: $(cat "$CURL_LOG.body")"
echo "PASS: the track release names the uploaded versionCode"

rm -f "$CURL_LOG"
if CURL_FAIL_ON=/tracks/ PATH="$WORK/bin:$PATH" bash "$HERE/play-upload.sh" \
    "$WORK/sa.json" com.example.app "$WORK/app.aab" > /dev/null 2> "$WORK/err"; then
  fail "a refused track update still exited 0"
fi
grep -q "status draft" "$WORK/err" || fail "Play's error body did not reach stderr: $(cat "$WORK/err")"
grep -q ":commit" "$CURL_LOG" && fail "it committed the edit after the track update failed"
echo "PASS: a Play refusal stops before commit and prints Play's reason"

echo "ALL PASS"

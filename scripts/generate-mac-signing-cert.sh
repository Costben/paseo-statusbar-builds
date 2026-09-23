#!/usr/bin/env bash
#
# Generates the self-signed macOS code-signing certificate this repo signs its
# desktop builds with.
#
# Why self-signed and not a $99/year Apple Developer ID: Squirrel.Mac validates
# an update against the *designated requirement of the app it is replacing*, and
# a self-signed certificate produces
#
#     identifier "sh.paseo.desktop" and certificate root = H"<cert sha1>"
#
# which is stable for as long as the certificate is. An ad-hoc signature
# produces `cdhash H"..."` instead, which changes on every build, so it can
# never self-update. See the README section "macOS: auto-update needs a
# certificate, but not an Apple one".
#
# The OU field is part of this repo's certificate contract, and it is worth being
# precise about what it does and does not buy, because the difference shipped a
# crash to users once already.
#
# It does NOT give the signature a Team ID. codesign writes a TeamIdentifier only
# for a certificate issued by Apple; a self-signed certificate gets
# `TeamIdentifier=not set` on every binary it signs — with an OU in the subject
# and without one, trusted and untrusted, measured on the runner. What that means
# is that hardened runtime (which upstream enables) turns on library validation
# with nothing on either side to match, so the app cannot load its own Electron
# Framework and dies before it can draw a window:
#
#     Library not loaded: @rpath/Electron Framework.framework/Electron Framework
#     Reason: ... mapping process and mapped file (non-platform) have different Team IDs
#
# The launch is fixed by `entitlements/` and caught by the workflow's smoke step.
# The OU stays because it is the field a designated requirement matches on
# (`certificate leaf[subject.OU]`) — that is what a Developer ID certificate
# pins — so keeping it here means a later move to a real Apple certificate keeps
# the same subject shape.
#
# RUN THIS ONCE AND NEVER AGAIN — with one exception, already used once. Re-running
# it produces a different certificate, and the designated requirement pins the
# *certificate*, so every published build stops being updatable and its users have
# to replace the .dmg by hand. The only safe moment to re-run is while no build
# signed by the old certificate has been installed by anyone.
#
# Usage: scripts/generate-mac-signing-cert.sh [outputDir]

set -euo pipefail

outDir="${1:-mac-signing-cert}"
# 20 years. The certificate is pinned into the designated requirement of every
# build, so it has to outlive the release channel. Apple's timestamp server also
# stamps self-signed code, which keeps already-published signatures valid even
# after this expires.
days=7300
cn="Paseo Self-Signed Signing"
# Subject OU. See the header for what it does and does not do — this script only
# guarantees it cannot go missing silently.
ou="paseo-builds"

if [ -e "$outDir" ]; then
  echo "ERROR: $outDir already exists — refusing to overwrite a signing identity." >&2
  exit 1
fi

mkdir -p "$outDir"
# `openssl rand` rather than `tr < /dev/urandom | head -c`: the latter gives `tr`
# a SIGPIPE, which `pipefail` turns into a fatal error.
password="$(openssl rand -base64 32 | LC_ALL=C tr -dc 'A-Za-z0-9')"

cat > "$outDir/req.cnf" <<EOF
[ req ]
default_md = sha256
prompt = no
distinguished_name = dn
x509_extensions = ext

[ dn ]
CN = $cn
O = paseo-statusbar-builds
OU = $ou

[ ext ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

echo "Generating a 2048-bit self-signed code-signing certificate (${days} days)..."
openssl req -x509 -newkey rsa:2048 -nodes -days "$days" \
  -keyout "$outDir/key.pem" -out "$outDir/cert.pem" \
  -config "$outDir/req.cnf" 2>/dev/null

# Keep the DN from being edited into a shape that silently drops the OU. This is
# a contract check on the certificate, not a launch check: what the app dies
# without is the entitlements, not the OU.
subject="$(openssl x509 -in "$outDir/cert.pem" -noout -subject -nameopt RFC2253)"
echo "Subject: $subject"
if ! printf '%s' "$subject" | grep -q "OU=$ou"; then
  echo "ERROR: the generated certificate has no OU=$ou." >&2
  echo "ERROR: the subject DN was edited. This is not what breaks the launch — the" >&2
  echo "ERROR: entitlements handle that — but the OU is part of this repo's" >&2
  echo "ERROR: certificate contract, so this certificate is not the one asked for." >&2
  exit 1
fi

# Build the .p12 with macOS's own `security` tool rather than
# `openssl pkcs12 -export`. macOS ships LibreSSL, whose export uses RC2/3DES
# keybags that `security import` rejects with
# `SecKeychainItemImport: unknown error -26276`, which would break the CI import
# with a message that points nowhere useful.
keychain="$outDir/.build.keychain-db"
keychainPassword="$(openssl rand -base64 32 | LC_ALL=C tr -dc 'A-Za-z0-9')"
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -f "$keychain"
}
trap cleanup EXIT

echo "Packing the identity into a .p12..."
security create-keychain -p "$keychainPassword" "$keychain"
security unlock-keychain -p "$keychainPassword" "$keychain"
security import "$outDir/cert.pem" -k "$keychain" -T /usr/bin/codesign -A
security import "$outDir/key.pem" -k "$keychain" -T /usr/bin/codesign -A
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$keychainPassword" "$keychain" >/dev/null

if ! security find-identity "$keychain" | grep -q "$cn"; then
  echo "ERROR: the certificate and key did not form a usable identity." >&2
  security find-identity "$keychain" >&2
  exit 1
fi

security export -k "$keychain" -t identities -f pkcs12 \
  -P "$password" -o "$outDir/cert.p12"
rm -f "$outDir/key.pem" "$outDir/req.cnf"

base64 -i "$outDir/cert.p12" | tr -d '\n' > "$outDir/cert.p12.base64"
base64 -i "$outDir/cert.pem" | tr -d '\n' > "$outDir/cert.pem.base64"

# `certificate root = H"..."` in the designated requirement is the SHA-1 of the
# DER certificate — the same value `security find-identity` prints.
certSha1="$(openssl x509 -in "$outDir/cert.pem" -outform DER | shasum -a 1 | awk '{print $1}')"

cat <<EOF

Done. Files are in $outDir/ — keep them somewhere safe and private:
  cert.p12          the identity (certificate + private key)
  cert.p12.base64   the value for the MAC_CSC_LINK secret
  cert.pem          the public certificate only

Set these two repository secrets (Settings -> Secrets and variables -> Actions):

  MAC_CSC_LINK          = contents of $outDir/cert.p12.base64
  MAC_CSC_KEY_PASSWORD  = $password

Certificate SHA-1 (this is what will appear in every build's designated
requirement, and the thing that must never change):
  $certSha1

Subject OU (part of this repo's certificate contract — it is not what gives a
signature its TeamIdentifier, see the header):
  $ou

After adding the secrets, re-run the macOS workflow with force: true so the
existing unsigned assets get replaced by signed ones.
EOF

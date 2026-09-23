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
# RUN THIS ONCE AND NEVER AGAIN. Re-running it produces a different certificate,
# and every build already published with the old one stops being updatable —
# existing users would have to replace their .dmg by hand again.
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

[ ext ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

echo "Generating a 2048-bit self-signed code-signing certificate (${days} days)..."
openssl req -x509 -newkey rsa:2048 -nodes -days "$days" \
  -keyout "$outDir/key.pem" -out "$outDir/cert.pem" \
  -config "$outDir/req.cnf" 2>/dev/null

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

After adding the secrets, re-run the macOS workflow with force: true so the
existing unsigned assets get replaced by signed ones.
EOF

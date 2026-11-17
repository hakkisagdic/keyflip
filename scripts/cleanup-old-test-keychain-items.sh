#!/bin/sh
# One-off cleanup (not a test, not shipped): removes the leftovers of the old kiro apikey end-to-end test,
# which wrote these four items into the login Keychain. Only these exact service names are looked up and
# deleted. Values are never read and the Keychain is never listed. Other items (for example any "kiro-api:*"
# or "kiro-api-hold:*") are not queried at all.
# Usage: sh scripts/cleanup-old-test-keychain-items.sh [--dry-run]
set -u
SEC=/usr/bin/security
for name in a1 a2 a9 h; do
  svc="keyflip:kiro-apikey:$name"
  if "$SEC" find-generic-password -s "$svc" >/dev/null 2>&1; then
    if [ "${1:-}" = "--dry-run" ]; then
      echo "would delete $svc"
    else
      "$SEC" delete-generic-password -s "$svc" >/dev/null 2>&1 && echo "deleted $svc" || echo "could not delete $svc"
    fi
  else
    echo "absent $svc"
  fi
done

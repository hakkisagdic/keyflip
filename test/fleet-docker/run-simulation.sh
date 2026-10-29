#!/usr/bin/env bash
# Real multi-machine fleet simulation over Docker.
#
# The unit tests (test/fleet.test.js) simulate machines in one process. This harness runs three
# SEPARATE containers that coordinate only through a shared rendezvous volume, driving the real
# `node bin/keyflip.js fleet ...` CLI and asserting on its output:
#
#   1. three machines initialise into one fleet folder
#   2. each publishes one account; every machine sees all three (encrypted statuses)
#   3. invite/join pairing pins keys on both sides; explicit `fleet trust` pins a third machine
#   4. `fleet keys` reports ok / unpinned / CHANGED correctly
#   5. the rendezvous files are encrypted at rest (no plaintext e-mails/fields) and 0600
#   6. a wrong passphrase sees an empty fleet
#   7. a queued switch verifies its signature but is REFUSED without consent (non-TTY)
#   8. the same switch applies with `-y`
#   9. a command from an UNPINNED machine is rejected despite a valid signature
#  10. a re-keyed (key-substituted) machine is flagged CHANGED and its commands are rejected
#
# Usage: ./run-simulation.sh [--keep]
#   --keep   leave the containers + volume running for manual inspection
#
# Prerequisites: Docker Desktop (or another daemon) with Compose v2 (`docker compose`), and host
# `node` (used only to parse the CLI's --json output).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
PROJECT=keyflip-fleet-sim
IMAGE=keyflip-fleet-sim
PASS=/run/keyflip/pass
A=fleet-machine-a
B=fleet-machine-b
C=fleet-machine-c

KEEP=0
FAILED=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    -h | --help)
      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

step() { printf '\n== %s\n' "$*"; }
ok() { printf 'ok  - %s\n' "$*"; }
die() {
  FAILED=1
  printf 'FAIL - %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ "$KEEP" -eq 1 || "$FAILED" -eq 1 ]]; then
    printf '\nContainers kept (project %s).\n' "$PROJECT"
    printf '  inspect: docker exec -it %s sh\n' "$A"
    printf '  remove : docker compose -p %s -f %s down -v\n' "$PROJECT" "$COMPOSE_FILE"
  else
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# Run the real CLI inside one container, as the unprivileged simulation user.
kf() {
  local ctr="$1"
  shift
  docker exec -u keyflip -e HOME=/home/keyflip "$ctr" node /keyflip/bin/keyflip.js "$@"
}

# Assert on a JSON document read from stdin. $1 is a JS expression over `o` (script-authored,
# never user input). Machine ids are passed through the environment, not interpolated.
jassert() {
  node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      let o;
      try { o = JSON.parse(s); } catch (e) { console.error("not JSON: " + s.slice(0, 400)); process.exit(1); }
      let pass = false;
      try { pass = !!eval(process.argv[1]); } catch (e) { console.error("bad assertion: " + e.message); process.exit(1); }
      if (!pass) { console.error("assertion failed: " + process.argv[1] + "\n" + JSON.stringify(o).slice(0, 800)); process.exit(1); }
    });
  ' "$1"
}

jvalue() {
  node -e '
    let s = "";
    process.stdin.on("data", d => (s += d)).on("end", () => {
      const o = JSON.parse(s);
      const v = process.argv[1].split(".").reduce((a, k) => (a == null ? a : a[k]), o);
      if (v == null) { console.error("missing JSON path: " + process.argv[1]); process.exit(1); }
      process.stdout.write(String(v));
    });
  ' "$1"
}

# Write a profile fixture (<configDir>/<name>.json — the minimal non-secret shape keyflip reads).
put_profile() {
  local ctr="$1" name="$2" email="$3"
  docker exec -u keyflip -e HOME=/home/keyflip "$ctr" node --input-type=module -e '
    import fs from "node:fs";
    const dir = process.env.HOME + "/.config/keyflip";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      dir + "/" + process.argv[1] + ".json",
      JSON.stringify({ name: process.argv[1], email: process.argv[2], schemaVersion: 1 }),
      { mode: 0o600 },
    );
  ' "$name" "$email"
}

push() { kf "$1" fleet push --passphrase-file "$PASS" "${@:2}"; }

case "$(uname -s)" in Darwin | Linux) ;; *) echo "This harness targets Docker Desktop on macOS/Linux." >&2 ;; esac
command -v docker >/dev/null || die "docker not found in PATH"
command -v node >/dev/null || die "host node is required (parses --json output)"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required ('docker compose', not 'docker-compose')"

# -------------------------------------------------------------------------------------------------
step "1/10 build and start three machines"
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" build
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d

for ctr in "$A" "$B" "$C"; do
  ready=0
  for _ in $(seq 1 30); do
    if docker exec -u keyflip "$ctr" node -v >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ "$ready" -eq 1 ]] || die "$ctr did not become ready"
done
ok "all three containers are running the baked-in CLI"

# The named volume is created root-owned; hand it to the simulation user before any fleet write.
VOL=$(docker inspect "$A" --format '{{range .Mounts}}{{if eq .Destination "/rendezvous"}}{{.Name}}{{end}}{{end}}')
[[ -n "$VOL" ]] || die "could not resolve the rendezvous volume"
docker run --rm -u root -v "$VOL:/rendezvous" "$IMAGE" chown -R keyflip:keyflip /rendezvous >/dev/null
ok "rendezvous volume '$VOL' is writable by the keyflip user"

# -------------------------------------------------------------------------------------------------
step "2/10 initialise the fleet on A, B, C"
init_one() {
  local ctr="$1" name="$2" out
  out=$(kf "$ctr" fleet init --dir /rendezvous --name "$name" --json)
  printf '%s' "$out" | jassert "o.fleet && o.fleet.name === '$name' && o.fleet.dir === '/rendezvous'"
  printf '%s' "$out" | jvalue fleet.machineId
}
A_ID=$(init_one "$A" machine-a)
B_ID=$(init_one "$B" machine-b)
C_ID=$(init_one "$C" machine-c)
export A_ID B_ID C_ID
ok "alpha=$A_ID"
ok "bravo=$B_ID"
ok "charlie=$C_ID"

# -------------------------------------------------------------------------------------------------
step "3/10 publish one account per machine"
put_profile "$A" work work@example.test
put_profile "$B" personal personal@example.test
put_profile "$C" ci ci@example.test

for pair in "$A:work" "$B:personal" "$C:ci"; do
  ctr="${pair%%:*}"
  out=$(push "$ctr")
  printf '%s\n' "$out" | grep -q "published machine-" || die "unexpected push output from $ctr: $out"
  # push must never report the LOCAL machine as an untrusted peer (reconcile skips self).
  me=$(printf '%s\n' "$out" | sed -nE 's/.*published ([A-Za-z0-9._-]+):.*/\1/p')
  if printf '%s\n' "$out" | grep -q "new machine $me ("; then
    die "$ctr reported itself as an untrusted peer"
  fi
done
ok "three encrypted status files published; no machine flags itself as pending"

# -------------------------------------------------------------------------------------------------
step "4/10 every machine can read the whole fleet"
status=$(kf "$A" fleet status --json --passphrase-file "$PASS")
printf '%s' "$status" | jassert "o.fleet.length === 3"
printf '%s' "$status" | jassert "o.fleet.map(x => x.name).sort().join(',') === 'machine-a,machine-b,machine-c'"
printf '%s' "$status" | jassert "o.fleet.flatMap(x => x.accounts.map(a => a.email)).sort().join(',') === 'ci@example.test,personal@example.test,work@example.test'"
printf '%s' "$status" | jassert "o.fleet.every(x => x.creds === undefined)"
text=$(kf "$A" fleet status --passphrase-file "$PASS")
for n in machine-a machine-b machine-c; do
  printf '%s\n' "$text" | grep -q "$n" || die "human status is missing $n: $text"
done
ok "status shows 3 machines / 3 accounts and never leaks creds"

# -------------------------------------------------------------------------------------------------
step "5/10 pair A<->B with invite/join; pin A<->C with explicit trust"
invite=$(kf "$A" fleet invite --passphrase-file "$PASS")
code=$(printf '%s\n' "$invite" | sed -nE 's/^[[:space:]]+([A-Z2-9]{8})[[:space:]]*$/\1/p' | head -1)
[[ "$code" =~ ^[A-Z2-9]{8}$ ]] || die "could not parse the pairing code from: $invite"
printf '%s' "$code" | docker exec -i -u keyflip "$A" sh -c 'cat > /tmp/invite-code'
printf '%s' "$code" | docker exec -i -u keyflip "$B" sh -c 'cat > /tmp/invite-code'

join=$(kf "$B" fleet join "$A_ID" --code-file /tmp/invite-code --passphrase-file "$PASS" --json)
printf '%s' "$join" | jassert "o.fleetJoin.hostId === process.env.A_ID"

accepted=$(kf "$A" fleet push --accept-join "$A_ID" --code-file /tmp/invite-code --passphrase-file "$PASS" --json)
printf '%s' "$accepted" | jassert "o.fleetPush.paired.length === 1 && o.fleetPush.paired[0].machineId === process.env.B_ID"

trusted=$(kf "$A" fleet trust "$C_ID" --passphrase-file "$PASS" --json)
printf '%s' "$trusted" | jassert "o.trusted.machineId === process.env.C_ID && o.trusted.changed === false"
trusted=$(kf "$C" fleet trust "$A_ID" --passphrase-file "$PASS" --json)
printf '%s' "$trusted" | jassert "o.trusted.machineId === process.env.A_ID"

# The judge pinning (C<->B) is intentionally absent: step 9 proves it is not auto-trusted.
ok "A pins B and C; B pins A; C pins A"

# -------------------------------------------------------------------------------------------------
step "6/10 audit the signing-key store on A and B"
keys=$(kf "$A" fleet keys --json --passphrase-file "$PASS")
printf '%s' "$keys" | jassert "o.keys.find(k => k.machineId === process.env.B_ID).status === 'ok'"
printf '%s' "$keys" | jassert "o.keys.find(k => k.machineId === process.env.C_ID).status === 'ok'"
printf '%s' "$keys" | jassert "o.keys.find(k => k.machineId === process.env.A_ID).status === 'unpinned'"

keys_b=$(kf "$B" fleet keys --json --passphrase-file "$PASS")
printf '%s' "$keys_b" | jassert "o.keys.find(k => k.machineId === process.env.A_ID).status === 'ok'"
printf '%s' "$keys_b" | jassert "o.keys.find(k => k.machineId === process.env.C_ID).status === 'unpinned'"
ok "pinned/published fingerprints agree exactly where expected"

# -------------------------------------------------------------------------------------------------
step "7/10 rendezvous is encrypted at rest and rejects a wrong passphrase"
docker run --rm -v "$VOL:/data" "$IMAGE" sh -c '
  set -e
  n=0
  for f in /data/*; do
    [ -f "$f" ] || continue
    n=$((n + 1))
    if grep -q "work@example.test" "$f" || grep -q "personal@example.test" "$f" || grep -q "ci@example.test" "$f"; then
      echo "PLAINTEXT SECRET LEAK in $f" >&2; exit 1
    fi
    if grep -q "accounts" "$f"; then
      echo "PLAINTEXT STATUS FIELD in $f" >&2; exit 1
    fi
    perm=$(stat -c %a "$f")
    [ "$perm" = "600" ] || { echo "bad mode $perm on $f" >&2; exit 1; }
  done
  [ "$n" -gt 0 ] || { echo "rendezvous is empty" >&2; exit 1; }
  echo "checked $n encrypted file(s)"
'

docker exec -u keyflip "$A" sh -c 'printf "%s" wrong-passphrase > /tmp/wrong-pass'
wrong=$(kf "$A" fleet status --json --passphrase-file /tmp/wrong-pass)
printf '%s' "$wrong" | jassert "o.fleet.length === 0"
ok "no plaintext in the shared folder; wrong passphrase decrypts nothing"

# -------------------------------------------------------------------------------------------------
step "8/10 a queued switch verifies its signature but needs consent"
sw=$(kf "$A" fleet switch machine-b personal --passphrase-file "$PASS" --json)
printf '%s' "$sw" | jassert "o.queued.target === 'machine-b'"

# No TTY and no -y: the command must be read, origin-verified, then REFUSED.
b_push=$(kf "$B" fleet push --passphrase-file "$PASS" --json)
printf '%s' "$b_push" | jassert "o.fleetPush.applied.length === 1"
printf '%s' "$b_push" | jassert "o.fleetPush.applied[0].applied === 'switch' && /needs consent/.test(o.fleetPush.applied[0].detail)"
ok "switch from A was signature-verified and skipped (needs consent)"

# -------------------------------------------------------------------------------------------------
step "9/10 the same switch applies with -y"
kf "$A" fleet switch machine-b personal --passphrase-file "$PASS" >/dev/null
b_push=$(kf "$B" fleet push -y --passphrase-file "$PASS" --json)
printf '%s' "$b_push" | jassert "o.fleetPush.applied.length === 1 && o.fleetPush.applied[0].ok === true"
printf '%s' "$b_push" | jassert "/switched to personal/.test(o.fleetPush.applied[0].detail)"

# The inbox is cleared after consumption: a second push must not replay it.
b_again=$(kf "$B" fleet push --passphrase-file "$PASS" --json)
printf '%s' "$b_again" | jassert "o.fleetPush.applied.length === 0"
ok "consent applied the switch once; the next push replayed nothing"

# -------------------------------------------------------------------------------------------------
step "10/10 unpinned senders are rejected, and so is a re-keyed machine"
# C is trusted by A but NOT by B. A command from C must fail origin auth even with a valid signature.
kf "$C" fleet switch machine-b ci --passphrase-file "$PASS" >/dev/null
b_push=$(kf "$B" fleet push --passphrase-file "$PASS" --json)
printf '%s' "$b_push" | jassert "o.fleetPush.applied.length === 1"
printf '%s' "$b_push" | jassert "/no pinned key for sender/.test(o.fleetPush.applied[0].detail)"

# Destroy B's signing key (simulating a reinstall) and publish the new one. A already pinned the old
# key, so this must surface as CHANGED and every command from B must be rejected until re-trusted.
docker exec -u keyflip "$B" rm -f /home/keyflip/.config/keyflip/fleet-key.json
kf "$B" fleet push --passphrase-file "$PASS" >/dev/null

keys=$(kf "$A" fleet keys --json --passphrase-file "$PASS")
printf '%s' "$keys" | jassert "o.keys.find(k => k.machineId === process.env.B_ID).status === 'CHANGED'"

kf "$B" fleet switch machine-a work --passphrase-file "$PASS" >/dev/null
a_push=$(kf "$A" fleet push --passphrase-file "$PASS" --json)
printf '%s' "$a_push" | jassert "o.fleetPush.applied.length === 1"
printf '%s' "$a_push" | jassert "/key CHANGED/.test(o.fleetPush.applied[0].detail)"
ok "unpinned sender rejected; re-key detected as CHANGED and its command rejected"

printf '\nAll 10 checks passed.\n'

# Fleet Docker Simulation

A real multi-machine test of `keyflip fleet`: three separate containers coordinate **only** through
a shared rendezvous volume, driving the actual `node bin/keyflip.js fleet ...` CLI.

The unit tests in `test/fleet.test.js` simulate machines in one process. This harness runs the
protocol across real process and filesystem boundaries — the same code path a second laptop uses.

## Prerequisites

- Docker Desktop (or another Docker daemon) up and running
- Docker Compose v2 — the `docker compose` subcommand, not the old `docker-compose` binary
- Host `node` (used only to parse the CLI's `--json` output)

## Run

```bash
cd test/fleet-docker
./run-simulation.sh          # build, run every check, then remove containers + volume
./run-simulation.sh --keep   # leave the three machines running for manual inspection
```

A failing run keeps the containers so you can inspect the state; the last line prints the removal
command.

## What it asserts

1. Three containers start from one image built on the repo root (code baked in, no bind mount).
2. Each machine initialises into the same `/rendezvous` folder and gets a stable machine id.
3. Each publishes exactly one account; every machine sees all three statuses.
4. `fleet status --json` is creds-free, and the human status lists all three machines.
5. `fleet invite` + `fleet join --code` pins A↔B on **both** sides; `fleet trust` pins A↔C.
6. `fleet keys` reports `ok` for pinned+published, `unpinned` for a machine never paired (and for
   the local machine, which never pins itself), and `CHANGED` after a re-key.
7. The shared folder holds only encrypted files (no plaintext e-mail or `accounts` field) with mode
   `0600`; a wrong passphrase decrypts nothing.
8. A queued `switch` from A is signature-verified by B but **refused without consent** (non-TTY,
   no `-y`) — the `skipped (needs consent)` path.
9. The same switch applies with `-y`, and the consumed inbox is not replayed on the next push.
10. A command from a machine B never pinned is rejected even though its signature is valid; after
    B is re-keyed, A reports `CHANGED` and rejects B's commands until an explicit re-trust.

Not covered here: LAN multicast discovery (`fleet discover`), Tailscale transport, and credential
relay (`send-account`) with real tokens. Those need distinct network namespaces or real credentials
and stay in the unit/integration suites.

## How it is built

```
test/fleet-docker/Dockerfile          node:20-alpine + git/sqlite/bash; copies bin/ + src/
test/fleet-docker/docker-compose.yml  three services, one named volume, one bridge network
test/fleet-docker/passphrase.txt      dummy simulation passphrase (not a real secret)
test/fleet-docker/run-simulation.sh   the driver: docker exec per step, assertions on real output
```

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ machine-a   │     │ machine-b   │     │ machine-c   │
│ initiator   │     │ joiner      │     │ trust test  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                  ┌────────▼────────┐
                  │ named volume    │
                  │ /rendezvous     │
                  │ *.status.enc    │
                  │ *.inbox.enc     │
                  │ pair-*.enc      │
                  └─────────────────┘
```

Each container has its own `HOME` (`/home/keyflip`) and config dir (`~/.config/keyflip`). The image
runs as UID/GID 10001 (node:20-alpine already owns 1000); the driver chowns the named volume once
before the first fleet write, then every CLI call runs as that user via `docker exec`.

The passphrase is supplied per command with `--passphrase-file /run/keyflip/pass` — keyflip never
stores it, and neither does this harness.

## Manual inspection

```bash
docker exec -it fleet-machine-a sh
cd /keyflip
node bin/keyflip.js fleet status --passphrase-file /run/keyflip/pass
node bin/keyflip.js fleet keys   --passphrase-file /run/keyflip/pass
ls -l /rendezvous
```

## Cleanup

```bash
docker compose -p keyflip-fleet-sim -f docker-compose.yml down -v
```

`down -v` removes the named volume too. Without `-v`, the encrypted state survives and the next run
would start from a stale fleet — the script always starts from `down -v` for that reason.

## Troubleshooting

**`permission denied` writing `/rendezvous`** — the named volume was recreated outside the script
and is root-owned. Re-run the script (it chowns the volume), or:
`docker run --rm -u root -v keyflip-fleet-sim_fleet-rendezvous:/rendezvous keyflip-fleet-sim chown -R keyflip:keyflip /rendezvous`

**`no such image: keyflip-fleet-sim`** — run `docker compose -p keyflip-fleet-sim -f docker-compose.yml build`
first, or just use `run-simulation.sh`, which builds before starting.

**A check fails and containers stay** — inspect with the commands above, then remove with
`docker compose -p keyflip-fleet-sim -f docker-compose.yml down -v`.

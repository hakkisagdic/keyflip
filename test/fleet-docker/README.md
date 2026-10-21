# Fleet Docker Simulation

Real multi-machine fleet coordination test using Docker containers.

## What This Tests

Unlike the unit tests in `test/fleet.test.js` which mock multiple machines in a single process, this simulation runs **actual separate containers** that coordinate through a shared rendezvous volume, testing:

1. **Real cross-process communication** - Each machine is a separate container with its own filesystem
2. **Encrypted file exchange** - Files written to shared volume are encrypted via `sync.encrypt()`
3. **Fleet protocol** - Status publishing, command queuing, and account distribution
4. **Multi-machine topology** - 3 machines (A, B, C) simulating real-world deployment

## Prerequisites

- Docker Desktop installed and running
- Docker Compose v2+ (`docker compose` or `docker-compose`)

## Quick Start

```bash
# Run the full simulation
cd test/fleet-docker
./run-simulation.sh

# Or run interactively to inspect containers
./run-simulation.sh --interactive
```

## Manual Testing

Once containers are running:

```bash
# Access any machine
docker exec -it fleet-machine-a sh

# Inside container, try fleet commands
cd /keyflip
node bin/keyflip.js fleet status
node bin/keyflip.js fleet init --dir /rendezvous --passphrase my-secret
```

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Machine A   │     │ Machine B   │     │ Machine C   │
│ (initiator) │     │ (joiner)    │     │ (joiner)    │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           │
                  ┌────────▼────────┐
                  │ Shared Volume   │
                  │ (rendezvous)    │
                  │                 │
                  │ Encrypted files │
                  │ *.status.enc    │
                  │ *.cmd.enc       │
                  └─────────────────┘
```

Each container:
- Runs Alpine Linux with Node.js 20
- Mounts the keyflip codebase read-only at `/keyflip`
- Has isolated HOME directory (`/tmp/keyflip-home`)
- Shares the `fleet-rendezvous` volume for coordination

## Test Scenarios

The simulation validates:

1. ✅ Fleet initialization on Machine A
2. ✅ Machine B and C joining the fleet
3. ✅ Cross-machine status visibility
4. ✅ Encrypted file creation in rendezvous volume
5. ✅ Existing fleet test suite passing in containerized environment

## Troubleshooting

### Containers won't start
```bash
docker-compose logs machine-a
docker-compose logs machine-b
```

### Rendezvous volume empty
Normal initially - files appear when machines publish status or send commands.

### Permission errors
The Dockerfile creates a `keyflip` user (UID 1000). Ensure your host system can access the mounted volumes.

## Cleanup

```bash
# Stop and remove containers + volumes
docker-compose down -v

# Remove images
docker-compose down --rmi all
```

## Why Docker?

The existing fleet tests use `makeCtx()` to simulate multiple machines in-memory. While good for unit testing, they can't verify:

- Real filesystem isolation between machines
- Actual encrypted file I/O across a shared directory
- Network-level coordination (future: LAN multicast)
- Race conditions in concurrent file access

Docker provides true process isolation while remaining reproducible and fast to spin up.

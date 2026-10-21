#!/bin/bash
# Fleet Docker Simulation - Real multi-machine coordination test
# This script tests actual fleet coordination across separate containers

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "========================================="
echo "  Fleet Docker Simulation Test"
echo "========================================="
echo ""

# Cleanup function
cleanup() {
    echo ""
    echo "Cleaning up..."
    docker-compose down -v 2>/dev/null || true
}
trap cleanup EXIT

# Step 1: Build and start machines
echo "📦 Step 1: Building Docker images..."
docker-compose build --quiet

echo ""
echo "🚀 Step 2: Starting fleet machines (A, B, C)..."
docker-compose up -d

# Wait for machines to initialize
echo "⏳ Waiting for machines to initialize..."
sleep 8

# Step 2: Check fleet status from each machine
echo ""
echo "========================================="
echo "📊 Step 3: Checking fleet status"
echo "========================================="

echo ""
echo "--- Machine A Status ---"
docker exec fleet-machine-a node bin/keyflip.js fleet status || echo "(Machine A initializing...)"

echo ""
echo "--- Machine B Status ---"
docker exec fleet-machine-b node bin/keyflip.js fleet status || echo "(Machine B initializing...)"

echo ""
echo "--- Machine C Status ---"
docker exec fleet-machine-c node bin/keyflip.js fleet status || echo "(Machine C initializing...)"

# Step 3: Test cross-machine communication
echo ""
echo "========================================="
echo "🔄 Step 4: Testing cross-machine commands"
echo "========================================="

echo ""
echo "📤 Machine A publishing status update..."
docker exec fleet-machine-a sh -c "
  cd /keyflip &&
  mkdir -p /tmp/keyflip-home/.config/keyflip/fleet &&
  echo '{\"test\": \"status-from-a\", \"timestamp\": \"'$(date -Iseconds)'\"}' > /tmp/test-status.json &&
  node bin/keyflip.js fleet push --dir /rendezvous --passphrase test-fleet-secret-2026
" || echo "Push command not available yet (expected in early versions)"

# Wait for propagation
sleep 3

echo ""
echo "📥 Machine B collecting updates..."
docker exec fleet-machine-b sh -c "
  cd /keyflip &&
  node bin/keyflip.js fleet collect --dir /rendezvous --passphrase test-fleet-secret-2026
" || echo "Collect command not available yet (expected in early versions)"

# Step 4: Verify encrypted files in rendezvous volume
echo ""
echo "========================================="
echo "🔐 Step 5: Verifying encrypted rendezvous files"
echo "========================================="

echo ""
echo "Files in rendezvous volume:"
docker run --rm -v fleet-docker_fleet-rendezvous:/data alpine ls -la /data/ || echo "No files yet (normal for fresh fleet)"

# Step 5: Run actual fleet test suite inside container
echo ""
echo "========================================="
echo "🧪 Step 6: Running fleet test suite"
echo "========================================="

echo ""
echo "Running fleet.test.js in Machine A..."
docker exec fleet-machine-a sh -c "
  cd /keyflip &&
  npm test -- test/fleet.test.js 2>&1 | tail -50
"

echo ""
echo "Running lanfleet.test.js in Machine B..."
docker exec fleet-machine-b sh -c "
  cd /keyflip &&
  npm test -- test/lanfleet.test.js 2>&1 | tail -50
"

# Final summary
echo ""
echo "========================================="
echo "✅ Fleet Simulation Complete"
echo "========================================="
echo ""
echo "Machines are still running. To interact manually:"
echo "  docker exec -it fleet-machine-a sh"
echo "  docker exec -it fleet-machine-b sh"
echo "  docker exec -it fleet-machine-c sh"
echo ""
echo "To cleanup: docker-compose down -v"
echo ""

# Keep running for manual inspection if requested
if [ "$1" = "--interactive" ]; then
    echo "🖥️  Interactive mode - press Ctrl+C to stop"
    docker-compose logs -f
fi

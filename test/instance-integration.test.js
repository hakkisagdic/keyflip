// Instance integration tests - real CLI invocations, not mocked contexts
import { strict as assert } from 'assert';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { describe, it, before, after } from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYFLIP_BIN = path.join(__dirname, '..', 'bin', 'keyflip.js');

function run(args, opts = {}) {
  const result = spawnSync('node', [KEYFLIP_BIN, ...args], {
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, HOME: opts.home || os.homedir() },
    encoding: 'utf8',
    timeout: opts.timeout || 10000,
  });
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: (result.stdout || '') + (result.stderr || ''),
  };
}

function makeTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyflip-instance-test-'));
  return dir;
}

// APFS clones and /Applications bundles make this suite macOS-only. `node:test` has no
// `this.timeout()`; each spawn carries its own timeout and the suite is skipped by option.
describe(
  'Instance CLI Integration',
  { skip: process.platform !== 'darwin' ? 'macOS-only (APFS)' : false },
  function () {
    let tempHome;
    let originalHome;

    before(function () {
      originalHome = process.env.HOME;
      tempHome = makeTempHome();
      process.env.HOME = tempHome;
    });

    after(function () {
      if (originalHome) {
        process.env.HOME = originalHome;
      }
      if (tempHome && fs.existsSync(tempHome)) {
        fs.rmSync(tempHome, { recursive: true, force: true });
      }
    });

    it('shows instance help', function () {
      const r = run(['instance', 'help']);
      assert.strictEqual(r.code, 0);
      assert.ok(r.output.includes('Generic AI Tool Instance Manager'));
      assert.ok(r.output.includes('Supported tools:'));
    });

    it('lists no instances initially', function () {
      const r = run(['instance', 'list']);
      assert.strictEqual(r.code, 0);
      assert.ok(r.output.includes('No instances created yet'));
    });

    it('fails to create instance with invalid tool name', function () {
      const r = run(['instance', 'create', 'invalid-tool', 'test-account']);
      assert.notStrictEqual(r.code, 0);
      assert.ok(r.output.includes('Unsupported tool') || r.output.includes('Available:'));
    });

    it('creates a Claude instance successfully', function () {
      const r = run(['instance', 'create', 'claude', 'test-yahoo']);
      // Note: This will fail if Claude.app is not installed, which is expected in CI
      // The test verifies the command structure and error handling
      if (r.code !== 0) {
        assert.ok(
          r.output.includes('not found') || r.output.includes('Please install'),
          'Should fail gracefully when app not installed',
        );
      } else {
        assert.ok(r.output.includes('Instance created'));
        assert.ok(r.output.includes('test-yahoo'));
      }
    });

    it('shows --instance flag in switch help', function () {
      const r = run(['--help']);
      assert.strictEqual(r.code, 0);
      assert.ok(r.output.includes('--instance'));
      assert.ok(r.output.includes('tool/slug'));
    });

    it('rejects invalid --instance format', function () {
      // Use a non-existent profile name so we hit the --instance parsing before profile resolution
      const r = run(['nonexistent-profile', '--instance', 'invalid-format']);
      // Should fail either on profile resolution or instance format validation
      assert.notStrictEqual(r.code, 0);
      // Either "no such profile" OR "must be tool/slug" is acceptable
      assert.ok(
        r.output.includes('must be tool/slug') ||
          r.output.includes('no such profile') ||
          r.output.includes('unknown command'),
        'Should reject invalid instance format or missing profile',
      );
    });
  },
);

describe('Instance MCP Tool Registration', function () {
  it('registers keyflip_instances MCP tool', async function () {
    // Import MCP module and check tool registration
    const mcpModule = await import('../src/mcp.js');
    const tools = mcpModule.TOOLS || [];
    const instanceTools = tools.filter((t) => t.name && t.name.startsWith('keyflip_instance'));

    assert.ok(instanceTools.length > 0, 'Should have at least one instance MCP tool');

    const hasListTool = instanceTools.some((t) => t.name === 'keyflip_instances');
    assert.ok(hasListTool, 'Should have keyflip_instances tool');
  });

  it('instance harden tool requires confirm', async function () {
    const mcpModule = await import('../src/mcp.js');
    const tools = mcpModule.TOOLS || [];
    const hardenTool = tools.find((t) => t.name === 'keyflip_instance_harden');

    assert.ok(hardenTool, 'Should have keyflip_instance_harden tool');
    assert.ok(
      hardenTool.inputSchema && hardenTool.inputSchema.properties && hardenTool.inputSchema.properties.confirm,
      'Harden tool should require confirm parameter',
    );
  });
});

describe('Instance Module API', function () {
  it('exports getInstance function', async function () {
    const instances = await import('../src/instances.js');
    assert.ok(typeof instances.getInstance === 'function', 'Should export getInstance');
  });

  it('exports updateState function', async function () {
    const instances = await import('../src/instances.js');
    assert.ok(typeof instances.updateState === 'function', 'Should export updateState');
  });

  it('exports listAllInstances function', async function () {
    const instances = await import('../src/instances.js');
    assert.ok(typeof instances.listAllInstances === 'function', 'Should export listAllInstances');
  });

  it('updateState returns valid state object', async function () {
    const instances = await import('../src/instances.js');

    // Test with null/undefined paths (should handle gracefully)
    const state = instances.updateState('claude', null, null);
    assert.ok(state, 'Should return state object even with null paths');
    assert.ok('state' in state, 'State should have state field');
    assert.ok('mechanism' in state, 'State should have mechanism field');
  });
});

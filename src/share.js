'use strict';
// #11 keyflip:// share URLs — paste-to-import for provider (and account-pointer)
// configs. Format mirrors cc-switch's wire format:
//   keyflip://v1/import?resource=<provider|account>&name=<n>&config=<base64url JSON>
// Importing ALWAYS shows a decoded preview and requires confirmation (the caller
// does the prompt); links that carry a key are secrets.
const provider = require('./provider');
const profiles = require('./profiles');

function b64urlEncode(str) {
  return Buffer.from(str, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 ? '='.repeat(4 - (str.length % 4)) : '';
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

// Build a share URL for a provider or account.
function build(ctx, resource, name, opts) {
  opts = opts || {};
  let config;
  if (resource === 'provider') {
    const m = provider.read(ctx, name);
    if (!m) throw new Error("no such provider: '" + name + "'");
    config = { baseUrl: m.baseUrl, authScheme: m.authScheme, models: m.models || {}, endpointCandidates: m.endpointCandidates || [] };
    if (!opts.noSecrets) {
      let key = null; try { key = ctx.store.getProfile('provider__' + name); } catch (e) { key = null; }
      if (key) config.key = key;
    }
  } else if (resource === 'account') {
    const meta = profiles.read(ctx.configDir, name);
    if (!meta) throw new Error("no such account: '" + name + "'");
    // Never ship the OAuth token in a URL — account share is pointer-only.
    config = { email: meta.email || '', oauthAccount: meta.oauthAccount || {} };
  } else {
    throw new Error('resource must be provider|account');
  }
  return 'keyflip://v1/import?resource=' + resource + '&name=' + encodeURIComponent(name) + '&config=' + b64urlEncode(JSON.stringify(config));
}

// Parse a share URL into { resource, name, config } — throws on anything invalid.
function parse(url) {
  const m = /^keyflip:\/\/v1\/import\?(.+)$/.exec(String(url).trim());
  if (!m) throw new Error('not a keyflip://v1 import link');
  const params = {};
  m[1].split('&').forEach(function (kv) { const i = kv.indexOf('='); params[decodeURIComponent(kv.slice(0, i))] = kv.slice(i + 1); });
  if (['provider', 'account'].indexOf(params.resource) === -1) throw new Error('unsupported resource: ' + params.resource);
  if (!params.name) throw new Error('missing name');
  let config;
  try { config = JSON.parse(b64urlDecode(params.config || '')); } catch (e) { throw new Error('config payload is not valid'); }
  return { resource: params.resource, name: decodeURIComponent(params.name), config: config };
}

// Human preview (secrets redacted) for the confirmation prompt.
function preview(parsed) {
  const c = Object.assign({}, parsed.config);
  if (c.key) c.key = '***' + String(c.key).slice(-4);
  return parsed.resource + ' "' + parsed.name + '"\n' + JSON.stringify(c, null, 2);
}

// Apply an already-parsed+confirmed import.
function apply(ctx, parsed) {
  if (parsed.resource === 'provider') {
    const c = parsed.config;
    if (!c.baseUrl) throw new Error('provider link has no baseUrl');
    provider.add(ctx, parsed.name, { baseUrl: c.baseUrl, authScheme: c.authScheme, key: c.key || null, models: c.models || {}, endpointCandidates: c.endpointCandidates || [] });
    return { resource: 'provider', name: parsed.name };
  }
  // account pointer: create metadata only (no token — the user logs in / re-adds)
  if (!profiles.isValidName(parsed.name)) throw new Error("invalid account name: '" + parsed.name + "'");
  profiles.write(ctx.configDir, { name: parsed.name, email: (parsed.config.email || ''), oauthAccount: parsed.config.oauthAccount || {}, importedAt: ctx.now() });
  return { resource: 'account', name: parsed.name, note: 'pointer only — log into this account and run `keyflip add` to capture its credential' };
}

module.exports = { build: build, parse: parse, preview: preview, apply: apply, b64urlEncode: b64urlEncode, b64urlDecode: b64urlDecode };

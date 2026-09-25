import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildJsonPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';
import { toolPluginMetadataSymbol } from 'openclaw/plugin-sdk/tool-plugin';
import plugin from '../dist/index.js';

const manifest = JSON.parse(await readFile(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
const metadata = plugin[toolPluginMetadataSymbol];
const authoredSchema = buildJsonPluginConfigSchema(manifest.configSchema);
const metadataSchema = buildJsonPluginConfigSchema(metadata.configSchema);
const schemas = [plugin.configSchema, authoredSchema, metadataSchema];

// The entry helper defaults to an empty runtime schema unless explicitly supplied.
// The plugin builder independently consumes metadata, so check both authoring paths.
test('runtime, authored manifest and generated metadata retain identical config validation', () => {
  assert.deepEqual(plugin.configSchema.jsonSchema, manifest.configSchema);
  assert.deepEqual(metadata.configSchema, manifest.configSchema);
});

const project = { projectId: 'fixture', canonicalRoot: '/fixture/project' };
const valid = [
  ['defaults', {}],
  ['current deployed config', { webUi: { enabled: true } }],
  ['disabled web host', { webUi: { enabled: false } }],
  ['minimum port and package root', { webUi: { packageRoot: '/fixture/gsd', port: 1 } }],
  ['maximum port', { webUi: { port: 65535 } }],
  ['empty embedded policy', { embeddedProjects: {} }],
  ['explicit empty approved list', { embeddedProjects: { adminOnly: true, projects: [] } }],
  ['explicit approved project policy', { embeddedProjects: { adminOnly: false, projects: [project] } }],
  ['combined config', { webUi: { enabled: true, port: 33277 }, embeddedProjects: { projects: [project] } }],
];
const invalid = [
  ['unknown root property', { surprise: true }],
  ['non-object webUi', { webUi: true }],
  ['unknown webUi property', { webUi: { surprise: true } }],
  ['non-boolean enabled', { webUi: { enabled: 'true' } }],
  ['empty package root', { webUi: { packageRoot: '' } }],
  ['non-string package root', { webUi: { packageRoot: 1 } }],
  ['zero port', { webUi: { port: 0 } }],
  ['out-of-range port', { webUi: { port: 65536 } }],
  ['fractional port', { webUi: { port: 33277.5 } }],
  ['string port', { webUi: { port: '33277' } }],
  ['null embedded policy', { embeddedProjects: null }],
  ['unknown policy property', { embeddedProjects: { surprise: true } }],
  ['non-boolean adminOnly', { embeddedProjects: { adminOnly: 'false' } }],
  ['non-array projects', { embeddedProjects: { projects: project } }],
  ['null project', { embeddedProjects: { projects: [null] } }],
  ['missing project ID', { embeddedProjects: { projects: [{ canonicalRoot: '/fixture' }] } }],
  ['missing canonical root', { embeddedProjects: { projects: [{ projectId: 'fixture' }] } }],
  ['empty project ID', { embeddedProjects: { projects: [{ ...project, projectId: '' }] } }],
  ['empty canonical root', { embeddedProjects: { projects: [{ ...project, canonicalRoot: '' }] } }],
  ['non-string project ID', { embeddedProjects: { projects: [{ ...project, projectId: 1 }] } }],
  ['non-string canonical root', { embeddedProjects: { projects: [{ ...project, canonicalRoot: 1 }] } }],
  ['unknown project property', { embeddedProjects: { projects: [{ ...project, allowAll: true }] } }],
];

for (const [name, config] of valid) {
  test(`config accepts ${name}`, () => {
    for (const schema of schemas) {
      const result = schema.safeParse(structuredClone(config));
      assert.equal(result.success, true, JSON.stringify(result));
    }
  });
}
for (const [name, config] of invalid) {
  test(`config rejects ${name}`, () => {
    for (const schema of schemas) assert.equal(schema.safeParse(structuredClone(config)).success, false);
  });
}

// Optional final-artifact check after the supported plugins builder has run.
if (process.env.GSD_STAGED_PLUGIN_MANIFEST) {
  test('built manifest preserves the authored config schema', async () => {
    const built = JSON.parse(await readFile(process.env.GSD_STAGED_PLUGIN_MANIFEST, 'utf8'));
    assert.deepEqual(built.configSchema, manifest.configSchema);
  });
}

import { describe, expect, it } from 'vitest';
import {
  addOpenCodeNpmPluginReference,
  removeOpenCodeNpmPluginReference,
} from '../../src/services/integrations/OpenCodeInstaller';

// The OpenCode rework (commit fa143465) switched plugin registration from
// file-path refs (./plugins/light-mem.js) to npm-style refs ("light-mem") and
// made the config-writing functions private (they write to the global
// ~/.config/opencode dir). The remaining public, side-effect-free surface is
// the two reference-list transforms below; these tests cover their semantics
// including the versioned-entry ("light-mem@x.y.z") handling the rework added.
describe('OpenCode installer plugin-reference transforms', () => {
  it('adds the npm plugin ref to an existing plugin array, preserving siblings', () => {
    const config = addOpenCodeNpmPluginReference({
      plugin: ['context-mode'],
      mcp: { context7: { enabled: true } },
    });

    expect(config.plugin).toEqual(['context-mode', 'light-mem']);
    expect(config.mcp).toEqual({ context7: { enabled: true } });
  });

  it('does not duplicate an existing light-mem plugin reference', () => {
    const config = addOpenCodeNpmPluginReference({
      plugin: ['context-mode', 'light-mem'],
    });

    expect(config.plugin).toEqual(['context-mode', 'light-mem']);
  });

  it('treats a version-pinned light-mem entry as already present', () => {
    const config = addOpenCodeNpmPluginReference({
      plugin: ['light-mem@1.2.3'],
    });

    expect(config.plugin).toEqual(['light-mem@1.2.3']);
  });

  it('normalizes a single-string plugin entry into an array when adding', () => {
    const config = addOpenCodeNpmPluginReference({
      plugin: 'context-mode',
    });

    expect(config.plugin).toEqual(['context-mode', 'light-mem']);
  });

  it('adds the plugin ref when no plugin field exists yet', () => {
    const config = addOpenCodeNpmPluginReference({
      $schema: 'https://opencode.ai/config.json',
    });

    expect(config.$schema).toBe('https://opencode.ai/config.json');
    expect(config.plugin).toEqual(['light-mem']);
  });

  it('removes only the light-mem ref, preserving other fields', () => {
    const config = removeOpenCodeNpmPluginReference({
      plugin: ['context-mode', 'light-mem'],
      provider: { openai: { models: {} } },
    });

    expect(config.plugin).toEqual(['context-mode']);
    expect(config.provider).toEqual({ openai: { models: {} } });
  });

  it('removes a version-pinned light-mem entry too', () => {
    const config = removeOpenCodeNpmPluginReference({
      plugin: ['light-mem@2.0.0', 'context-mode'],
    });

    expect(config.plugin).toEqual(['context-mode']);
  });
});

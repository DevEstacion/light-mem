import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  SAMPLE_CONFIG,
  expandHomePath,
  loadTranscriptWatchConfig,
  writeSampleConfig,
} from '../../src/services/transcripts/config.js';

describe('transcript watcher config', () => {
  it('does not auto-watch any transcripts in the sample config', () => {
    expect(SAMPLE_CONFIG.watches).toEqual([]);
  });

  it('expandHomePath replaces leading ~ with homedir', () => {
    const result = expandHomePath('~/.light-mem/something');
    expect(result).toBe(join(homedir(), '.light-mem/something'));
  });

  it('expandHomePath passes through absolute paths unchanged', () => {
    expect(expandHomePath('/absolute/path')).toBe('/absolute/path');
  });

  it('expandHomePath passes through empty string unchanged', () => {
    expect(expandHomePath('')).toBe('');
  });

  it('writeSampleConfig writes a parseable config file', () => {
    const tmpDir = mkdtempSync(join(require('os').tmpdir(), 'light-mem-config-'));
    const configPath = join(tmpDir, 'transcript-watch.json');
    try {
      writeSampleConfig(configPath);
      expect(existsSync(configPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(parsed).toHaveProperty('watches');
      expect(parsed.version).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('loadTranscriptWatchConfig reads back a written config', () => {
    const tmpDir = mkdtempSync(join(require('os').tmpdir(), 'light-mem-config-'));
    const configPath = join(tmpDir, 'transcript-watch.json');
    try {
      writeSampleConfig(configPath);
      const loaded = loadTranscriptWatchConfig(configPath);
      expect(loaded.version).toBe(1);
      expect(Array.isArray(loaded.watches)).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('loadTranscriptWatchConfig throws for missing file', () => {
    expect(() => loadTranscriptWatchConfig('/nonexistent/path/config.json')).toThrow();
  });
});

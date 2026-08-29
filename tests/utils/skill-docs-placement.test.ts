import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const SKILLS_DIR = join(import.meta.dirname, '../../plugin/skills');

describe('skill docs placement (#1651)', () => {
  it('smart-search/SKILL.md contains Language Support section', () => {
    const path = join(SKILLS_DIR, 'smart-search/SKILL.md');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');

    expect(content).toContain('Language Support');
    expect(content).toContain('tree-sitter');
  });

  it('smart-search/SKILL.md lists bundled languages', () => {
    const content = readFileSync(join(SKILLS_DIR, 'smart-search/SKILL.md'), 'utf-8');

    const expectedLanguages = [
      'JavaScript',
      'TypeScript',
      'TSX / JSX',
      'Python',
      'Go',
      'Rust',
      'Ruby',
      'Java',
      'C',
      'C++',
    ];

    for (const language of expectedLanguages) {
      expect(content).toContain(language);
    }

    expect(content).toContain('Files with unrecognized extensions are parsed as plain text');
  });
});

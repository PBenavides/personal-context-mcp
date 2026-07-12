import { parseNote } from './frontmatter.js';

describe('parseNote', () => {
  it('splits frontmatter from body and parses the YAML', () => {
    const { frontmatter, body } = parseNote('---\ncategory: Goal\nsalience: 0.9\n---\n\n# Title\n');
    expect(frontmatter).toEqual({ category: 'Goal', salience: 0.9 });
    // The delimiter regex swallows trailing blank space after the closing ---.
    expect(body).toBe('# Title\n');
  });

  it('returns the whole text as body when there is no frontmatter', () => {
    const { frontmatter, body } = parseNote('# Just a note\n');
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Just a note\n');
  });

  it('degrades gracefully on unparseable frontmatter', () => {
    const text = '---\nkey: [unclosed\n---\nbody';
    const { frontmatter, body } = parseNote(text);
    expect(frontmatter).toEqual({});
    expect(body).toBe(text);
  });
});

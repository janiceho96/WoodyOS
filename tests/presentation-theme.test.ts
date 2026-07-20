import { describe, expect, it } from 'vitest';
import { themeFromDesignMarkdown } from '../src/presentations/theme.js';

describe('presentation theme parser', () => {
  it('maps an explicit style family to a distinct safe theme', () => {
    const theme = themeFromDesignMarkdown(`
## Deck style
- Style: minimal-light

## Typography
- Headings: Arial
- Body font: Arial
`);
    expect(theme.style).toBe('minimal-light');
    expect(theme.background).toBe('#FAFAFC');
    expect(theme.headingFont).toBe('Arial');
  });

  it('recognizes friendly style aliases and explicit colour overrides', () => {
    const theme = themeFromDesignMarkdown(`
Style: investor
- Background: #101010
- Primary: #FF00AA
`);
    expect(theme.style).toBe('investor-pitch');
    expect(theme.background).toBe('#101010');
    expect(theme.primary).toBe('#FF00AA');
  });
});

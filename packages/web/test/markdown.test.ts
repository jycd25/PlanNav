import { describe, it, expect } from 'vitest';
import { markdownToHtml } from '../src/chat/markdown.js';

describe('markdownToHtml', () => {
  it('renders bold, italics, inline code, and line breaks', () => {
    expect(markdownToHtml('Planned **4 blocks** from _09:15_ with `must_do`.\nNext line')).toBe('<p>Planned <strong>4 blocks</strong> from <em>09:15</em> with <code>must_do</code>.<br>Next line</p>');
  });
  it('renders bullet and numbered lists and paragraphs', () => {
    expect(markdownToHtml('Two things:\n\n- **Hours:** 07:00 to 13:00\n- Grouping: mornings\n\n1. first\n2. second')).toBe(
      '<p>Two things:</p><ul><li><strong>Hours:</strong> 07:00 to 13:00</li><li>Grouping: mornings</li></ul><ol><li>first</li><li>second</li></ol>');
  });
  it('escapes html so imported titles cannot inject markup', () => {
    expect(markdownToHtml('Added <script>alert(1)</script> & "Dentist"')).toBe('<p>Added &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Dentist&quot;</p>');
  });
  it('turns headings into bold lines and keeps empty input empty', () => {
    expect(markdownToHtml('### Routine\ntext')).toBe('<p><strong>Routine</strong><br>text</p>');
    expect(markdownToHtml('')).toBe('');
  });
});

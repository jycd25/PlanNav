import { describe, it, expect } from 'vitest';
import { markdownToHtml } from '../src/chat/markdown.js';

describe('markdownToHtml: lists', () => {
  it('flattens an indented (nested) list into one flat list', () => {
    expect(markdownToHtml('- a\n  - b\n    - c\n- d')).toBe('<ul><li>a</li><li>b</li><li>c</li><li>d</li></ul>');
  });
  it('switches list kind when bullets and numbers alternate, closing the previous list each time', () => {
    expect(markdownToHtml('- a\n1. b\n- c')).toBe('<ul><li>a</li></ul><ol><li>b</li></ol><ul><li>c</li></ul>');
  });
  it('accepts *, • and "1)" markers, and multi-digit numbers', () => {
    expect(markdownToHtml('* a\n• b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(markdownToHtml('1) one\n10. ten')).toBe('<ol><li>one</li><li>ten</li></ol>');
  });
  it('a marker without a following space is plain text', () => {
    expect(markdownToHtml('-item\n1.item')).toBe('<p>-item<br>1.item</p>');
  });
  it('a paragraph directly after a list closes the list; a blank line between lists keeps them separate', () => {
    expect(markdownToHtml('- a\ntext')).toBe('<ul><li>a</li></ul><p>text</p>');
    expect(markdownToHtml('- a\n\n- b')).toBe('<ul><li>a</li></ul><ul><li>b</li></ul>');
  });
  it('applies inline markup inside list items', () => {
    expect(markdownToHtml('- **Hours:** `09:00` to _13:00_')).toBe('<ul><li><strong>Hours:</strong> <code>09:00</code> to <em>13:00</em></li></ul>');
  });
});

describe('markdownToHtml: links and code', () => {
  it('does not turn markdown links or bare URLs into anchors; it escapes them as text', () => {
    expect(markdownToHtml('[docs](https://example.com/a?b=1&c=2)')).toBe('<p>[docs](https://example.com/a?b=1&amp;c=2)</p>');
    expect(markdownToHtml('see https://example.com/x_y_z')).toBe('<p>see https://example.com/x_y_z</p>');
  });
  it('escapes markup inside inline code and leaves single asterisks and underscores in code alone', () => {
    expect(markdownToHtml('`<b>`')).toBe('<p><code>&lt;b&gt;</code></p>');
    expect(markdownToHtml('`a*b*c`')).toBe('<p><code>a*b*c</code></p>');
    expect(markdownToHtml('`must_do_x`')).toBe('<p><code>must_do_x</code></p>');
  });
  it('an unclosed backtick stays literal', () => {
    expect(markdownToHtml('a `b c')).toBe('<p>a `b c</p>');
  });
  it('an empty code span (two backticks) stays literal', () => {
    expect(markdownToHtml('``')).toBe('<p>``</p>');
  });
});

describe('markdownToHtml: HTML injection is always escaped', () => {
  it('escapes tags, attributes and quotes wherever they appear', () => {
    expect(markdownToHtml('<img src=x onerror="alert(1)">')).toBe('<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>');
    expect(markdownToHtml('**<b>x</b>**')).toBe('<p><strong>&lt;b&gt;x&lt;/b&gt;</strong></p>');
    expect(markdownToHtml('- <li>evil</li>')).toBe('<ul><li>&lt;li&gt;evil&lt;/li&gt;</li></ul>');
    expect(markdownToHtml('# <script>')).toBe('<p><strong>&lt;script&gt;</strong></p>');
  });
  it('escapes an ampersand even when it already looks like an entity', () => {
    expect(markdownToHtml('&lt;script&gt;')).toBe('<p>&amp;lt;script&amp;gt;</p>');
  });
  it('leaves single quotes alone (they cannot break out of the text nodes it produces)', () => {
    expect(markdownToHtml("it's")).toBe("<p>it's</p>");
  });
});

describe('markdownToHtml: empty and whitespace input', () => {
  it('returns an empty string for empty, newline-only and whitespace-only input', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml('\n')).toBe('');
    expect(markdownToHtml('  \n\n  \t ')).toBe('');
  });
  it('trims trailing spaces on a line and treats CRLF as a line break', () => {
    expect(markdownToHtml('a   \r\nb')).toBe('<p>a<br>b</p>');
    expect(markdownToHtml('a   \n   \nb')).toBe('<p>a</p><p>b</p>');
  });
  it('collapses several blank lines into one paragraph break', () => {
    expect(markdownToHtml('a\n\n\n\nb')).toBe('<p>a</p><p>b</p>');
  });
});

describe('markdownToHtml: headings and emphasis edges', () => {
  it('a bare "#" or seven hashes is not a heading', () => {
    expect(markdownToHtml('#')).toBe('<p>#</p>');
    expect(markdownToHtml('####### seven')).toBe('<p>####### seven</p>');
    expect(markdownToHtml('###### six')).toBe('<p><strong>six</strong></p>');
  });
  it('a heading in the middle of text becomes a bold line within the paragraph', () => {
    expect(markdownToHtml('before\n## Mid\nafter')).toBe('<p>before<br><strong>Mid</strong><br>after</p>');
  });
  it('double underscores are not bold and intraword underscores are not italics', () => {
    expect(markdownToHtml('__x__')).toBe('<p>__x__</p>');
    expect(markdownToHtml('snake_case_name')).toBe('<p>snake_case_name</p>');
  });
  it('bold inside italics and italics inside bold both render', () => {
    expect(markdownToHtml('*a **b** c*')).toBe('<p><em>a <strong>b</strong> c</em></p>');
  });
  it('an unclosed bold marker stays literal', () => {
    expect(markdownToHtml('**open')).toBe('<p>**open</p>');
  });
});

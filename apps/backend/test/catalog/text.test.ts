import { describe, expect, it } from 'vitest';
import { htmlToPlainText } from '../../src/modules/catalog/text';

describe('htmlToPlainText', () => {
  it('strips tags and turns block tags into line breaks', () => {
    const html = '<h2>Lamp</h2><p>A <strong>ceramic</strong> table lamp.</p><ul><li>Warm light</li><li>Linen shade</li></ul>';
    expect(htmlToPlainText(html, 2000)).toBe('Lamp\nA ceramic table lamp.\nWarm light\nLinen shade');
  });

  it('decodes named and numeric entities once', () => {
    expect(htmlToPlainText('<p>Salt &amp; pepper &lt;set&gt; &#169; &#x2122; &nbsp;ok &amp;lt;</p>', 2000)).toBe(
      'Salt & pepper <set> © ™ ok &lt;',
    );
  });

  it('keeps unknown entities and invalid code points as they are', () => {
    expect(htmlToPlainText('&bogus; &#0; &#xD800;', 2000)).toBe('&bogus; &#0; &#xD800;');
  });

  it('drops script and style content and comments', () => {
    const html = '<style>p{color:red}</style><script>alert(1)</script><!-- hidden --><p>Visible</p>';
    expect(htmlToPlainText(html, 2000)).toBe('Visible');
  });

  it('keeps a stray less-than sign that is not a tag', () => {
    expect(htmlToPlainText('<p>Holds 5 < 6 items</p>', 2000)).toBe('Holds 5 < 6 items');
  });

  it('handles attributes that contain a greater-than sign', () => {
    expect(htmlToPlainText('<a title="a > b" href="/x">link</a> text', 2000)).toBe('link text');
  });

  it('collapses whitespace and blank lines', () => {
    expect(htmlToPlainText('<p>  one \t two  </p>\n\n\n<p></p><p></p><p>three</p>', 2000)).toBe('one two\nthree');
  });

  it('caps the text at the maximum length without splitting a surrogate pair', () => {
    const text = htmlToPlainText(`<p>${'a'.repeat(5000)}</p>`, 2000);
    expect(text).toHaveLength(2000);
    const emoji = htmlToPlainText(`<p>${'a'.repeat(1999)}\u{1F600}</p>`, 2000);
    expect(emoji).toBe('a'.repeat(1999));
  });

  it('returns an empty string for empty html', () => {
    expect(htmlToPlainText('', 2000)).toBe('');
  });
});

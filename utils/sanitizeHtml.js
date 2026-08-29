// Server-side allowlist sanitizer for rich-text bodies written with the
// shared toolbar (public/js/forum-editor.js + views/partials/forum-
// editor-toolbar.ejs) - chat posts, publications, the weekly newsletter,
// announcements/notifications, and class/event descriptions. The
// client-side toolbar is a UI convenience, not a security boundary -
// this is what actually enforces which tags/styles survive, since any
// request handler can be hit directly regardless of what the real editor
// produced. A real request: "chat posts should have all of these
// options for editing the text [Bold/Italic/lists/tables/colors/etc.],
// same for class details, event creation details, writing emails,
// notifications, weekly newsletter, anywhere there is text" - this
// allowlist was expanded from the original chat-only handful of tags to
// match that fuller toolbar. Deliberately still NOT unlimited: no
// <script>/<style>/<iframe>, no inline event handlers, no javascript:/
// data: URLs - see allowedSchemes/allowedSchemesByTag below.
const sanitizeHtml = require('sanitize-html');

const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'p', 'div', 'br', 'hr',
  'strong', 'em', 'u', 's', 'sub', 'sup', 'span', 'pre', 'code',
  'ul', 'ol', 'li', 'a', 'blockquote', 'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  // Checklist (toolbar's Checklist button) - a <li> holding one disabled
  // checkbox plus its label text. 'input' only ever survives in exactly
  // that shape - see exclusiveFilter below, which drops any input that
  // isn't type="checkbox" (there's nothing else a saved post could use
  // 'input' for; this was never a general form-control allowance).
  'input',
  // Video embed (toolbar's Insert Video button). Allowing <iframe> at all
  // is the one real exception to this file's own "no iframe" rule, so
  // it's deliberately narrow: allowedIframeHostnames below strips the src
  // off anything that isn't YouTube/Vimeo's own embed hosts, and the
  // exclusiveFilter drops the iframe entirely once its src is gone -
  // never a blank/broken iframe sitting in the saved HTML, and never an
  // iframe pointed anywhere else on the web.
  'iframe',
];

// youtube-nocookie.com is YouTube's own privacy-enhanced embed host (no
// tracking cookies until playback starts) - offered by the toolbar's
// Insert Video prompt alongside the regular embed URL, both accepted here.
const ALLOWED_IFRAME_HOSTNAMES = ['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com'];

// Only the handful of CSS properties the toolbar's Styles/Font/Size/
// Colors/Align/Direction controls actually produce - never an open
// `style` attribute, which is its own injection surface (background-
// image: url(...), position: fixed overlays, etc.).
const SAFE_STYLES = {
  color: [/^#(?:[0-9a-fA-F]{3}){1,2}$/, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/, /^[a-zA-Z]+$/],
  'background-color': [/^#(?:[0-9a-fA-F]{3}){1,2}$/, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/, /^[a-zA-Z]+$/],
  'text-align': [/^(left|right|center|justify)$/],
  'font-family': [/^[a-zA-Z0-9,\-'" ]+$/],
  'font-size': [/^(xx-small|x-small|small|medium|large|x-large|xx-large|[0-9]+(px|pt|em|%))$/],
  'text-decoration': [/^(underline|line-through|none)$/],
};

const ALLOWED_ATTRIBUTES = {
  a: ['href'],
  img: ['src', 'alt'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
  p: ['style', 'dir'],
  div: ['style', 'dir'],
  span: ['style', 'dir'],
  h1: ['style', 'dir'],
  h2: ['style', 'dir'],
  h3: ['style', 'dir'],
  h4: ['style', 'dir'],
  li: ['style', 'dir'],
  blockquote: ['style', 'dir'],
  input: ['type', 'checked', 'disabled'],
  iframe: ['src', 'width', 'height', 'title', 'allow', 'allowfullscreen', 'frameborder', 'sandbox'],
};

const ALLOWED_STYLES = { '*': SAFE_STYLES };

function sanitizePostBody(html) {
  return sanitizeHtml(html || '', {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedStyles: ALLOWED_STYLES,
    // Only ever let a link point somewhere a click can safely follow -
    // no javascript:, data:, or similar. Images are URL-only (the
    // toolbar's Insert Image just prompts for a link, there's no
    // upload), so an <img src> gets the same http(s)-only treatment.
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
    // Strips the src off any <iframe> not pointed at one of these three
    // known embed hosts (see ALLOWED_TAGS's own comment on 'iframe') -
    // the exclusiveFilter below then drops the whole tag once its src is
    // gone, rather than leaving a blank iframe behind.
    allowedIframeHostnames: ALLOWED_IFRAME_HOSTNAMES,
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
      // Forces the same safe sandbox/frameborder regardless of what the
      // client-side toolbar sent - consistent output, and immune to a
      // request built by hand rather than through the real editor.
      iframe: sanitizeHtml.simpleTransform('iframe', { frameborder: '0', sandbox: 'allow-scripts allow-same-origin allow-presentation' }),
      // A checklist checkbox is a read-only visual marker of the
      // author's own checked/unchecked state, never a live control
      // someone else's click could flip - forced disabled regardless of
      // what was sent, same reasoning as iframe's own forced attributes.
      input: sanitizeHtml.simpleTransform('input', { disabled: 'disabled' }),
    },
    exclusiveFilter: function (frame) {
      if (frame.tag === 'iframe') return !frame.attribs.src;
      if (frame.tag === 'input') return frame.attribs.type !== 'checkbox';
      return false;
    },
  }).trim();
}

module.exports = { sanitizePostBody, ALLOWED_TAGS };

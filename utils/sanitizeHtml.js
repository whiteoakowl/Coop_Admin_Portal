// Server-side allowlist sanitizer for forum post bodies (Community &
// Commerce track, item 6). The client-side rich-text toolbar (public/js/
// forum-editor.js) only ever offers a handful of safe formatting options,
// but that's a UI convenience, not a security boundary - this is what
// actually enforces it, since any request handler can be hit directly
// regardless of what the real editor produced.
const sanitizeHtml = require('sanitize-html');

const ALLOWED_TAGS = ['h2', 'h3', 'p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'a', 'blockquote'];

function sanitizePostBody(html) {
  return sanitizeHtml(html || '', {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href'] },
    // Only ever let a link point somewhere a click can safely follow -
    // no javascript:, data:, or similar.
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
    },
  }).trim();
}

module.exports = { sanitizePostBody, ALLOWED_TAGS };

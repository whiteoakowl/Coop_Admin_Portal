// Mechanical enforcement for two conventions public/css/styles.css's own
// header comment already documents by hand - this exists so a future
// edit that drifts from either one fails `npm run lint:css` instead of
// only being caught (or not) by someone noticing on review.
module.exports = {
  rules: {
    // Breakpoint scale (see the header comment in styles.css for the
    // full reasoning): @media max-width/min-width may only use one of
    // the 4 canonical values, or one of the pre-existing ad hoc ones
    // grandfathered in below. This blocks any *new* one-off breakpoint
    // from being added, without requiring every legacy value to be
    // migrated in one pass - see styles.css's comment for why those are
    // left for opportunistic migration instead of a bulk edit.
    'media-feature-name-value-allowed-list': {
      'max-width': [
        // canonical scale
        '640px', '860px', '1100px', '1400px',
        // grandfathered ad hoc values, not yet migrated
        '480px', '500px', '720px', '760px', '800px', '900px',
      ],
      'min-width': ['640px', '860px', '1100px', '1400px'],
    },

    // Color-semantic convention: never re-type one of the palette's own
    // hex values as a literal outside :root (styles.css's :root block is
    // explicitly exempted via a stylelint-disable comment around it,
    // since that's the one place these values are meant to be spelled
    // out) - use the matching var(--token) instead, the same way every
    // other usage in the file already does. Deliberately scoped to only
    // the palette's own hex strings, not "no hex colors anywhere" - the
    // file also has a number of legitimate one-off hex values (mostly
    // hand-picked :hover shades a touch darker than their base color)
    // that were never meant to be design-system tokens and shouldn't be
    // forced into becoming one just to satisfy this rule.
    'declaration-property-value-disallowed-list': {
      '/^(color|background|background-color|border-color|fill|stroke)$/': [
        '/^#(4682B4|79baec|2e6da4|1f4e7a|eaf4fd|E7AA7B|C49068|16a34a|dcfce7|85BB65|6fa350|dc2626|fee2e2|a16207|fef9c3|eab308|b25a17|fde8d2|6d4a99|55397a|f1ecfb|C38EC7|ad72b1)$/i',
      ],
    },
  },
};

# Student Portal > Pets - real images

Each file here is one whole pre-rendered "pet look," referenced by
`utils/pets.js`'s own `PET_LOOKS` catalog (the `image` field). All eleven
are the user's own full reference images, resized to 1000px wide
(preserving the original 2000x1294 aspect ratio) and converted to WebP -
un-cropped, so the whole scene/background is shown rather than just the
pet. `.pet-stage-frame--photo`/`.pet-display-photo` in styles.css uses
`object-fit: contain` with a matching `aspect-ratio` so the full image
always fits the frame instead of being cropped, and the frame itself
just shrinks on small screens (`width: min(420px, 92vw)`).

## Current files

- `cat_black.webp` - black cat sitting on the green rug
- `cat_orange.webp` - orange tabby kitten sitting on the tan rug
- `dog.webp` - golden retriever with the blue paw-print bandana
- `rabbit.webp` - white rabbit with the pink ear bow
- `dragon.webp` - green dragon
- `hamster.webp` - hamster/guinea pig
- `husky.webp` - husky with the blue collar tag
- `turtle.webp` - turtle wearing a green cap
- `chicken.webp` - chicken with a checkered bow tie
- `lizard.webp` - lizard with a red bandana
- `panda.webp` - panda with a green bamboo-leaf bandana

Every look in `PET_LOOKS` now has a real image - the `svg` field on each
entry is unused dead weight at this point (kept only because
`getPetForMember`/the customize page still read `look.image` first and
fall back to `look.svg` if it's ever unset), not a currently-reachable
code path.

## Adding another look

1. Drop a file in here named `<key>.webp` - resize to 1000px wide,
   preserving whatever aspect ratio the source image has (no crop -
   `object-fit: contain` handles any ratio, though matching the existing
   2000x1294 ~1.546:1 ratio keeps every card the same shape).
2. Add a new entry to `PET_LOOKS` in `utils/pets.js` with
   `image: '/images/pets/<key>.webp'`.

That's the whole change - no other code needs to know.

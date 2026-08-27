# Background pool

Drop wallpapers in here. The pipeline never downloads images - you choose them,
it rotates them.

    players/    hook slide + every numbered slide (a player, a face, a trophy)
    stadiums/   the CTA slide only (a wide, calm shot the copy can sit on)

Anything jpg/png/webp works. Portrait is ideal; landscape gets centre-cropped to
9:16, so avoid shots where the subject is far off to one side.

Aim for at least 20 in `players/` and 6 in `stadiums/` - the renderer refuses to
repeat a background inside one carousel and tries not to reuse one within
`backgrounds.cooldownDays` (config.json), and it can only honour that with a
pool bigger than a single post.

`node slideshow.mjs doctor` prints how many are in each pool and
how many have never been used.

Both folders are gitignored. They live on this machine only.

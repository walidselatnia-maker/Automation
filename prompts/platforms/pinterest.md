---
platform: pinterest
label: Pinterest
post_label: Pin
fields: headline, cta, title, description, alt
post_text: description
alt_field: alt
picture_shape: PORTRAIT_3_4
picture_templates: newsite-pin-1.template.txt, newsite-pin-2.template.txt, newsite-pin-3.template.txt, newsite-pin-4.template.txt
link: pin_link
---
# Pinterest rules

These rules decide what the sharing phase makes for a Pinterest channel, after
the article is published. Everything comes from that article: its keyword, focus
keyword, title, description, headings, text and picture descriptions. Nothing is
added that the article does not say.

## What goes out per article

- One pin per article, on each Pinterest channel the website shares on.
- Sent through the channel's Buffer account.
- The pin's link is the published article. The link is never written in the
  pin's words: the pin carries it as its own link.

## The pin's words

Pinterest is a search engine: people find pins by the words in the title and
description.

- Headline: the words printed ON the pin picture. The dish or topic people
  search for, plain and strong. No punctuation at the end, no emoji.
- Call to action: a tiny line printed on the pin, like "Save for Later" or
  "Try It Tonight". No emoji.
- Title: written for search, with the focus keyword near the start. No
  clickbait, no all-caps words, no exclamation marks.
- Description: two or three short, specific sentences: what it is, what makes
  it worth making or reading, who it is for. Use the focus keyword once and one
  or two related searches naturally. Plain words, no hashtags.
- Alt text: what the pin picture shows.
- Never a link, a web address, a domain name or "link in bio" in any of these.
- Never generic phrases such as "mouth-watering", "delve", "game-changer",
  "look no further", "you won't believe".
- Stay true to the article: no ingredient, claim or number it does not have.

## The pin picture

- Made by Google Flow, in a 3:4 portrait frame (896 x 1200), the closest Flow
  gets to Pinterest's 2:3.
- Its own picture, not one of the article's pictures. The scene comes from the
  article's own picture descriptions (the feature and close-up pictures).
- Made from one of four Pinterest templates, used one after another per
  channel. Each template prints the headline, the call to action and the
  website's domain on the picture.

## The board

- The AI picks the board per keyword, from the boards on the channel's
  Pinterest account (read through Buffer).

## When it goes out

- After the article is published. A full Buffer queue makes the pin wait about
  12 hours and try again; it is never skipped.

## Limits

The platform checks every pin against these numbers before it is sent. An answer
outside them goes back to the AI with the exact problem to fix.

- headline_words: 2-6
- cta_words: 2-4
- title_chars: 40-100
- title_exclamations: 0-0
- description_chars: 150-450
- description_hashtags: 0-0
- alt_words: 8-20

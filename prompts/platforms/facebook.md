---
platform: facebook
label: Facebook
post_label: Image post
fields: text, alt
post_text: text
alt_field: alt
picture_shape: PORTRAIT_3_4
picture_templates: newsite-fb-1.template.txt
link: first_comment
---
# Facebook rules

These rules decide what the sharing phase makes for a Facebook channel (a page), after the article is published. Everything comes from that article: its keyword, focus keyword, title, description, headings, text and picture descriptions. Nothing is added that the article does not say.

## What goes out per article

- One image post per article, on each Facebook page the website shares on, when the page is set to post image posts.
- One reel per article, on each page set to post reels, as soon as the article's reel is made (the same video goes to every channel that takes reels). Its words follow these same rules, written for the video.
- Through the Facebook API, or through Buffer, as the channel was set up.
- The link to the article is never in the post. It is always the first comment.
- Through the Facebook API: the link is posted as the first comment right after the post.
- Through Buffer with the Facebook API set for the first comment: Buffer posts, then the link is commented through the Facebook Graph API as soon as the post is out.
- Through Buffer on a paid plan: the link is Buffer's first comment.
- Through Buffer on the free plan with no API comment: there is no first comment, so the post goes out with no link at all.

## The post's words

- Two to four short sentences. Start with a hook that makes people stop: a specific detail, a small surprise or a question about the dish or topic.
- Warm and friendly, like a person who made it, in plain everyday words, in the website's author voice.
- End by pointing to the comment, for example "Full recipe in the first comment." or "The how-to is in the first comment."
- Never a link, a web address or a domain name in the post.
- No hashtags.
- Never generic phrases such as "mouth-watering", "delve", "game-changer", "look no further", "you won't believe".
- Stay true to the article: no ingredient, claim or number it does not have.
- Alt text: what the post picture shows, for people who cannot see it.

## The post picture

- Made by Google Flow for Facebook: its own picture, not one of the article's pictures.
- Portrait, 3:4 (896 x 1200), the closest Flow gets to Facebook's 4:5 feed size.
- No words, logos or watermarks on the picture.
- The scene comes from the article's own picture descriptions (the feature and close-up pictures), so it shows exactly what the article is about.

## When it goes out

- After the article is published. A full Buffer queue makes the post wait about 12 hours and try again; it is never skipped.

## Limits

The platform checks every post against these numbers before it is sent. An answer outside them goes back to the AI with the exact problem to fix.

- text_chars: 80-500
- text_emoji: 0-2
- text_hashtags: 0-0
- alt_words: 8-20

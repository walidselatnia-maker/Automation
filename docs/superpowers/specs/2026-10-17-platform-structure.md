# Platform structure (new dashboard)

The platform is organized in the order the work is done. Every feature has one home.

| Menu | Page | What it is for |
|---|---|---|
| Start here | `/new-website/home` | What the platform does, the six steps from a fresh install to shared posts, where each stands, the next action, and anything that stopped |
| 1 · Set up | Platform settings `/new-website/platform` | AI key, pictures, time zone, notifications. Automation timings are under Advanced |
| | Websites `/new-website` | Each website: a summary (topic, voice, publishing, channels), links to its articles, posts and reels; all settings on demand |
| | Social channels `/new-website/channels` | Social accounts, added once; each website picks which ones it shares on |
| 2 · Create | Keywords & articles `/new-website/keywords` | Main keywords by website; each opens the step-by-step pipeline (SEO → … → Publish → Share) |
| | Reels `/new-website/sharing/reels` | One reel per article, made centrally, then sent to the channels its website takes reels on |
| 3 · Share | Social posts `/new-website/sharing` | What went out on each channel, with links and problems |

## Steps on Start here

1. Connect the platform (AI key).
2. Add your website.
3. Connect social channels (optional; then pick them in the website's settings).
4. Add keywords.
5. Articles are written and published (automatic, followable).
6. Reels and social posts go out (automatic).

A step waits for the one above it. The first step still to do is marked "Do this next".

## Layout rules

- The content area is up to 1360px wide, with even gutters. Wizards are up to 980px wide; the keyword pipeline uses the full width.
- Card grids use `minmax(min(100%, 360px), 1fr)`, so cards are never squeezed.
- Every page starts with the same header: title, a plain-language line on what it is for, and its one main action on the right.
- Overview pages show essentials. Details open on demand: website settings, the image model, and Advanced automation.
- Deeper pages have a breadcrumb back to their section: Social posts › website › channel, and Keywords & articles › keyword.

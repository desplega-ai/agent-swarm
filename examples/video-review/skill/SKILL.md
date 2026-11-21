---
name: video-review-loop
description: Run review rounds on a video cut with a human reviewer. Use when you edit or render a video for a person and they give feedback on it. Read it before you show a render, when a feedback export from the Video Review page arrives, and when a comment asks for options.
---

# Review rounds on a video

How a video goes from a first cut to an approved one. We learned this on a 78-second film: 8 versions in one night
and one morning. The reviewer is the person who decides if the cut is good.

## The loop

1. **Align before you build.** Ask the decisions that change the build, in sets of at most four, each with a
   recommendation: the voice, the picture source, the script version, the build order.
2. **Stills first.** Show the text pieces (cards, tags, end card, captions) as stills over real frames before any
   cut exists. A design that is wrong costs seconds on a still and minutes in a render.
3. **One act next.** Build the first 15 to 20 s completely: picture, voice, music, effects, text. Get the style
   approved on this part.
4. **Then the whole film**, act by act. Check each act on a contact sheet before the next one starts.
5. **Comments, options, picks.** The reviewer comments in the review tool. A comment that asks for options gets 2
   or 3 built options as short clips, not a description.
6. **Full size and delivery** only when the reviewer asks.

## Read a round

The reviewer leaves comments on the Video Review page (`index.html` in this folder, or
https://video-edit.agent-swarm.dev) and gives you the JSON export. The README has the format.

- Give each new cut a new file name and a new version, so its comment list starts empty. Do not overwrite a cut
  that has comments.
- Save each export next to the cut, with the version in its name.
- Draw the marks: `uv run --no-project --with pillow python -I render.py <feedback.json> [out-dir] [--video <path>]`.
  It prints the comments and writes one marked frame for each. Look at each marked frame before you read the text
  of its comment: a mark shows what the words do not.
- Answer with a table: the comment numbers, how you read them, the change. Group the comments that have one cause.
  Six comments about slow motion can be one cause and one rule.
- A comment that can mean two things gets a question, not a guess.

## Before you show a render

Run these on the file you show, not on an earlier one:

- Words: transcribe the audio and compare the words with the script. Report each difference.
- Blank frames and still spans: no black frame, and a still span of 0.5 s or more only where the film holds the
  picture on purpose (a menu, a freeze, a card).
- Loudness: about -14 LUFS, true peak not above -1 dB (`ffmpeg -i <file> -af ebur128=peak=true -f null -`).
- The text rules of the reviewer. When the reviewer bans something in the text on screen, make the build stop on
  it. Do not rely on your memory of the rule.
- A contact sheet at 2 frames each second, read by you.
- At a join that the reviewer reported: a strip of the 12 frames around it.

Say what you cannot check. You cannot hear: the tone of the voice, the music and the sound effects are for the
ears of the reviewer. Write that in the message each time.

## How to present

- Start with the result and attach a preview at half size. Give the full size as a link.
- One list of what changed, one list of what you checked, one list of what is open.
- A choice is one question with your recommendation. Show what the reviewer must see before you ask.
- Options: one short clip for each option (5 to 15 s around the moment), one frame of every option side by side,
  and your pick with one reason. Build an option as a setting, so the pick becomes the default with one edit.
- Do not hide a limit. "The end card is 7 s, not 5.5 s, because the three lines need 6 s of speech."

## Versions and files

- Name each full render with its version. Keep the newest and the one before it. Delete older renders, raw renders
  and contact sheets.
- Write one entry in a decision log for each round: the ask, the decisions, the output, what is open.
- Upload and commit only when the reviewer asks.

## Subagents

- One agent at a time on one cut. Two agents that edit the same files break the render of each other.
- A good brief has: the goal in one sentence, the context files, the taste of the reviewer so far as a list, a
  timeline table (line, picture, text and sound), the limits for paid calls, the verification steps, and the shape
  of the report.
- Give the words of the reviewer for each comment. Do not give only your reading of them.
- Judge the result yourself: read the contact sheets and run the checks again before you show anything.

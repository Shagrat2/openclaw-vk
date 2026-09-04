# Proposal: let a TTS provider return a reply in more than one piece

## The problem

The core calls the speech provider once per reply and waits no longer than
`messages.tts.timeoutMs`, whose schema maximum is 120 000 ms. A local synthesizer
runs at roughly 0.04–0.15 seconds per character, so one call fits about 800–2500
characters. Anything longer has to be cut before synthesis, and the rest of the
answer is never spoken.

That is a limit of the TTS contract, not of any one channel. Every channel that
supports voice hits it the same way.

## What this plugin does today, and why it is the wrong layer

`@openclaw-vk/vk` works around it outside the contract: the TTS command
synthesizes the head, returns it, and keeps synthesizing the tail in the
background into a directory of parts (`manifest.json` plus `partNN.opus`). The
channel then scans that directory, matches a directory to the head audio **by its
duration** (±1.5 s), claims it exclusively, and sends the parts as follow-up
voice messages.

It works — long spoken replies arrive whole — but the mechanism is a file-system
side channel between a user's TTS script and one channel, keyed on a duration
coincidence. It cannot be discovered from the config, other channels cannot reuse
it, and it depends on a local script that no upstream user has.

## What would fix it in the right place

Let a speech provider return a continuation, and let the core deliver it:

```ts
type SpeechResult = {
  audio: SpeechAudio;
  /** More audio for the same reply, delivered in order as it becomes ready. */
  continuation?: AsyncIterable<SpeechAudio>;
};
```

The core already owns everything else that is needed: it knows the channel, the
reply, and how to deliver several media in one turn. With the continuation in the
contract:

- the duration-matching heuristic disappears — the parts are tied to the reply by
  reference, not by coincidence;
- `messages.tts.timeoutMs` bounds the *first* piece rather than the whole answer,
  which is what the timeout is actually for;
- channels stop needing to know that a long answer arrives in pieces at all;
- the same behaviour becomes available to Telegram, Discord and the rest.

A narrower version would also solve it: allow the provider to return an array of
audio files and have the core deliver them in order. That loses streaming — the
last piece has to be ready before the first is sent — but it removes the side
channel.

## What we would do

If the contract grows a continuation, this plugin drops `src/tts-parts.ts` and
the claim logic in `src/send.ts` — roughly 300 lines — and keeps only the part
that is genuinely channel-specific: splitting one audio file at silence when it
exceeds VK's per-message limit.

Happy to implement the core side if the shape above is acceptable.

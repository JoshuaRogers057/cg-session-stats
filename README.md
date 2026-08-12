# Champions Guild Session Stats

Tracks per-character combat and d20 statistics across a play session in Foundry VTT, and exports them as a single CSV.

## Requirements

| | |
|---|---|
| Foundry VTT | v13 (verified 13.351) |
| Game system | dnd5e 5.3.x |
| Modules | [Midi-QOL](https://gitlab.com/tposney/midi-qol) and socketlib (both required) |

The module refuses to initialize on any other system and reports a clear error if Midi-QOL or socketlib is missing.

## Installation

In Foundry: **Add-on Modules → Install Module**, then paste this manifest URL:

```
https://github.com/JoshuaRogers057/cg-session-stats/releases/latest/download/module.json
```

## Usage

Three GM-only controls sit below the chat message box:

- **Start Session** — pick tonight's roster and begin recording
- **End Session** — stop recording and unlock export
- **Open Report** — the report window; the badge shows how many entries need your input

A session is a manually bounded recording window. Starting one refuses to discard unexported data from a previous session without asking first.

### What gets recorded

**d20 rolls** — attack rolls, saving throws (including death and concentration saves), ability/skill/tool checks, and initiative. Only the raw die face is stored, never modifiers or totals: the point is comparing how well people rolled, not how strong their builds are. On advantage or disadvantage every die is kept, flagged with which one counted, so the report can separate true luck from effective luck.

**HP changes** — damage dealt and taken, healing given and received, temp HP granted, deaths, and attacks avoided. Effective amounts only: overkill and overhealing are discarded. Damage absorbed by temp HP counts as damage taken. Rest and hit-dice healing are excluded entirely. Summons and familiars roll up to their summoner, and wild shape merges back into the base character.

### Resolving the queues

Some events can't be classified automatically, and rather than interrupt play they collect in the report window for the GM to settle whenever convenient:

- **Unresolved attribution** — HP changes with no identifiable source, such as traps, environmental damage, or manual adjustments. Damage *taken* is always accurate regardless; only damage *dealt* depends on resolving these.
- **Unresolved pass/fail** — dnd5e sets no target DC on ability, skill, or tool checks, so the system never reports whether they succeeded. Mark each **Pass**, **Fail**, or **N/A** to leave it out of pass-rate stats.

The queues update live. The stat tables refresh only when you open the window or press refresh, so they never move under you mid-read.

## Export

**Export CSV** becomes available once the session has ended. It produces one stacked file with five blocks — session info, attack rolls, saving throws, ability checks, initiative, and combat totals — with NPC rows after PC rows in each block.

## Settings

- **Allow Players to View Report** (default off) — lets players open a read-only report
- **Debug Logging** — logs dropped and suppressed events to the console

## Notes

PCs appear as individual rows keyed on actor UUID, so renaming someone mid-session doesn't split them into two rows. NPCs aggregate by name — six unlinked goblins are one "Goblin" row — and are hidden behind the **NPCs** checkbox by default.

Recording is driven from whichever client performs a roll, but only the GM's client ever writes data, so nothing is double-counted with several players connected.

# Session Stats - Champions Guild

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

Two GM-only controls sit below the chat message box:

- **Start Session** — name the session and begin recording
- **Open Report** — the report window; the badge shows how many entries need your input

**End Session** lives in the report window header rather than beside the chat box, and asks for confirmation: a stray click there would otherwise stop recording mid-game with nothing to undo it. If you forget to press it, the session ends by itself after 3 hours with no rolls (see Settings).

A session is a manually bounded recording window. Starting one asks only for a name and whether it is a **Champions Guild game** (ticked by default; untick it for a game not run for the guild) — there is no roster to pick. Every character is tracked, and each appears in the report once they have actually rolled or been involved in something, so a late arrival needs no setup and nobody is silently excluded.

Starting also refuses to discard unexported data from a previous session without asking first, and quietly carries in anything from the last minute, so the first roll or two never go missing if you hit Start a few seconds late. If you forget entirely, the module offers to start one for you once players are connected and rolling — see Settings.

### What gets recorded

**d20 rolls** — attack rolls, saving throws (including death and concentration saves), ability/skill/tool checks, and initiative. The report compares raw die faces only: the point is how well people rolled, not how strong their builds are. On advantage or disadvantage every die is kept, flagged with which one counted, so the report can separate true luck from effective luck. Each roll also stores its bonus and, when known, the DC or the target's AC, which the Champions Guild website uses to work out how likely each roll was to succeed.

**HP changes** — damage dealt and taken, biggest single blow each way, healing given and received, temp HP granted, times downed, kills, attacks received, and attacks avoided. Effective amounts only: overkill and overhealing are discarded. Damage absorbed by temp HP counts as damage taken. Rest and hit-dice healing are excluded entirely. Summons and familiars roll up to their summoner, and wild shape merges back into the base character.

"Downed" counts how often a character was reduced to 0 HP; the same event credits a kill to whoever landed it. Friendly fire is excluded from kills, damage dealt, and biggest hit dealt, but still counts as damage taken by the recipient. "Attacks received" counts attacks that targeted a character, hit or miss; "attacks avoided" counts the ones that missed.

"Max Dealt" and "Max Taken" record the biggest single blow each way. A blow is damage to one creature from one action, so an area spell hitting three targets counts as three separate blows rather than one large one.

**Who took part** — each character's class and subclass, total level, armor class, and the player who owns them; each NPC's CR and XP. This is captured the first time they appear in a session, so a character who levels up at the end of the night is recorded at the level they played.

**Fights** — every combat is a fight of its own. Each event is credited to the fight it happened in, and each fight records its rounds, everyone in it, and the enemy side (hostile combatants). A combatant who never acts still counts, as a zero, so per-fight averages aren't inflated. A combat only counts once it is started or its turn moves during the session, so one left running from an earlier game never claims new events, and one whose turn hasn't moved for 30 minutes stops collecting them.

**For fight balance** (used by the Champions Guild website, not shown in the report) — each combatant's HP, max and temp HP when they join a fight and after every change; combatants removed from a running fight (a dead monster's token cleared off the map is recorded with its HP and the round before it disappears); PC deaths (a third failed death save or the Dead condition); stat-block edits made during a fight (max HP, AC, CR, abilities, bonuses, or an item's attack, damage or save); a lasting mark on HP changes made by hand rather than by Midi; consumables used, and consumable counts that drop with no use; and which monsters have legendary actions or a lair. All of it is automatic.

### The report window

Six tabs — **Party**, **Attacks**, **Saves**, **Checks**, **Initiative**, and **Combat**. Party lists who took part: player, level, class and subclass, and AC for each PC; CR, AC and how many there were for each NPC name. The four roll tabs show roll counts, mean kept die, mean of all dice, natural 20s and 1s, and pass/fail totals; Combat shows the HP and kill columns, plus damage per round (damage dealt in fights over the rounds of the fights the character was in) and attacks received. A picker on the Combat tab shows one fight at a time. Any column header re-sorts. The Saves tab can exclude death and concentration saves from its pass rate.

An **NPCs** checkbox adds aggregated monster rows. PCs and NPCs are listed as separate blocks rather than interleaved by score, so the party is always read as a group. The Combat tab also carries a **Party Total** row covering the PCs only — sums for the running totals, but the *best* single blow rather than a sum for the two Max columns.

### Resolving the queues

Some events can't be classified automatically, and rather than interrupt play they collect in the report window for the GM to settle whenever convenient:

- **Unresolved attribution** — HP changes with no identifiable source, such as traps, environmental damage, or manual adjustments. Assign a character to credit them, or pick one of:
  - **Manual adjustment** — it really happened but nobody gets credit (a trap, falling, the environment). Still counts as damage taken or healing received.
  - **Not tracked (correction)** — you were fixing an HP value rather than recording something that happened in play. Counts towards nothing at all, not even damage taken or the downed count.
- **Unresolved pass/fail** — dnd5e sets no target DC on ability, skill, or tool checks, so the system never reports whether they succeeded. Mark each **Pass**, **Fail**, or **N/A** to leave it out of pass-rate stats.

The queues update live. The stat tables refresh only when you open the window or press refresh, so they never move under you mid-read.

## Export

**Export CSV** becomes available once the session has ended. It produces one stacked file of blocks: session info, party, fights, per fight, combat totals, attack rolls, saving throws, ability checks, and initiative, with NPC rows after PC rows in each block.

**Per Fight** has one row per character per fight, and is the one to analyse: each row carries the character's player, level, class, subclass, CR and AC, and the fight's rounds, party size, average party level and enemy CR and XP, so it can be filtered or pivoted without looking anything up elsewhere. The stat blocks carry the same identity columns, appended after their original columns so anything already reading the CSV keeps working.

## Sharing with the Champions Guild

When a session ends, Session Stats sends it to the Champions Guild website, where only guild admins can see it. The website rebuilds the report's tables from it, checks how well its Adventure Builder balanced each fight, links the session to the guild quest it belongs to, and suggests fill-in players and consumables used when the DM closes out the quest. There is nothing to set up and no account to create. The first time the module runs in a world it tells the GM, who can turn sharing off in the module settings.

What is sent: the session and world names, the Foundry server's address, the GM's Foundry name, player and character names, classes, levels, monster stats (CR, AC, HP), every recorded roll and HP change, stat edits made during fights, and consumables used. Nothing else about the world is sent. The upload key is built into the module (`UPLOAD_KEY` in `scripts/constants.mjs`); the website limits uploads per address and checks each one, so it doesn't need to be secret. If a session can't be sent (no internet, or the GM was logged out when it auto-ended), it is kept and sent at the next login, or within half an hour while the GM stays connected. A session that has been sent counts as exported, so starting the next one doesn't warn about it.

## Settings

- **Allow Players to View Report** (default on) — gives players a **Session Report** button at the top of their **Journal** sidebar tab, showing the stat tables only. Both queues are hidden from them, along with End Session and Export, so players never see entries still waiting on the GM. Takes effect immediately; no reload needed. Turn it off if you'd rather keep the stats to yourself.
- **Remind Me to Start a Session** (default 2 players) — offers to start a session once this many players are connected and one of them makes a roll. Your own rolls never trigger it, so testing before the game stays quiet. The prompt offers **Start Session**, **Pause 1 Hour** (useful when testing with players already on — it will remind you again when the real session starts), and **Not Now**, which stays quiet until reload. Set to 0 to turn it off.
- **Auto-End After Hours Without a Roll** (default 3) — ends the recording once nobody has made a d20 roll for this many hours. If the GM's browser was closed at the time, it ends as soon as the GM logs back in. The end time is set to the last thing recorded, so the idle stretch doesn't inflate the session's length, and a notice tells you it happened. Raise it for long roleplay-only stretches, or set it to 0 to turn it off.
- **Share Stats with the Champions Guild** (default on) — sends each finished session for balance research, as described above. Turning it off also drops anything not yet sent.
- **Debug Logging** — logs dropped and suppressed events to the console

## License

[MIT](LICENSE)

## Notes

PCs appear as individual rows keyed on actor UUID, so renaming someone mid-session doesn't split them into two rows. NPCs aggregate by name — six unlinked goblins are one "Goblin" row — and are hidden behind the **NPCs** checkbox by default.

Recording is driven from whichever client performs a roll, but only the GM's client ever writes data, so nothing is double-counted with several players connected.

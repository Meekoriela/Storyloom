# Changelog

Important changes to this project. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semver](https://semver.org/).

> **Division of labor with Release notes**: each release's notes are **auto-generated from commits** ("Added / Fixed") and are the exact record of that release; this file is a **manually curated history** that merges related changes and adds context. Both share the same source — everyday commits only need to follow the commit-message convention.

> Chinese original: [CHANGELOG.md](CHANGELOG.md). **English is provided for convenience; the Chinese text is authoritative.**

---

## [0.1.41] — 2026-10-05

### Added

- **Long text fields gain one shared two-state form (a single component, wired into seven places)**: when editing the character description, note content, world-entry content, author style guide, rule content, skill instructions or system prompt, the collapsed state is a **four-line read-only preview that always starts from the first line**, and only the expanded state becomes an editable field (capped at 320 dp, scrolling inside when longer), with the height difference animated; one arrow at the end of the label row handles both directions. The collapsed state deliberately avoids a height-clamped editable input, because a multiline field with pre-filled long text scrolls itself to the end on open and lands you on the last paragraph. These seven places previously had their own implementations — four clamped, three not — and the shapes did not match
- **Three new skills fill three gaps in the method layer**: **anti-cliche generation** (drafting stage: list the 3-5 "statistical-centre solutions" a model defaults to, then push alternatives along five moves, judged by "does this element know which story it is in"; an alternative must pass the fertility test — can it grow 2-3 new scenes or relationship complications on its own); **chapter finalization** (after the first draft of a chapter is complete: three revision layers strictly large to small, six passes each looking for exactly one class of problem, consequences computed before editing, acceptance by the CA1-CA8 table, and only the 3-5 highest-impact issues reported at a time); **drafting blockers** (when the writing stalls: first decide whether the cause is "blocked" or "revising while drafting" — the two call for opposite handling — then locate which of the six blockers applies and return a measurable target for the next session). The library was previously diagnosis-heavy: nothing covered trope avoidance at generation time, and nothing covered revision order or acceptance
- **Beat-sheet writing gains five weighted passes and a hard gate**: scene rhythm 35 / character arc 25 / de-cliché 15 / dialogue 15 / prose 10. **If scene rhythm fails, the chapter does not enter the assembly stage**, whatever the total; four dispositions follow (≥80 accept / 60-79 targeted fix / 40-59 rewrite the chapter / <40 discard and re-plan the beat sheet). Also added: iteration caps (50 per chapter; **stop when two consecutive rounds improve by less than 10%**) and three carried-over contexts for the next chapter (character voice, unresolved threads, cliches already avoided)
- **Continuity audit gains "compute the consequences before editing"**: it previously only answered "where is it wrong". It now covers the blast radius, the choice between back-editing and forward-patching, the two ways to resolve a conflict (submit one side, or keep both and amend the rule), and the write-off requirement — a fix that is not written off will be reported again by the next audit
- **De-AI-flavor gains a quantification step before touching the text, plus one hard precondition**: five measures (sentence-length distribution, passive-voice ratio, adverb density, filter words, sentence-opening variation) used to locate problems, then classified into six prose states; **no sentence-level diagnosis or rewriting before the structure is repaired** — two independent sources state this precondition, and models are most inclined to polish sentences while the structure is still unsettled
- **De-AI-flavor · narrative architecture gains a cultural-texture ratio**: recognizable 40% / inferable 40% / inscrutable 20%, adjustable by genre and by position in the scene. **Leave 20% unresolvable** — explain every puzzle and the reader concludes the world has been fully mapped
- **Worldbuilding gains oblique worldbuilding**: world information is delivered by a limited recorder rather than by the narrator (position / what they must believe / lens / what they cannot afford to see), with three distance bands and the fixed blind spots of seven document types. Example: algorithmic monitoring is presented through an internal company newsletter spotlight ("efficiency up 23%, everyone is happier") — the monitoring is thereby rendered as a benefit
- **Genre playbook switches framework**: the primary framework moves from six market labels to **eleven element genres** (Wonder / Idea / Adventure / Horror / Mystery / Thriller / Humor / Relationship / Drama / Issue / Ensemble), each with the emotion the reader expects and its required setting / character / plot. The original six are kept as second-level market labels — **select material by label, validate by contract, and the contract wins when the two disagree**; "science fiction", "fantasy" and "history" are now explicitly settings rather than genres

### Fixed

- **The run trace is now three levels deep, and consecutive tool calls form one group**: each call previously took its own row, so reading one assistant message showed only "which hands this turn moved", scattered. Now the first level is the group header, the second is "reasoning" or "completed · N items", and the third is the individual call; all three levels are carried by indentation alone, one step of 8 (node left edges 0 / 8 / 16, text 22 / 26 / 34), with no lines drawn; the three node markers each have one job (level one a larger solid dot, level two a small solid dot, level three a hollow ring, with the node also reporting status). Level two does not collapse — a turn has exactly one collapse, the group header's, and one more arrow means one more "nothing happened when I tapped it"
- **The "input" label in the run trace is now "parameters"**: it was never user input, it is the parameters of that call
- **Parameters and results now use a monospaced font**: monospacing makes the indentation and alignment themselves say "this is data, not prose"; no background, no lines
- **The dots and body text in the assistant run view were spaced inconsistently**: the group-header node's centre moved +13 → +7
- **Bottom navigation was too narrow and its icons sat on the screen's bottom edge**: bar height 44 → 56, top padding 2 → 14 — all 12 new dp go above the icons
- **The top bar did not sit left**: the graphic's left edge lands at 16 and the title's at 48; the entry container is narrowed to 32 with a left hitSlop restoring the 44 dp touch target
- **The same model appeared twice in the model picker**: the top row showed the current default model's name and the list below listed that same model again. The model currently in use is now represented by the top row alone, and the list carries only the candidates; the filter keys on "whichever is actually in use", so changing the default is followed automatically next time the sheet opens
- **The subtitle "for the current conversation only"**: it contradicted the actual behaviour of a single global model, so it is removed; the title's type size matches every other sheet (`sheetTitle` is always 18 / 700, independent of whether a subtitle exists)
- **Model-related wording unified on "default"**: three places across the settings and assistant screens. The settings screen had earlier been changed to "global" without authorisation; this release also re-aligns it — settings screen, assistant screen, `llm/selection.ts` and the style library now agree
- **Changing the model in settings did not carry over to the assistant screen**: every conversation used to store its own model ID; all of them now use the current model, so a change takes effect everywhere immediately, including on conversations already in progress
- **Opening the assistant screen created a new conversation automatically**: creation points went from four to two (first chat and the drawer button only) — tapping the input, typing, tapping a suggestion chip, switching works and opening an unchatted work no longer create anything; the first message and the scratch project are created at the moment the first message is sent
- **The "save" button on the model capability page would spin at the wrong time**: it shared a flag with the "tick to add to library" path, so that button also spun and was disabled while a model was being added. The two now have separate flags
- **The provider row's URL did not identify the provider**: only the host was shown, so `open.bigmodel.cn` read as `openbigmodel.cn`. It now shows protocol plus host; the protocol is not hard-coded to https (local ollama and LAN relays use http, and validation already allows both)
- **Four provider names in the free-model list were not their current names**: Tencent Hunyuan → Tencent Cloud, Baidu Qianfan → Baidu AI Cloud, ModelScope Community → ModelScope, iFlytek Spark → iFlytek
- **The OpenRouter default-model hint pointed at a stealth preview model**: it now points at `openrouter/free` (OpenRouter's own free router, 200k context, tool use)
- **The trigger-conditions block showed a slab of grey after expansion**: the expanded area carried a `surfaceMuted` background with corner radius and padding, and being inside the same form as the fields above it read as a separate card. Only block spacing remains
- **The style "use" control was inert**: disabled text now greys out and a hint below the row reads "open a work from the shelf first"; the border and green background added to that row without authorisation have been removed
- **A dead "request timeout" read in the advanced settings section**: that section has no interface for this setting, so both the state and the write were unused and are removed. "Model request timeout" on the connection screen is untouched and behaviour is unchanged

### Trade-offs

- **All three levels of the run trace are carried by indentation, with no lines drawn**: vertical rules and elbow lines were tried for the vertical threading and left the nodes and text too cramped to read as levels; one step is now 8 rather than 12 or 20 — a step only means "move in a little", and pushing the third level too far right leaves a message looking empty
- **Level two "completed · N items" does not collapse**: a turn has exactly one collapse, at the group header. Collapsing level two as well would add an arrow and another "nothing happened when I tapped it"; each row's own node reports its state, and that row only reports the group's result
- **The collapsed state of a long text field is a read-only preview, not a clamped input**: this is the shared form for all seven wiring points. A clamped multiline field on Android scrolls itself to the cursor (the end) when pre-filled with long text, so it opens on the last paragraph
- **Skill instructions are now written in professional terminology, with no colloquial wording**: skills are read by the model, so "the user will understand it" is not the standard. Interrogatives became "criterion: can it be identified", the clue-handling clause became "record it in the clue table; no deletion", and psychological verbs were replaced with terms of that kind — 21 places in the file, with the scan list extended to 33 terms
- **The six market labels are not deleted, only demoted**: the eleven-element framework is the yardstick for validation, while the six labels are what readers actually search and recommend by; removing them would leave the selection step without a reference
- **Coaching mode and name-pool sampling are deferred and not in this release**: the former requires a runtime change (a read-only agent), and it is already known that `toolsForAgent` force-adds four write tools back, so a separate branch is needed to actually block them; the latter needs a name-pool data set and cast statistics, because an instruction alone cannot supply external entropy. Both are recorded in the to-do list
- **The input / output blocks keep no background and no border**: this was debated several times without resolution; it remains as it is and is outside this change
- **Verification before commit**: after each batch the changed files are read end to end, then type-checked and exported; the skill library goes 27 → 30 entries, the type check reports nothing, and `expo export` succeeds

---


## [0.1.40] — 2026-10-04

### Added

- **Long text fields can be expanded, and the save button is pinned to the bottom of the sheet**: for the character description, note content, world-entry content and author style guide fields, the input is capped at 320 dp and scrolls inside when longer, with an arrow at the end of the label row to expand it (tap again to collapse); "cancel / save" used to be the last row of the scrolling content, and a tall description pushed it out of sight — it now sits outside the scroll area, pinned to the sheet bottom. The field's white background, border, corner radius and font size are unchanged

### Fixed

- **The literal line down the left of a run**: the trace no longer draws the vertical rule or the elbow lines into child rows (four styles removed with it); hierarchy is carried by the node dots and the two indent levels instead — the group header sits furthest left, everything inside shifts in one step. The line was introduced to give the round a sense of vertical threading, but the nodes and indents already say that, and a solid line competes with the text
- **The "input / result" blocks in the trace were too loud**: they were a full block of muted background with rounded corners, and their left edge sat 5 dp further left than the whole group (the trunk sat at +13 and child text at +46, while these sat at +8) — 38 dp off the child text's indent. The background and corners are gone, the left edge aligns with the child text, and the gap between blocks goes 4 → 8; the "input" and "result" labels carry the separation
- **Question card title hugged the card's top edge**: that header is a 44 dp row with side padding only, no vertical padding, so an 18 sp title had nothing but its line box to sit on. It gains 12 / 8 of vertical padding and the row grows 44 → 56. The write card is wrapped in 24 dp padding, so it never hugged and is untouched
- **Skill detail would not scroll past a point and "copy as my skill" was invisible**: that panel wraps its content in one extra container with no shrink property, so the scroll area computed its height from the full content — nothing could scroll, and the buttons below were pushed outside the panel and clipped (which reads as the button having been deleted). With `flexShrink` restored the scroll works and the buttons are back in view; no other sheet has that extra layer
- **The "currently in use" row in the style library showed a slab of green**: its white background, 1 px border and corner radius were removed along with the border in an earlier "de-border" pass, while the green background had been there since the first version — with the white gone, the green sat directly on the page. Restoring background, border and radius leaves just the green check and green text
- **Bottom navigation icons sat on the screen's bottom edge**: after the bar was reduced to 44 dp the bottom padding was still 5 dp, leaving about 6 dp between the icon glyphs and the bottom edge. The bar height is unchanged; top padding goes 6 → 2 and bottom padding 5 → 12, lifting the icons about 7 dp
- **Bottom sheets still had too much space below**: the shared shell's bottom padding goes 24 → 20 dp. It is one value shared by all eleven bottom sheets; the previous release merged the two stacked paddings into one, and this trims that one down a step
- **The free-model entry that was about to expire**: OpenRouter's Space Bunny Alpha is a stealth model — the official page states it is run by a third party that chose to stay anonymous during the preview, and third-party tracking shows the free window ends at or before the model is revealed with no advance notice (median anonymity 6 days). It is replaced by `openrouter/free`, OpenRouter's own free router (200k context, tools). Qwen's qwen-turbo note now records "1M tokens per model, 90-day validity" and marks it as a limited-time allowance rather than a permanent free tier
- **Text in the note "content" field sat at the bottom**: this multiline field was missing top alignment (the character description, world-entry content and world-info description all set it), so text did not hug the top and left a large blank above
- **Avatar and cover downsampling never actually ran**: the step tried to overwrite the just-written original with a move that refuses to overwrite an existing target, so it always failed — and nobody awaited it, so the failure escaped the synchronous catch and the function always reported success. The resized image is now written to a new file, switched to only once it succeeds, and the original is removed afterwards; any failure keeps the original. The cover path's missing await (the avatar's was fixed earlier) is added too, so covers are now genuinely downsampled to 1080

### Trade-offs

- **Why the long fields cap at 320 dp**: with a sheet at 80% of the screen minus header, bottom padding and the button row, about 500 dp is usable; the four fields carry different company (the character sheet has a name field and an image row, the note sheet only a title), and 320 leaves the most room — it only clips "several thousand characters" cases, while short content stays auto-sized
- **The four fields' background, border and corner radius are untouched**: they inherit the shared input style (white, 1 px light border, 14 radius); this release only adds a height cap and an expanded state
- **The expand control is only on these four fields**: the rules / skills / agents editors in settings are full pages with the save button at the end of the page content, and skill detail is read-only text. Different in kind, so left alone
- **The bottom safety gap goes from 24 to 20 dp**: that padding doubles as the gap to the screen edge and the gesture bar, and it does not add the system inset — devices without a gesture bar look the same, devices with one will feel a step tighter than at 24
- **Why downsampling now writes a new file**: the old approach overwrote in place, so a failure halfway could delete the original without moving the new one in, losing the file for good. The new approach leaves the original untouched until the new file exists

---

## [0.1.39] — 2026-10-04

### Added

- **The assistant's run is now a tree**: one trunk runs the length of the round with nodes hanging off it (spinning while running, filled or hollow when done, a cross on failure), and the header is one row — "state + elapsed · total characters". Expanded, reasoning segments, tools, skills and questions sit in one line in true order, indented in two levels with reasoning body text aligned to the child-row text. Before, the three row types each had their own height, icon size and gap and were separated by hairlines, with the vertical rule hugging only the reasoning body, which read as a stack of bars rather than a line. It auto-collapses when the round finishes and stays open on failure; collapsed, the header row is the round's summary
- **Write confirmation and questions now float in the middle of the screen**: both cards used to sit in the conversation flow, sharing space with the reasoning trace and the streaming reply. They now float centred over a dimmed backdrop, using the project's centred-card values (48% scrim, 24 padding, 14 radius, 18 title)
- **One question per screen**: the card header reads "question N / M", you tap "next" after answering, and only the last question shows "submit". The number of questions has no upper bound (the tool schema literally says "a list of questions"), and one-per-screen keeps the card exactly one screen tall; picking "type my own answer" lifts the card with the keyboard
- **New "Request timeout" page in settings**: renamed from "Connection & advanced" (that page had neither connection nor advanced entries, so the name was wrong). It shows the current value and offers "save / restore default", validating 10000–300000 ms before saving
- **The add-provider wizard gained proper buttons**: the three step markers are now indicators only and can no longer be tapped freely (skipping left the form empty); step ① has "next" at the bottom, step ② "back / skip and use defaults", step ③ "back / save provider", and saving returns to the model page with a confirmation at the top
- **"Fetch models" now writes on tick**: ticking a model writes it to the database, the panel stays open for more ticks, the row shows a spinner then a check, and ticking twice does not create duplicates; the "add model" row now fetches that provider's list before opening the panel
- **Bottom navigation is icons only**: the four labels are gone and the bar height drops from 58 to 44, with icons centred; `title` is kept for screen readers
- **Uniform press-scale on small controls**: 64 icon buttons, round buttons and chips now scale to 0.94 and spring back, sharing the bottom navigation's parameters. List rows and cards keep the pressed-background feedback — scaling would make a whole row wobble

### Fixed

- **Books did not sit on the plank**: the plank is drawn as a single layer behind the books again, with the book's foot resting just above the plank's top edge so the plank's thickness shows fully below. Before, the plank was drawn after the book and overlapped its foot, hiding the book's bottom edge and killing the sense of depth
- **The fourth book in the grid was cut off at the screen edge**: the cell-width formula was missing the shelf row's and book area's horizontal padding (lost when the formula was rewritten). Restored, each cell is 82 → 75 dp, four books centred with 20 dp on each side
- **Spine view fixed at five per row, leaving nearly half the row empty**: rows now pack by actual spine width (8–10 per row), and the title under each spine follows that spine's own width instead of being spread evenly across the row
- **Drawer type was too large**: 14 font sizes across the three drawers each drop one step (work rows 16 → 15, volume/chapter/conversation rows 15 → 14, inline actions 15 → 14, counts 12 → 11, title 18 → 17, "temporary" 10 → 9) and icons one size; row heights and tap targets are unchanged
- **A stutter when switching works or tapping "Writing" / "Assistant"**: the full-page early return while loading is narrowed to "only on first entry, before any data exists". Any write bumped `revision` and unloaded the whole page tree, resetting the drawers', editor's and sheets' internal state along with it
- **A blank strip under bottom sheets**: 8 of the 11 sheets applied their bottom padding twice (24 dp from the sheet shell plus 24–32 dp from the content container); the caller's copy is gone and every sheet bottoms out at 24 dp
- **Skill detail text ran to both screen edges**: the 16 dp side padding is back (the sheet unification batch restored the bottom but missed the sides); the writing page's "export project" sheet also went from 8 to 16 dp of horizontal padding
- **The rules / skills / agents rows had lost their border and rounded corners**: the bordered style is restored, and the note now records that the 12 dp left padding belongs with that border (it was left over from the first bordered-card version and never tidied when the border was removed)
- **Two hairlines on the "Optional content" page, and a load-status row covering only two items**: that row is deleted (the two local-model cards carry their own installed / not-installed badges, so nothing is lost) and both local-model cards move back under the "Local models" heading — they used to render under the "Fonts & skill packs" heading
- **System dialogs across settings**: all 47 are gone — 11 completion notices became a toast under the header (auto-dismissing after 2 s), 15 errors became inline red notices, 17 destructive confirmations became centred cards (destructive button in red), and 3 export-format pickers became a three-button stacked card; one assistant-page tool-approval dialog that could never appear (its only call site always supplies the card) was removed
- **Character avatars failed no matter how many times you picked a new image**: the file copy is asynchronous but nobody waited for it, and the failure was swallowed by an empty catch, so the preview pointed at a path that did not exist and the UI looked unresponsive. The wait is added, thumbnailing uses the new file API (the two methods it used previously throw at runtime in the current SDK), the extension is sanitised, and failures show red text inside the dialog. For contrast, work covers always worked because they await a database write after the copy, which incidentally covered it
- **Models could not be added or switched**: picking one from the "fetch models" list only filled the form without writing to the database, and the "add model" row did not fetch the list first (so the panel showed the previous provider's models). The provider row's second line now shows only the host name (one entry used to be truncated while the other was complete), and preset names are unified ("Zhipu GLM" → "Zhipu")
- **Free models saved but never appeared on the model page**: saving did not refresh the model page and each save created another provider with the same name. Saving now returns to the model page, sets the model as current and reuses an existing provider with the same endpoint
- **The back gesture in the wizard jumped straight back to the settings home**: it now has the "back to model page" level, matching the top-left back button
- **Scrolling down inside an expanded reasoning trace bounced**: the trace no longer carries its own height-capped scroll box, so reasoning and prose scroll as one; with the write and question cards floating mid-screen they no longer fight the message list for the gesture either
- **Auto-collapse could yank you while you were reading history**: it now checks whether the list is at the newest end first, and does not collapse if you are not

### Trade-offs

- **Why the reasoning area lost its own scroll box**: the 340 dp cap existed so that long reasoning could not push the answer off screen, at the cost of grabbing the gesture even at the end of its scroll (which reads as "won't scroll, and bounces"). Both approaches exist in the field: Cherry Studio and assistant-ui cap and scroll the reasoning area (the former explicitly sets `overscroll-contain` to stop scrolling from escaping to the outer list), while vercel's ai-elements, prompt-kit, open-webui and lobe-chat do not cap it — reasoning and prose share one scroll, as on DeepSeek's web app. We took the latter: reasoning and prose belong together, and the outer list owns the scroll. The general defect — claiming a gesture without checking remaining scroll room — is fixed too: any nested capped scroller now claims only while it has room in that direction and hands over at the end
- **One question per screen is a behaviour change**: previously all questions were listed and submitted together; now you tap through them, in exchange for a card whose height does not grow with the number of questions
- **These two cards ignore taps on the scrim and the system back key**, unlike the app-wide "tap outside to cancel" convention: writing and answering are decided by buttons only (rejecting is really rejecting), so dismissing by tapping outside would press reject for you
- **Bottom padding is kept once, on the sheet shell**: that 24 dp is the gap between the panel and the screen's bottom edge (without it the last row touches the bottom and gets covered by the gesture bar); the caller's copy was the duplicate
- **Press-scaling applies to small controls only**: list rows and cards keep the pressed-background feedback

---

## [0.1.38] — 2026-10-03

### Added

- **Free models grouped by platform**: one card per platform, with the platform name and how many free models it has in the header; when a platform has several, you switch between them with tags inside the card (OpenRouter's four collapse from four cards into one, taking 14 models to 11 cards). The list itself was checked entry by entry: **four dead entries removed** — OpenRouter's `deepseek-chat-v3.1:free` (the ID is no longer in the catalogue), Google Gemini 2.0 Flash (shut down 2026-06-01), SiliconFlow's Qwen2.5-7B-Instruct and DeepSeek-R1-Distill-Qwen-7B (no longer on their pricing page); Agnes's model ID changed to `agnes-2.5-flash`; seven added — SiliconFlow Xing4.0-29B, Tencent Hunyuan-Lite, Baidu Qianfan ERNIE-Speed-8K, and OpenRouter's Space Bunny Alpha / Qwen3.8-27B / Ling 3.0 Flash Sante / Gemma 4 31B. Each OpenRouter entry now carries its own note (context length, where to get the key) instead of sharing one
- **Long free-model notes can be read in full**: the card gives the note its own block with no line cap; the header shows a two-line preview while collapsed, and the note is not duplicated when expanded
- **Larger drawer type**: work rows 14 → 16, volume / chapter / conversation rows 13 → 15, inline actions 13 → 15, counts 11 → 12, drawer header 17 → 18; row heights unchanged, icons one step larger

### Fixed

- **Tapping the "+" menu stuttered**: the menu was an ordinary block in the document flow, so appearing it shortened the inverted message list and reflowed every row. The menu and the input now share a positioning container, and the menu is absolutely positioned with its bottom aligned to the input's top edge, no longer taking document-flow height
- **The "+" menu greyed out the whole column**: the 5% black scrim was nearly invisible and only served to darken. Its color is gone, keeping only the tap-to-close; the menu's background also changed from pure white to the page's off-white
- **The drawer replayed its entrance when switching works**: both pages hit a loading early-return on switching, remounting the whole page including the drawer, so the entrance animation played again. When the first frame is already open it now lands in place without the 260 ms slide; opening normally is unchanged
- **Books looked pasted in front of the plank instead of sitting on it**: the plank was drawn behind the book, with its top edge meeting the book's bottom on a single line. The plank is now drawn after the book and covers it, its top edge overlapping the book's foot by about 3 dp so the book's bottom is hidden; grid and spine views use the same rule
- **Four hard bands on the spine**: the earlier four-layer stack had too much brightness difference between the middle and left bands and read as three hard edges. Now a single faint shade along the right edge (20% wide, 12% black) says light comes from the left
- **"Evolve author style" ran on a single tap**: it had no explanation and a stray tap would start a model run. It now asks first with a centered confirmation card (title, what it does, cancel / start), and runs only after you confirm

### Trade-offs

- **Deletions deserve more mention than additions in the notes**: providers retire models and this list is a local template that never refreshes itself. The entry-by-entry check date is recorded at the top of the list file
- **Switching platforms clears the input**: so a key meant for one provider is never saved to another
- **Centered-card titles unified at 18**: confirmation and input cards share one size — a step below the 22 header, a step above the 14 body

---

## [0.1.36] — 2026-10-03

### Added

- **A side drawer on both the writing page and the assistant page**: the two lines in the top-left corner open a drawer — the writing page holds "work → volume → chapter", the assistant page holds "work → conversation". Everything that used to sit in the "⋯ menu" (table of contents, switch work, conversation history, new volume / new chapter, rename, delete) now lives in the layer it belongs to; the writing page's ⋯ keeps only export and version history, and the assistant header keeps only context usage. The drawer eases in, rounds its two right corners, uses a very light scrim, and closes on a left swipe or a tap outside; pressing back while it is open closes the drawer instead of navigating
- **Write permission split into two tiers**: "Request approval" and "Approve for me", in the composer's "+" menu and in settings. It is the second of two gates in series with tool permissions: a disabled tool never reaches it; "Approve for me" skips waiting for your tap but still records the preview and the undo snapshot; deletions always wait, because a deleted object cannot be restored
- **The author-style evolution entry moved to the chapter header**: when the current chapter has something to evolve, a star icon appears next to "Edit"; chapters already evolved show the same icon in the table of contents as a plain marker. It only looks at the **latest** record for that chapter — if the assistant rewrites the chapter, a new record is created and the icon goes out, so it never claims "done" wrongly
- **Style versions record their source chapter**: an existing database gains one column (added, never migrated); the style library shows "from: Chapter 1", and the source stays empty when the assistant triggers evolution directly in a conversation
- **Spine view enlarged, varied and slightly leaned**: base size 34×150 → 48×180; width multiplies the word-count factor by a title-hash jitter (stable per book); about one book in five leans slightly (1.5–2.5° right / 1–2° left) while the rest stand straight, and the gap on the side a leaning book leans into narrows automatically. The lean range was checked against a real shelf and the reference implementation — most books should stand straight, and "everything leans" reads as about to fall over
- **Spine cylinder rebuilt from four layers**: the project ships no gradient dependency, so four translucent bands (dark edge → bright spine → easing → dark inner edge) produce the bright-middle / dark-sides transition without adding a native dependency
- **Bottom tab press feedback switched to scale**: the default grey Android ripple is gone

### Fixed

- **Books now sit on the plank**: a book's foot used to align with the plank's bottom edge (and sank into the plank in grid view); both views now land on the plank's **top edge** (measured from the texture: the brightest row sits 35.6% up from the bottom), leaving the full plank thickness visible below
- **Squared-off book corners**: grid and list covers 6 / 8 → 2, spine top corners → 1, with a little bluntness kept to avoid aliasing
- **Broken expansion of the trace**: the height-capped scroller did not clamp on the first frame (long traces rendered at full height for one frame), the expansion gesture claimed the responder on touch-down (killing every tappable element inside), and every streamed delta re-rendered the whole screen — all three fixed (deltas now throttle at 150 ms)
- **Panel directions re-distributed**: the previous release unified every "pick one / take a look" panel to drop from the top; this release re-distributes them per the reference screenshots — only **chapter version history** and **context usage** stay at the top, the rest return to rising from the bottom. Bottom panels are edge-to-edge, 28 top corners, capped at 80% height, no grab handle
- **Delete and restore use the centered card**: previously system dialogs, now the same card as the naming input; three buttons stack with cancel at the bottom; opening delete no longer closes the drawer first, so cancelling returns you to it
- **Drawer and panel stacking**: opening export or rename from the drawer closes the drawer first
- **Drawer gestures and state**: dragging right no longer pushes the panel past its right edge; leaving the tab closes it, so the back button is no longer eaten once by an invisible drawer
- **Optional-content page**: the "local models" heading and description are back

### Trade-offs

- **Three symmetric layers in the drawer**: the work row's ＋ creates a volume, the volume row's ＋ creates a chapter, and a chapter has no next level; "new volume / new chapter" are not repeated inside ⋯
- **The "evolved" marker in the table of contents reads only the latest record**: it means "this draft has been evolved", complementing the chapter header's "there is material to evolve" icon, so the two never light up together
- **One shared centered card**: the writing page's naming input card became a shared component and the assistant page's rename uses it; the confirm label is unified to "确定" (fits both creating and renaming)

---

## [0.1.35] — 2026-10-02

### Added

- **New "book spine" style for the shelf**: a third style alongside grid and list. Each row is one full-width plank with a row of spines standing on it; thickness and height are mapped from the work's word count on a log scale (100k words is visibly thicker than 10k), and a hash of the title decides a slight lean so a row of spines looks like a real shelf. Titles are printed vertically down the spine; the rounded look is done with a highlight and a shade layer, no texture needed
- **Panel direction unified**: 15 "pick one / take a look" panels — conversation history, context usage, switch work, pick model, pick style, table of contents, export, work menu, reference-book detail, style detail, skill detail, chat settings, advanced settings, note export format — now drop down from below the header and cover the rest of the screen, instead of rising from the bottom. Rising panels are kept for input and destructive confirmations
- **Autosave switched to a debounced scheduler**: saves after typing stops; leaving the app, losing focus, or closing the page flushes any pending save immediately

### Fixed

- **Writing page felt sluggish while editing**: typing no longer re-renders the whole page on every keystroke, and no longer scans the whole text on every render. Word count updates after typing stops
- **Keyboard avoidance re-layout on the writing page**: the keyboard opening and closing no longer re-lays out the entire subtree
- **Thought-process duplication**: the group header missed some event types, the agent name showed both in the header and inline, and the same line could repeat
- **Scroll containers**: leftover grey scrollbar on Android, mis-taps during slow drags, taps that did nothing
- **Write confirmation**: confirmation channel completed for 20 tools; cancel and allow split into tiers; undo given per group; a confirmation token; action-only calls can skip it
- **Removed the style row from the writing page**: the assistant page already offers the same entry
- **Duplicated copy in the style library panel**: the same thing was said twice; the duplicate was removed
- **Header icons too large**: switch-work and ⋯ reduced from 22 to 20, consistent across both pages
- **Two stacked hairlines on the optional-content page**: "current load status" now lists the install state of all seven kinds of optional content
- **Shelf proportions**: removed the book shadow (the pale strip to the right of the book), cover corner radius 10 → 6, the plank's visible lower lip reduced from 62% to 28%, and cell width no longer subtracts excessive fixed padding

---
## [0.1.34] — 2026-10-02

### Added

- **Reasoning and execution now form one line**: a single round is one disclosure — collapsed it is a single row (`Finished · N tools · Ns`); expanded, the reasoning row and the tool rows sit on the same line, with the reasoning body indented behind a thin left rule. The run card lost its border and fill so it lines up with the reasoning row
- **Adaptive scroll container**: content shorter than the cap keeps its natural height (no empty gap); only taller content scrolls inside the card. Wired into the write-confirmation card, the question card, the update notes and the run-process body
- **Two new skills**: "De-AI · narrative architecture" (structure before wording, three calibration rules, two-stage protocol, deletion over addition) and "Information gap & conflict ladder" (set / use / reveal / renew, a 2–4 step conflict ladder, the three elements of a scene card); the existing "De-AI flavor" skill gained the three calibration rules and the two-stage protocol. Self-written skills 25 → 27
- **Clickable language switch in the docs**: both READMEs now link both sides of the language switch

### Fixed

- **Question card colours and type size**: the white button bar and the mismatched header icon block are unified with the card body; type dropped one step and both buttons are smaller
- **The two boxes on the write-confirmation card**: the plain block (collapsed) and the bordered block (expanded) are both gone
- **Write-confirmation card now shows "before"**: the collapsed state only rendered the new text; it now shows labelled before / after
- **Write-confirmation buttons are smaller**: matching the two buttons on the question card
- **Six sets of pure-white surfaces** (bottom tab bar, the four resource entries, the ⋯ dropdown on all three screens, the category panel, empty-state chips, the composer) brought down to the page background
- **"Clear current project index" moved**: out of "Advanced → Backup & restore" into "Knowledge → Index", next to "Rebuild current project index"

---

## [0.1.33] — 2026-10-02

### Added

- **Question card restyled**: background now matches the run card (light green-grey), width trimmed to 88% so it follows the message, tighter option radius, header collapsed to one line
- **Reasoning folded into the timeline**: the reasoning block is now a row on the same timeline as the execution events instead of a separate card; one reply shows "reasoning + run finished" according to the actual rounds
- **Write-confirmation card trimmed**: same palette as the other cards in the chat, 88% wide, capped height with a scrollable middle section (header and buttons stay put)
- **Two new skills**: "Serial pacing quota & anti-resolution" (three gears, A/B/C quota ceiling, anti-resolution brake, three-line pre-write check) and "Chapter beat-sheet writing" (list beats → expand one by one → stitch); plus additions to Outline building, Beta reader and Long-form continuity audit

### Fixed

- Update dialog lost its contents after tapping "Update now": the changelog stays visible and the download progress moved to its own line
- Divider lines between run-card event rows
- The question card could not be scrolled when its content overflowed
- Free-model cards still truncated their note after expanding (the line limit is lifted when expanded)
- A failed send only showed a message and never reached the diagnostics report: the message and the raw error are now recorded
- Cards inside the chat are no longer large blocks of pure white

---

## [0.1.32] — 2026-10-01

### Added

- **Confirmation and questions inline in the chat**: write confirmation and tool questions now appear as cards inside the conversation (in the same place as the live timeline); the bottom-sheet form is gone
- **Chapter title moved to the top of the writing screen**: volume name / chapter name / word count / "Edit" sit directly under the header, so the order is "chapter title → style → prose" and the text area starts with the prose itself; "Project contents" moved into the "⋯ menu"
- **Unified sheet behaviour**: bottom sheets now slide in (previously faded), carry a drag handle, use a common 28dp top radius, and scroll internally when content overflows

### Fixed

- **Live tool execution was never shown**: `onTrace` was an empty implementation, so the live trace stayed null — tool-execution events now appear in order on the live timeline
- The run process is folded into the timeline instead of being drawn as a separate card (the red error outline goes with it)
- **Write-confirmation line stats**: long chapters always showed "+0 / −0" when the edit fell beyond the first 600 characters — before/after were only compared within that prefix; the same truncation also made undo replace the whole chapter with those 600 characters
- After a failed send the input box stays empty; the original text remains in the conversation and resend uses "Retry" under that message
- Removed the session bar on the assistant screen that duplicated "Manage conversations"
- The shelf plank image carried 140px of transparent pixels on its right edge, making the two sides uneven (re-cropped to the opaque bounding box)
- Opening shelf sorting left the shelf menu open, stacking two white panels
- The empty-state text on a new conversation was mirrored (Android's inverted list flips both axes; only Y had been compensated)
- Left/right padding for the "New conversation" button in the manage-conversations sheet and for style-version cards on the style library list
- The "switch project" icon on the assistant screen now matches the writing screen
- Free-model cards share one height: title limited to one line, note to two

---

## [0.1.31] — 2026-10-01

### Added

- **True streaming for reasoning and prose**: all three protocols (OpenAI-compatible / Gemini / Anthropic) now stream — reasoning and text appear as they are generated rather than arriving in one block at the end; endpoints that reject streaming (some relays) fall back to non-streaming automatically. An idle timeout replaces the whole-request timeout, so a response that is still transferring is not cut off
- **Live timeline in the assistant**: "working · Ns elapsed" while the request runs, reasoning text scrolling in live, and tool-execution events listed in order on the same timeline; finished run cards show "took Ns"
- **Chapter version history (time machine)**: before a save overwrites a chapter, the outgoing revision is kept (last 30 per chapter). "⋯ → Version history" in the writing screen lets you read any revision in full and restore it; **the current text is archived first**
- **World-info trigger conditions**: entries gain resident / trigger probability / scan depth / secondary keywords; all of them are preserved when importing a SillyTavern world info file (previously only the primary keys survived)
- **Prose written to chapters**: the system prompt now requires the assistant to write prose into a chapter; write confirmation still applies

### Fixed

- The assistant message list now uses the industry-standard inverted list (newest first, position preserved): opening, switching and sending reliably land on the newest content, and expanding a run card no longer jumps the view
- Editing only a world-info entry's text no longer wipes its trigger keywords (it did before)
- Keywords separated by Chinese punctuation (e.g. "甲，乙") in a SillyTavern world info file now split into two keywords instead of one
- Diagnostics breadcrumb timestamps now use local time (they were UTC, 8 hours behind the phone's clock)
- Every tool call (success or failure) is recorded in the breadcrumb trail, so a full call sequence is visible when diagnosing
- Removed the divider line under assistant message bubbles
- Distillation completion text now depends on progress: once the whole book is covered it suggests starting over
- The "installed" state on the Optional content page is now a prominent badge
- Spacing and preview line height inside the write-confirmation card

---

## [0.1.30] — 2026-10-01

### Added

- **Free model catalog 5 → 12**: added Agnes AI (indefinitely free, official endpoint), ModelScope (2000 calls/day), iFlytek Spark Lite (long-term free), SiliconFlow DeepSeek-R1-Distill (reasoning), Groq (GPT-OSS-120B), Cloudflare Workers AI (with account-ID placeholder guidance); every free-tier claim verified online
- **SillyTavern world info import**: the world info page accepts SillyTavern World Info JSON, preserving content, enabled state and trigger keywords (key[])
- **SillyTavern character card import**: the characters page accepts V1/V2/V3 JSON cards and PNG cards with embedded data; personality / scenario / first message fold into the character description
- **World info trigger keywords**: entries gain editable keywords; during writing and chat the writing assistant prioritizes reading matching entries

### Fixed

- The assistant correctly jumps to the newest content after opening / switching conversations and after sending (previously stuck on the oldest); expanding a run card no longer causes jumps
- The shelf plank now spans edge to edge instead of stopping at the page margins
- The Optional content page now shows the previously missing Chinese Novelist skill pack and WenKai font pack download cards
- Spacing between blocks inside the distillation details sheet
- The assistant run card background changed from pure white to a light green-gray; failure red border unchanged
- Five copy strings no longer reference the renamed settings group

---

## [0.1.29] — 2026-10-01

### Added

- **Distillation & request forensics**: every failed attempt and each distillation stage records its classification (connection reset / timeout abort / server error), duration, batch index and sample size into the diagnostics report
- The oh-story content pack moved under Settings → Knowledge → Optional content

### Fixed

- Opening or switching an assistant chat now jumps to the latest message
- Removed the duplicate "Retry" button inside the execution card (the copy / retry row under the message remains)
- Bookshelf rewritten the way shelf apps do it: the plank texture is the row's background layer (full width, bottom anchored) with fixed-width book cells bottom-aligned on it — fixes the lone-book giant cover and the plank/books disconnect
- Restored the missing "Optional content" settings entry

---

## [0.1.28] — 2026-10-01

### Added

- **New "Optional content" settings entry** (Knowledge group): every on-demand download in one place — local embedding / rerank models, the Lorn style Skill, a third-party skill pack, and a body-text font pack; nothing is required for writing
- **Body font pack (LXGW WenKai GB Lite)**: OFL-1.1 open-source Chinese font; download it and pick "文楷" under Editor → Body font (SHA-256 verified, China mirrors), fixing devices where Kai fell back to the default font
- **Third-party skill pack (Chinese Novelist, MIT)**: a staged workflow for writing complete Chinese long-form fiction (Q&A positioning / planning / drafting / validation), installed from a pinned commit, toggleable and removable
- Style distillation now shows a **progress bar with percentage** (sampling / analysis / synthesis / saving)
- Downloads no longer misreport: downloading one item only marks that item as busy

### Fixed

- Bookshelf depth redone: the plank renders at the texture's native aspect ratio (no more vertical stretching) with books seated behind it; book shadows are a small soft shade on the right; removed the accidental cover border
- Update dialogs no longer stack (removed a leftover legacy alert); Advanced no longer dumps the full release notes
- Assistant: your own messages align right and size to content; execution / reasoning / error cards adapt to content (no full-width, no squeezed vertical text); expanding a card no longer jumps to the latest message
- "Raw error details" width follows its content
- Agents / skills / rules / tool-permission cards drop the harsh white background
- Style-library Word (.docx) import fixed (database whitelist was missing docx)
- Collapsed groups become a compact list without large empty gaps
- The ⋯ menu is now an anchored dropdown under its button and narrower (shelf / writing / assistant); meaningless right-side hints removed
- Shelf sorting no longer offers "by title"

---

## [0.1.27] — 2026-10-01

### Added

- **Bookshelf categories**: "⋯ menu → Category management" — create / rename / delete categories (deleting moves its books back to uncategorized), with per-category book counts; long-press a book for "Move to category…"
- **Bookshelf category filter**: the header shows the current group (tap for a full multi-row picker), plus a chip row under the quick actions for fast switching; selecting a group shows only its books, "All" flattens the shelf; the choice is remembered
- **Shelf sorting**: recently updated / created / title / word count — applied within groups and to the flat shelf
- **Book shadow & plank as textures**: more realistic depth and lighting

### Fixed

- Update dialogs no longer stack: removed a leftover legacy alert that appeared alongside the new card
- The Advanced page no longer dumps the full release notes
- User message bubbles align to the right (previously stuck mid-left); the timestamp and edit button follow
- Assistant execution / reasoning / error cards are narrowed instead of full-width
- Agents / skills / tool permissions collapse into a compact grouped list with separators
- **Style library Word (.docx) imports now succeed**: the database whitelist was missing docx
- Removed the accidental border around book covers

### Changed

- The shelf ⋯ menu is now an anchored dropdown under the button; category management and sorting became real features, replacing the "show categories on shelf" toggle

---

## [0.1.26] — 2026-10-01

### Added

- **Bookshelf local import**: bring TXT / Markdown / Word (.docx) / EPUB files in as projects — split by volume / chapter headings (recognizes 「第X卷」/「第X章」/ prologue / epilogue markers; one chapter when no markers; oversized chapters auto-split), opened right after importing
- **Bookshelf header becomes 「＋ New」 and a 「⋯ menu」**: the menu holds the shelf style (grid / list) and local import; category management / show categories on shelf / shelf sorting are placeholders (not yet available)
- **Selectable mascot**: Settings → Basics → Mascot, six options (cat / fox / paper crane / shiba / dragon / ink-drop), tinted by the theme
- **Processing time per reply**: the reasoning block header shows elapsed seconds
- **English README and CHANGELOG** (bilingual navigation)

### Fixed

- Bookshelf depth: cover outline and shadows strengthened; plank recolored to a light warm gray with a drop shadow
- Update dialog: shows the release notes; buttons are Now Later / View details (opens the GitHub Release) / Update now
- User bubbles size to their content; the Edit button is gray and shows the send time
- Agents / skills / tool permissions grouped, collapsed by default; search matches names and descriptions only
- Style-library imports: picker MIME list aligned with attachments; size check no longer misfires; failures carry a stage label and are logged
- Write-confirmation dialog: changes collapsed by default (summary + 3-line preview + expand), height-capped with internal scrolling

---

## [0.1.24] — 2026-10-01

### Added

- **Built-in writing skills grow to 39** (16 from the upstream pack + 23 self-written by Storyloom, ~27k characters): added outline building, expand & compress, interactive-fiction branching, simulated reader & retention diagnostics, blurbs & pitch copy, audio-drama scripts, scene & atmosphere description, writing research, theme design, series & cross-book foreshadowing, fanfiction, poetry & lyrics, golden-finger & power-system design; earlier additions: screenplay scenes, worldbuilding & consistency, scene pacing & imagery, genre conventions & reader expectations, satisfying-payoff & face-slap design, voice consistency, long-form continuity audit, dialogue polish, de-AI-flavor
- **Skills / agents / tool permissions grouped**: skills in 6 categories (characters / dialogue & style / genres & settings / review & polish / conventions & continuity / plot & structure), agents split primary / sub, permissions grouped by target (6 groups); skills and permissions lists gain search boxes
- **Skills open to full instructions**: tap a skill for a scrollable sheet; built-in skills can be **duplicated into an editable custom copy**; list and sheet explain "locked = bundled or online-updated, not editable"
- **Style-library imports no longer depend on the filename**: when the extension is missing, format is identified by MIME and file content (zip signature + `word/document.xml` / `META-INF/container.xml`); errors echo the real filename and type; attachments get the same fallback

### Fixed

- **Bookshelf grid becomes "books standing on a plank"**: removed the extra fake plank and inner cover frame; titles and volume / chapter / word counts moved **below the plank**; the plank gains thickness, books touch it with a contact shadow; covers get larger radii and a light spine; cover text no longer truncates, stats no longer wrap
- **Assistant input merged into one layer**: fixes the nested "box inside a box"; attachment and send buttons are visible again as `[＋] input [send]`
- **Only one "Edit" on user messages**: previously the old and new buttons rendered together
- **Extension presets merge on both content-pack read paths**: previously, once the pack was stored locally, the copy without extensions was served — making "de-AI-flavor" and the long / short / screenplay agents disappear from settings
- Added the create-project / create-volume / create-chapter tools to the permissions catalog (previously 37 real tools vs. 34 listed)

---

## [0.1.23] — 2026-09-30

### Added

- **Automatic update check on launch**: silent check, card popup on a new version (auto-closes after 10 s, "Later" or "Update now" — downloads and installs in-app)
- **Diagnostics gain "recent navigation trail"**: stored separately from errors and doesn't count against the error cap; trail records down to page level

### Fixed

- **Assistant input**: removed the nested box-in-box, now a single capsule (attach / input / send) with a smaller send button
- **Bookshelf grid**: plank became a single layered board, generated covers gained an arc highlight and deeper contact shadows
- Removed the redundant model-switch button on the models page; restored the model picker on the assistant's book row
- Long-press conversation settings and model-capabilities spacing — the previous fix was insufficient, re-adjusted
- User message "Edit" moved out of the bubble (below it)
- Mascot now **long-press (350 ms) to drag** to avoid scroll conflicts; suggestion chips shrunk into a row
- Unnamed scratch container is only created **once you start typing**

---

## [0.1.22] — 2026-09-30

### Added

- **Bookshelf form**: each row of books stands on a shared plank with spine / page details and deeper shadows; covers without images get a generated typographic cover
- **Per-model conversation settings**: long-press a model for "this model only / global default"
- **Model capabilities page**: temperature / max tokens / tool calls / image input in one place
- **Three creation tools**: the AI can create projects / volumes / chapters (with write confirmation)
- **Operation trail**: page visits and opened books are logged and exported with diagnostics
- **Cover / avatar downsampling on save** (covers 1080 px, avatars 512 px wide)
- **Switch-project icon** added on the assistant and writing pages

### Fixed

- "Add provider" couldn't return to the models page
- Note-export format dialog couldn't be cancelled (Android system dialogs cap at 3 buttons; replaced with a custom one)
- Long-press settings and capabilities layout too cramped
- Mascot toggle misplaced into the chat-font row
- User message "Edit" moved below the bubble

### Changed

- **Settings consolidation**: 13 → 12 entries (removed "General" and "Context"; "Connection" keeps only the timeout; added "Model capabilities"); setting keys unchanged, old settings preserved
- **Models page redesign**: default-model card + plain provider rows + dedupe moved to the header
- The scratch chat container is renamed "Unnamed" and created lazily

---

## [0.1.21] — 2026-09-30

### Added

- **Settings consolidation**: 13 → 10 entries at this stage (removed empty "General / Connection / Context" pages, all settings relocated); data location and reset-defaults moved to "Advanced"; autosave delay and mascot toggle moved to "Editor"
- **Models page redesign**: a single default-model card; plain provider rows (name / endpoint / fetch models / advanced / delete) + radio to switch default; "clean duplicates" in the header
- **Per-model conversation settings**: long-press a stored model for message count / context window / compression toggle, stored as an override with a reset to global
- **Model capabilities page**: per-model temperature / max tokens / tool calls / image input, re-guessed by model name
- **Three-step new-provider wizard**: provider → advanced (skippable) → confirm
- **Connection & advanced page**: request timeout + provider advanced settings entry
- Per-model runtime overrides for history limit / compression
- **Write confirmation cards**: badge + red/green line stats + reject / accept
- **In-input model switcher**: labeled model dropdown under the input, attachment count shown

---

## [0.1.19] — 2026-09-29

### Added

- **Package name changed to `com.meekoriela.storyloom`**, aligned with the account name (was `com.meeko529.storyloom`). ⚠️ A package-name change is a new install identity: **no direct overwrite** — back up → uninstall → install → restore (signing unchanged, so installation itself is unaffected)
- **EPUB export**: e-book format with per-volume / chapter table of contents and optional cover; chapter / volume / whole-book ranges supported
- **Note export**: export all notes of the project as Markdown, organized book → volume → chapter (orphans grouped under "Other", nothing lost)
- **Bookshelf dual view**: switch between **cover-wall grid / list**; covers without images get a generated color cover (title-derived color + initial watermark) with volume / chapter / word stats
- **Conversation directory panel**: full-width "new conversation" button, per-conversation **rename**, message counts; creation asks for confirmation
- **Mascot**: a cat in the assistant's input corner, tinted by the theme
- **Crash & error log merged into diagnostics**: local JS exceptions exportable from "Advanced → Diagnostics"; the settings page shows a count and supports clearing
- **Attachments support Word (.docx)**: send Word files to the assistant, or import .docx into the style library for distillation
- **UI upgrade**: larger radii (4/8 → 8/12/16), layered card shadows

### Fixed

- **Second cover change did nothing**: the old code wrote to a fixed path, so the image component hit its cache; now each save uses a unique filename
- **Writing-page footer floated mid-screen**: keyboard avoidance by height occasionally used a stale keyboard height, shrinking the editor; switched to padding-based avoidance

### Changed

- Diagnostics gained an "error log" section; **a crash with an empty log = a native-layer problem (e.g. OOM)** — a diagnostic clue

---

## [0.1.18] — 2026-09-29

### Added

- **Plain-text (TXT) export**: no markup, title and volume names on their own lines
- **File attachments**: send txt / md / json etc. to the assistant, or save them as project notes
- **Visible reasoning**: collapsible block when the model returns its thinking
- **Context usage meter**: estimated percentage in the title bar with a breakdown; configurable context window per model
- **Project covers & character avatars**: upload a 3:4 cover; characters get avatars
- **Project action panel**: long-press / three-dot opens rename & description, volume / chapter / word stats, upload / replace / remove cover, delete project
- **Editor fonts split**: separate font & size for writing vs. chat
- **Form examples**: one-tap examples for agents / skills / rules
- **Model capability labels**: "supports tools" / "supports images" with name-based guesses
- **Unsigned iOS build workflow** (manual trigger; unverified on device)

### Fixed

- Restored missing borders on multiline inputs (system prompt, skill instructions, rules, character settings, world-info notes, note content)
- Fixed the app still showing "update available" after upgrading, displaying the previous release's notes
- Update notes now render inside the "App version" section

### Changed

- Backups include covers and avatars; settings home shows names only, explanations moved to sub-page tops
- Commit convention upgraded: one thing per commit, written from the user's perspective — the direct source of Release notes

---

## [0.1.17] — 2026-09-29

### Added

- **AI writes are confirmed first**: before writing chapters / notes / settings you see before-and-after, accept or reject as a group, with single-level undo
- **Free-model section**: a dedicated page with five free models as cards — get a key and enable in one tap
- **Custom content packs**: export your rules / skills / agents as JSON, import packs from others
- **Examples**: the agent form gained a one-tap example

### Changed

- Settings entries grew from 12 to 13 (a new "Free models" category); only non-obvious items kept inline explanations

---

## [0.1.16] — 2026-09-28

### Added

- **One-tap backup / restore** under "Settings → Advanced": everything packed as a zip for cloud drives or PC, restored wholesale on a new phone (excluding API keys)
- **In-app updates**: check, download (with a mainland mirror fallback) and install without visiting GitHub
- **Diagnostics export**: app version, device info and non-sensitive settings for bug reports — no API keys or manuscripts
- **Built-in creation presets**: long-form / short-form / screenplay agents and the "de-AI-flavor" skill, ready on install
- **Settings grouping**: 12 entries across Basics / Connection & Models / Creation System / Knowledge / System, each with a one-line note
- **Free-tier markers**: provider presets sorted with free tiers first (Zhipu / SiliconFlow / OpenRouter / Qwen)
- **Zero-download first launch**: the base agent / skill content pack (478 KB) is bundled
- **Optional downloads**: embedding / reranking models, the Lorn style skill and the oh-story pack became optional with per-item download entries
- **Mainland mirrors for local models**: automatic fallback when the primary source fails
- **Editor settings category**: body size (11–28), three fonts with live preview
- **Provider quick-fill**: Zhipu / DeepSeek / Qwen / SiliconFlow / Kimi / custom relay
- **App icon**: redrawn as a quill with adaptive and monochrome variants plus a splash screen

### Fixed

- "Current version" on the Advanced page showed 0.1.0 (the version number was only injected into `build.gradle`, not `app.json`)
- Editor font / size changes didn't apply on return (now reloaded when the page regains focus)
- The physical back button on Settings exited the app (now returns to the settings home)
- The "Author style" entry was a dead page; it now opens the style library directly
- Rules / skills / agents had no delete confirmation
- Index number inputs couldn't be cleared and re-typed (defaults instantly overwrote them)
- The "rebuild index" button's progress state bled across settings pages
- Save failures left the UI inconsistent with storage
- Rules / skills / agents could only be deleted and re-created; now editable in place

### Changed

- Tool permissions switched from tap-cycling to three explicit buttons, plus bulk allow / ask / deny
- General / connection / context / index settings gained one-tap reset to defaults
- Settings copy unified to formal wording; numeric fields annotated with ranges
- **Builds use a fixed signing certificate**: previously CI generated a fresh debug certificate each build, breaking overwrite installs and tripping security checks
- Build artifacts publish automatically to Releases

---

## [0.1.0] — 2026-09-27

First release.

### Added

- **Provider advanced settings**: custom headers, custom auth header name & prefix, function-calling off, `max_tokens` parameter rename — for Chinese vendors, relays and self-hosted gateways
- CI pipeline: cloud builds publish the APK to Releases

### Changed

- Display name `OpenFicM` → `Storyloom`
- Package name set to `com.meekoriela.storyloom`
- In-app update checks target this repository

---

## Notes

- Upstream OpenFicM is versioned `0.8.0`; this project numbers independently from `0.1.0`
- Every release APK is signed with the **same fixed certificate**, so updates overwrite-install directly
- The signing certificate SHA-256 fingerprint is printed in each Release's notes

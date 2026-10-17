---
name: deep-explanation
description: Loaded when the learner asks for more depth (a deep dive, "go deeper", "explain it properly", the go-deeper button). How to teach the mechanism, prerequisites, a worked example, misconceptions and trade-offs, spoken or on the whiteboard.
---
The learner asked to go deep. They should come away able to explain the topic to someone else, including why and how, not just what. A vague overview is a failure. For this answer, the length set here replaces the usual brevity defaults.

What to cover, in this order (skip a step only if it truly doesn't apply)
1. Hook: one or two sentences with the big idea, so the learner hears you right away.
2. Prerequisites and the name: briefly fill in the one or two ideas the learner needs first (judging from the conversation, not from guesses about them). Take the term or acronym apart word by word and say why it's named that.
3. The problem it solves: what went wrong before it existed, as one concrete failure.
4. The mechanism, step by step: the real stages, components, data and decisions, what each one does, and what triggers the next. Name the real tools, standards, commands or parts people actually use.
5. A worked example followed from start to finish, with specifics: a concrete input, what each stage does to it, and what happens when something fails.
6. The most common misconception and why it's wrong, plus one real trade-off, cost or limit.
7. How it connects to the ideas the learner will meet next, and a one-sentence takeaway.

Depth rules
- Every step needs at least one concrete specific: a real name, number, timescale, command, file or scenario. Never say "it makes things easier" without saying how, and by what mechanism.
- Explain causes. After each "what", give the "because" or "which means".
- Define each technical term the first time you use it. Accuracy beats breadth: say "typically" where practice varies, and label invented numbers as examples.
- Deep doesn't mean slow or repetitive. Don't restate a step you already made; build on it.

Length
- Spoken only, without a whiteboard: about 10 to 15 natural sentences in one reply, following the order above in plain speech.
- On the whiteboard: up to 8 segments, one per step above. The hook has no `<draw>`. The others have 60 to 90 spoken words each, about 550 to 700 words in total. Each later segment extends the board with something new (an `add`, a `note` with a definition, a `table` for the trade-off, a `timeline` or a second diagram for the worked example) and highlights what each sentence is about.

Interruptions and preferences
- If the learner interrupts, don't restart the lesson. Continue from the lesson state you're given, or answer the new question first.
- An explicit request for depth beats a saved "brief" depth preference. Saved pace, personality and name still apply.

The examples below show the depth and shape of a good reply. Don't reuse their topics, names, scenarios or wording; pick an example that fits the learner's subject.

Example (spoken only): the start of a deep explanation of HTTPS.
"HTTPS is ordinary web traffic sent through an encrypted tunnel, so nobody between you and the site can read or change it. To see why that matters, picture café Wi-Fi. Without HTTPS, anyone on that network could read the password you type. The S stands for secure, and the tunnel is built by a protocol called TLS..."

Example (whiteboard): the worked-example step of a CI/CD deep dive, extending the pipeline drawn earlier.
<segment><objective>Follow one change through the pipeline</objective><draw>{"setup":[{"op":"add","diagram":"pipeline","near":"tests","side":"below","nodes":[{"id":"failed_test","label":"Test fails","color":"red"}],"edges":[{"from":"tests","to":"failed_test","label":"blocks merge","style":"dashed"}]},{"op":"note","id":"worked_example","text":"Maya's fix: 3-line change, pipeline runs in about 6 minutes","near":"commit"}],"cues":[{"sentence":0,"ops":[{"op":"highlight","targets":["commit"]}]},{"sentence":2,"ops":[{"op":"highlight","targets":["failed_test"]}]}]}</draw><say>Say Maya pushes a three-line bug fix at ten past two. GitHub Actions picks up the push within seconds, builds the app and runs four hundred unit tests in about six minutes. One test fails, because her fix changed a date format another module relied on. So the merge is blocked before the bug ever reaches a user, and she gets the failing test's name in a notification instead of a bug report from a customer.</say></segment>

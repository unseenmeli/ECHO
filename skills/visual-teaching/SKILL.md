---
name: visual-teaching
description: Loaded whenever ECHO teaches with the lesson window's whiteboard open. How to choose a clear visual and keep the drawing in step with the narration, using the segment protocol's drawing operations.
---
Teach so the learner hears an idea and sees it at the same moment. The segment format and the operations are defined by the lesson protocol above; this pack is about using them well.

Choosing the visual
- Draw relationships, not decoration. Pick the form that matches the idea:
  - steps or a pipeline: `diagram` with layout row (or column for vertical flows)
  - a loop that repeats: layout cycle
  - one central thing and its parts or neighbours: layout hub (the first node is the centre)
  - a hierarchy or a decision: layout tree, diamond-shaped nodes for decisions
  - things that happen in order over time: `timeline`
  - two to five options compared on the same criteria: `table`
  - quantities: `chart`, only from a `<data>` block in the same segment
  - one definition or warning worth keeping in view: `note` near the element it explains
- If a picture would not help (a greeting, a yes or no, a definition the learner already has), leave out `<draw>`.

Building it up
- Start small: the first visual has only what the first sentences talk about, usually 3 to 5 nodes. Later segments extend it with `add`, `note`, `group` or `update`, in the same place and with the same ids. Don't reveal steps you haven't reached.
- One idea per segment. If the board is getting crowded, `focus` on the part in use, `remove` your own elements that are finished, or start a `new_region` for a new topic.
- Keep colours meaningful and consistent: pink for the main subject or key idea, blue for supporting parts, green for outputs or results, orange for attention, red for problems or failure, purple for people or actors.
- Elements marked "user" are the learner's. Highlight them or put a note beside them, never change or remove them. If the learner selected something, start from it.

Keeping speech and drawing in step
- Put everything the narration names into `setup`, so it is there before the first word. Use `cues` to highlight exactly what each sentence talks about, one highlight per sentence at most. Cue indices count the sentences of `<say>` from 0.
- The highlight follows your voice automatically. So never say "as you can see", "here", "on the board", "this diagram" or "look at": just name the thing.
- Only refer to what is on the board. If a drawing fails, the app tells you through the board state; continue in words.

Preferences
- A saved visual style shapes the drawings. For example, "minimal sketches" means fewer nodes and no notes unless they are needed, and "diagrams" means you prefer a diagram over a table. What the learner asks for now wins.

Example: a process, with each sentence highlighting its step.
<segment><objective>How a request reaches a website</objective><draw>{"setup":[{"op":"diagram","id":"web_request","title":"Loading a page","layout":"row","nodes":[{"id":"browser","label":"Browser","color":"purple"},{"id":"dns","label":"DNS lookup","color":"blue"},{"id":"server","label":"Web server","color":"pink"}],"edges":[{"from":"browser","to":"dns","label":"asks for IP"},{"from":"dns","to":"server","label":"IP address"}]}],"cues":[{"sentence":0,"ops":[{"op":"highlight","targets":["browser"]}]},{"sentence":1,"ops":[{"op":"highlight","targets":["dns"]}]},{"sentence":2,"ops":[{"op":"highlight","targets":["server"]}]}]}</draw><say>Your browser starts with only a name, like example dot com. It asks DNS to turn that name into an IP address. Then it connects straight to the web server at that address.</say></segment>

Example: extending the same diagram later instead of redrawing it.
<segment><objective>Caching skips the lookup</objective><draw>{"setup":[{"op":"add","diagram":"web_request","near":"dns","side":"below","nodes":[{"id":"dns_cache","label":"Local cache","color":"green"}],"edges":[{"from":"browser","to":"dns_cache","label":"checks first","style":"dashed"}]}],"cues":[{"sentence":0,"ops":[{"op":"highlight","targets":["dns_cache"]}]}]}</draw><say>Most of the time the browser never waits for DNS at all, because the answer is already cached nearby. That is why a site you visited a minute ago opens faster.</say></segment>

Example: a comparison, where a table beats a diagram.
<segment><objective>TCP versus UDP</objective><draw>{"setup":[{"op":"table","id":"tcp_vs_udp","title":"TCP vs UDP","columns":["Aspect","TCP","UDP"],"rows":[["Delivery","Guaranteed, in order","Best effort"],["Speed","Slower start","Lower latency"],["Used for","Web pages, email","Calls, games"]]}],"cues":[{"sentence":1,"ops":[{"op":"highlight","targets":["tcp_vs_udp"]}]}]}</draw><say>Both protocols carry data between programs, but they make opposite trade-offs. TCP checks that everything arrives in order, while UDP just sends and hopes, which keeps delay low.</say></segment>

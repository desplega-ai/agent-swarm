# UI spec cards

A task result can carry a rich card next to the prose answer. You attach it with the `store-progress` input `uiSpec` when you complete the task. The card renders in the Slack outcome card, in the session view, on the task page and in Chat SDK channels. Surfaces that show only text (Linear, Jira, the legacy Slack card, Slack Work Objects) get the card's fallback text.

The card is on only when the operator sets `UI_SPEC_ENABLED=true`. When the "Rich cards" section is in your system prompt, the flag is on.

## When to make a card

Make a card in 2 cases:

- The requester asks for a visual, a chart, a table, a dashboard or a summary card.
- The result holds numbers that compare, a series over time, shares of a whole, or records with the same fields.

Do not make a card for:

- a one-line answer;
- a yes or no;
- a status reply;
- a delegation;
- a result that is prose only.

## `output` stays the prose answer

`output` stays the complete answer in prose. The card adds to it and never replaces it. A reader who sees only the text must get the full answer.

## The shape of `uiSpec`

```json
{
  "spec": { "root": "<element id>", "elements": { "<element id>": { "type": "...", "props": {}, "children": [] } } },
  "actions": { "<action id>": { "kind": "follow_up", "prompt": "..." } }
}
```

- `spec.root` names the root element. The root must be a `Card`.
- `spec.elements` is a flat map. Each element has `type`, `props` and `children` (a list of element ids). Give `children: []` to a leaf.
- `actions` is optional. It is for `Button` only (see "Buttons").

## The 12 components

| Component | Props | Children |
|---|---|---|
| `Card` | `title`, `subtitle`, `imageUrl` (all optional) | Any. The root of every spec. `title` renders as the header. |
| `Section` | none | Groups related elements. |
| `Text` | `content` (markdown, required), `style`: `plain`, `bold` or `muted` | none. Use `muted` for footnotes and the source line. |
| `Fields` | none | `Field` elements only. A grid of label and value pairs. |
| `Field` | `label`, `value` (string or number) | none. Good for KPIs. |
| `Table` | `headers` (string list), `rows` (list of lists of strings or numbers), `align` (`left`, `center`, `right` per column), `caption` | none. Every row has one cell per header. Right-align numeric columns. |
| `Chart` | `title` (required), `chart` | none. See below. |
| `Divider` | none | none. A separator between groups. |
| `Image` | `url` (https), `alt` (required) | none. |
| `Actions` | none | `Button` and `LinkButton` elements. A row of buttons. |
| `Button` | `id`, `label`, `style`: `primary`, `danger` or `default`, `value` | none. Needs `UI_SPEC_ACTIONS_ENABLED`. |
| `LinkButton` | `label`, `url` (https) | none. Opens the URL. |

`Chart.chart` has one of 2 forms:

- Pie, for shares of a whole: `{ "type": "pie", "segments": [{ "label": "Enterprise", "value": 52 }] }`. Each `value` is positive.
- Series, for values over categories: `{ "type": "bar" | "line" | "area", "categories": ["Jan", "Feb"], "series": [{ "name": "Revenue", "values": [1.02, 1.08] }], "xLabel": "...", "yLabel": "..." }`. Each series has one value per category. `xLabel` and `yLabel` are optional.

Chart titles stay at 50 characters or fewer. Chart labels stay at 20 characters or fewer.

## Caps

The engine checks every spec when you store it. It refuses a spec that breaks a cap and tells you which one. Fix the spec and call `store-progress` again.

| Cap | Reason |
|---|---|
| At most 2 charts | Slack renders a chart as a native `data_visualization` block, and Slack allows 2 of them per message. A 3rd number series goes in `Fields` or in the table. |
| At most 1 table, of at most 100 rows and 20 columns | Slack renders 1 native table (`data_table`) per message. Above 100 rows or 20 columns, the Slack adapter falls back to ASCII text. |
| A Slack table shows 5 rows per page | The native Slack table pages 5 rows at a time, with a pager. You cannot change the page size. Put the most important rows first. |
| 32 KiB | The JSON of `spec` is at most 32,768 bytes. |
| 45 Slack blocks, 25 elements in one `Actions` row | Slack Block Kit limits for one message. |
| https URLs only | `LinkButton.url`, `Image.url` and `Card.imageUrl` must start with `https:`. The engine refuses `http:`, `javascript:`, `data:` and `file:` URLs. |

## Buttons

A `Button` needs `UI_SPEC_ACTIONS_ENABLED=true`. When that flag is off, the engine refuses a spec with a `Button`. Use `LinkButton` instead.

When the flag is on, each `Button.props.id` matches `^[a-z][a-z0-9_]{0,39}$` and names a key of `uiSpec.actions`. An action is one of:

- `{ "kind": "follow_up", "prompt": "<at most 4000 characters>" }`: a click starts one Lead task with the prompt. It runs once.
- `{ "kind": "script", "script": "<global script name>", "args": { ... } }`: a click re-runs the script with these frozen args (at most 4 KB, checked against the script's args schema) and replaces the card with its result. No Lead task. The requester can click again after a 30-second cooldown.

A `script` action needs the script pinned in `UI_SPEC_SCRIPT_ACTIONS` (`name@<contentHash prefix>`). Only a human admin can pin one; an edited script stays refused until it is re-pinned. The script returns `{ spec, actions? }`, the same shape as `uiSpec`. When it omits `actions`, the stored actions carry over, so a Refresh button keeps working. Put an "Updated HH:MM" `Text` in the card so readers can tell when it ran.

## Which card a Slack thread shows

A Slack card shows only the spec of its own task.

- A worker's spec shows on the worker's own task (session view, task page). It does not show on the lead's Slack ask card.
- Lead rule: when a worker returns a spec that the requester must see, send that spec again in your own `uiSpec` when you complete the Slack ask.

## Example: a small card

A KPI, a table and a link button.

```json
{"spec":{"root":"c","elements":{
 "c":{"type":"Card","props":{"title":"Weekly deploys"},"children":["f","t","a"]},
 "f":{"type":"Fields","props":{},"children":["k"]},
 "k":{"type":"Field","props":{"label":"Deploys","value":"1,284"},"children":[]},
 "t":{"type":"Table","props":{"headers":["Service","Deploys"],"rows":[["api",812],["ui",472]]},"children":[]},
 "a":{"type":"Actions","props":{},"children":["l"]},
 "l":{"type":"LinkButton","props":{"label":"Open dashboard","url":"https://example.com/deploys"},"children":[]}}}}
```

## Example: a dashboard card

KPIs, 2 charts, a table and 2 rows of link buttons. The 3rd share ("Revenue by plan") is a bold `Text`, not a 3rd chart, because of the 2-chart cap.

```json
{"spec":{"root":"c","elements":{
 "c":{"type":"Card","props":{"title":"Q3 revenue at a glance"},"children":["a1","f","ch1","ch2","t1","tb","a2","src"]},
 "a1":{"type":"Actions","props":{},"children":["view"]},
 "view":{"type":"LinkButton","props":{"label":"View report","url":"https://example.com/q3"},"children":[]},
 "f":{"type":"Fields","props":{},"children":["f1","f2","f3","f4","f5","f6"]},
 "f1":{"type":"Field","props":{"label":"Revenue","value":"$4.2M (+18%)"},"children":[]},
 "f2":{"type":"Field","props":{"label":"New customers","value":"64"},"children":[]},
 "f3":{"type":"Field","props":{"label":"ARR","value":"$16.8M (+12%)"},"children":[]},
 "f4":{"type":"Field","props":{"label":"Avg deal","value":"$65.6K"},"children":[]},
 "f5":{"type":"Field","props":{"label":"Net retention","value":"118%"},"children":[]},
 "f6":{"type":"Field","props":{"label":"Win rate","value":"31%"},"children":[]},
 "ch1":{"type":"Chart","props":{"title":"Monthly revenue (2026, USD M)","chart":{"type":"line","categories":["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep"],"series":[{"name":"Revenue","values":[1.02,1.08,1.15,1.2,1.26,1.31,1.38,1.45,1.52]}]}},"children":[]},
 "ch2":{"type":"Chart","props":{"title":"Revenue by region (Q3, USD M)","chart":{"type":"bar","categories":["NA","EMEA","APAC","LATAM"],"series":[{"name":"Revenue","values":[1.7,1.3,0.8,0.4]}]}},"children":[]},
 "t1":{"type":"Text","props":{"content":"Revenue by plan: Enterprise 52%, Team 31%, Self-serve 17%","style":"bold"},"children":[]},
 "tb":{"type":"Table","props":{"headers":["Account","Region","Revenue","QoQ"],"rows":[["Halcyon Labs","NA","$412K","+22%"],["Brightline","EMEA","$356K","+31%"],["Kestrel Health","EMEA","$298K","+27%"],["Meridian Freight","APAC","$241K","+9%"]],"align":["left","left","right","right"],"caption":"Top accounts this quarter"},"children":[]},
 "a2":{"type":"Actions","props":{},"children":["open","csv"]},
 "open":{"type":"LinkButton","props":{"label":"Open dashboard","url":"https://example.com/dashboard"},"children":[]},
 "csv":{"type":"LinkButton","props":{"label":"Export CSV","url":"https://example.com/q3.csv"},"children":[]},
 "src":{"type":"Text","props":{"content":"Source: billing warehouse · Updated 2:41 PM","style":"muted"},"children":[]}}}}
```

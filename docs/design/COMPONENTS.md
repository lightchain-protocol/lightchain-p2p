# The component contract

What the interface is built from, and the rules for adding to it.

This exists because the app had three card treatments that differed by a few
pixels, two empty states, and a page header copy-pasted between the Models and
Worker panels under a class called `wallet-head-actions` — named after the panel
it was taken from, which is how you can tell. None of that shows in a screenshot
of one panel. All of it shows when you look at two.

## The rules

1. **Use what is here.** If a component exists, use it, even if it is ninety per
   cent right. Ninety per cent right and consistent beats perfect and singular.
2. **If the kit lacks something, ask — do not invent it.** A component invented
   in one surface is a component the next surface will invent differently.
3. **A component earns its place in the kit when a second surface needs it.**
   Something only the Wallet uses lives in `styles/wallet.css`, where it can be
   changed without a survey.
4. **Never add a design token.** Tokens come from `packages/ui/src/tokens.ts`
   and are generated into `tokens.css`. Request one; do not write
   `--lc-something-new` and hope. `check-tokens.mjs` fails the build on a token
   nothing defines, which is how five dead ones were found.
5. **No literal colours, sizes or spacing.** Every value is a `var(--lc-*)`.
   A hex code is a value that will drift from the light theme and from the
   other platforms.
6. **Both themes.** Dark and light are equally supported. Tokens handle this for
   free as long as rule 5 holds.

## Where things live

- `tokens.css` — generated. Never edit.
- `app.css` — reset, scrollbars, shell layout, icons, buttons, inputs, dialogs,
  the toast. Genuinely shared, and shared before the kit existed.
- `styles/kit.css` — this document's subject.
- `styles/<surface>.css` — one per surface, owned by whoever is working on it.
- `renderer/partials/<surface>.html` — the markup, assembled into `index.html`
  by `build-markup.mjs`. **Do not edit `index.html`.**

## Page archetypes

Pick one deliberately. The app already had both and no rule about which was
which, which is how the Worker page ended up as a reading page holding a
diagnostic checklist, a facts list and a log — empty margins on both sides and a
scrollbar at the same time.

### `.page` — a reading page

For prose. Constrained to a readable measure and centred. Settings, the
encryption explanation, the roadmap.

```html
<div class="page">
  <header class="page-head">…</header>
  …
</div>
```

### `.console` — a console page

For status, tables and logs. Fills the width it is given. **The page does not
scroll; its panes do.** Dashboard, Worker, Wallet, Models.

```html
<div class="console">
  <header class="page-head">…</header>
  <div class="console-body console-body-split">
    <section class="kit-card">…</section>
    <section class="kit-card kit-card-flush">
      <header class="kit-card-head"><h2 class="kit-card-title">Recent output</h2></header>
      <div class="kit-card-scroll">…</div>
    </section>
  </div>
</div>
```

`.console-body-split` becomes one column below 1100px and the page scrolls
again, which is an honest fallback rather than a grid squeezed until neither
column works.

## Components

### `.page-head`

Title, optional subtitle, actions on the right. Replaces every hand-rolled
panel header.

```html
<header class="page-head">
  <div class="page-head-main">
    <h1 class="page-title">Worker</h1>
    <p class="page-sub">Whether this machine can run one, and what it is doing.</p>
  </div>
  <div class="page-actions">
    <button class="button button-sm" type="button">Refresh</button>
  </div>
</header>
```

Actions go right of the title, not wrapped underneath it. One primary action at
most. A destructive action does not sit in this row beside neutral ones — put it
behind an overflow.

### `.kit-card`

A panel of content. `.kit-card-flush` when it holds something that scrolls, so
the scrollbar sits against the border rather than floating in a gutter.

### `.status-row`

A check, its result, and what to do about it. The remedy line is the point: a
failure that does not say what to do next is one somebody has to go and search
for.

```html
<div class="status-row">
  <span class="status-state" data-state="fail">Fail</span>
  <span class="status-line">Docker: the command exists but the daemon did not respond</span>
  <p class="status-remedy">Start Docker Desktop, then wait for it to report running.</p>
</div>
```

`data-state` is `ok`, `warn` or `fail`.

### `.verdict`

The answer, above the evidence. A summary underneath the detail it summarises is
a summary nobody reads, and it is the reason the page was opened.

### `.alert`

**Where a failure goes.** Every surface needs one place for an error, or errors
end up written into whatever text slot is nearest — which is exactly what the
Models panel did, assigning a chain error to the session subtitle so it rendered
in muted grey under the model's name and read as a description of the model.

An alert is never a caption. `data-tone` is `info`, `warn` or `error`.

```html
<div class="alert" data-tone="error" role="alert">
  <svg class="icon" aria-hidden="true"><use href="#i-alert" /></svg>
  <div class="alert-body">
    <strong class="alert-title">The job was not submitted</strong>
    …
  </div>
</div>
```

### `.chip`

A fact about the thing on screen, not a control. Chips never get borders heavy
enough to be mistaken for buttons — that is what went wrong in the room header,
where three status badges sat in a row of four buttons and the whole strip read
as one undifferentiated mess. `data-tone` is `ok`, `warn` or `danger`.

### `.facts`

Label and value in two columns, so values can be compared down the column rather
than read one at a time.

### `.empty`

One empty state, in `app.css`. `.empty-title`, `.empty-body`, `.empty-hint`.

An empty state says what would be here and how to get it. "Nothing yet" on its
own is a dead end.

## Icons

Lucide, generated into the sprite by `build-icons.mjs`. Reference by id:

```html
<svg class="icon" aria-hidden="true"><use href="#i-worker" /></svg>
```

**Do not edit the icon map** — every icon the redesign needs is already
declared. If one is genuinely missing, ask; the map is a shared file and editing
it during parallel work is how two people lose each other's changes.

Never use a Unicode character as an icon. The message hover row used `↩ ☺ ✎ ✕`,
four characters from four corners of the standard, two of which Windows renders
through the emoji font in colour at a size nothing else on the row uses.

## Writing

- Sentence case for headings and buttons. Not Title Case.
- Say what happened and what to do. "Nothing was submitted" beats "Error".
- Name the real thing. "The daemon did not respond" beats "Connection failed".
- No exclamation marks, no apologies, no encouragement.
- Never claim more safety than is true. If something is not hidden, say so.

## Accessibility

- Every control is a real `<button>` with a label. An icon-only button needs
  `aria-label`.
- Every focusable thing has a visible focus ring. `app.css` covers buttons,
  inputs and nav items; `kit.css` covers the rest. If you add a focusable
  element that neither names, add it to the kit's focus rule rather than writing
  a one-off.
- Errors carry `role="alert"`.
- Colour is never the only signal. A red border needs a word beside it.

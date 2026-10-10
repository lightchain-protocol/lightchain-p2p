# Changelog

Notable changes to Lightchain Chat, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [semver](https://semver.org/).

## [0.1.1] - 2026-10-09

### Added

- Answers on the Models page are formatted: headings, lists, bold and links,
  and code in its own block with a Copy button.
- A Copy button on every answer.
- While a question waits, the answer's bubble says what is happening and for
  how long, instead of sitting empty.
- For models that reason first, the reasoning streams into a section that
  folds away when the answer starts. It is not part of the signed answer and
  is not saved.
- The question box takes several lines and grows with them: Enter sends,
  Shift+Enter starts a new line.
- The seams between panes can be dragged: the sidebar's edge, the line between
  Conversations and Elsewhere, the model list and the people panel. Double-click
  one to put it back; sizes are remembered.
- The BETA notice has a Report on Discord button.

### Changed

- Models that can answer are listed above those with no workers.
- The two notices at the top of the window are a line each rather than a band
  each.
- Balances and the bridge's terms hold their place with a block while they
  load, instead of a spinner beside the page's own.
- A sent message's tick sits at the end of its last line.
- An answer that arrives without the worker's signature is shown with an
  `unverified` tag instead of being thrown away.

### Fixed

- Questions to mainnet models are answered again. Every one failed with "the
  frame carried no signature" after the fee was taken.
- A model's reasoning no longer appears inside its answer.
- Testnet models can be reached again.
- For Workers no longer reports Docker, Ollama or Foundry as missing on a Mac
  where they are installed and running. Opened from the Finder or the Dock the
  app was only looking in the system's own folders.

## [0.1.0] - 2026-10-02

### Added

- The utility row names the version it is running — `0.1.0 BETA` — so "what
  version are you on?" has an answer that does not need a hover.
- Settings states the network's trust model in plain language: which parts
  the Lightchain foundation operates, what the worker-signature check can and
  cannot catch, what authorising the delegate means, and who draws the
  transfer-confirmation dialog.
- Swap into LCAI without leaving the wallet: Uniswap quotes on chain,
  approvals and slippage in one dialog. The swap box can be left — a close
  button, a receipt that replaces the form, and quotes that refresh every five
  seconds.
- A sound when a deposit lands, with a switch in Settings to turn it off.
- The composer is shared between chat rooms and the Models panel.
- When a question cannot go, the app says what to do: fund the prepaid
  balance, authorise the delegate.

### Changed

- Transfers are confirmed in a dialog the app draws itself, themed and silent
  by design; the operating system's box is retired.
- Copying something says so, and the toast rides above open dialogs.

### Fixed

- The sign-in challenge is parsed before it is signed: a message that is not
  SIWE, names another service, account or chain, or has expired is refused.
  The statement's optional blank line is accepted, matching what the service
  actually writes.
- The network's chain id is enforced on sign-in rather than trusted from the
  node.
- The password re-entry tier is dropped: no dialog collected one, so the tier
  only refused.
- A prerelease tag such as `v0.9.0-beta.1` maps to a valid four-part MSIX
  version instead of an invalid one the maker rejects.

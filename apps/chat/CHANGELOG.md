# Changelog

Notable changes to Lightchain Chat, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [semver](https://semver.org/).

## [Unreleased]

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

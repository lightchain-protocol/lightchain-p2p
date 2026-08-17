# 1. Defer iOS and Android to a later release

**Status:** Accepted, 17 August 2026
**Context:** Section 8 and open decision 3 of `cross-platform-delivery-plan.md`

## Decision

The first release targets **Windows, macOS and Linux** on x64 and arm64. iOS and
Android are out of scope and will be revisited once desktop is proven in real
use.

This is a deliberate choice, not an omission. It is recorded here because the
delivery plan lists three viable options and warns that defaulting into one
without deciding is how a team ends up committed to the hardest of them by
accident.

## Why

**Mobile cannot receive peer-to-peer updates.** On iOS and Android the shell is a
store binary and the store owns the update channel. The property that makes this
whole architecture worth building — publish a fix and have it reach users
directly — does not exist on mobile. We would be shipping a different product
that happens to share a codebase.

**There is no working reference.** Pear's documentation mentions a `pear-mobile`
counterpart that is not present in the mirror, and PearPass, the reference
implementation, does not use Pear OTA on mobile at all. We would be first, on the
least proven part of the stack.

**Store policy is an unresolved risk that engineering cannot retire.** Advancement 1
makes the model catalogue open: anyone can publish, any user can call any model.
An App Store reviewer looking at an application that fetches arbitrary
third-party AI models over a peer-to-peer network with no curation is a plausible
rejection, and no amount of engineering changes that. Accepting mobile now means
accepting either that risk or a curated catalogue that contradicts Advancement 1.

**It roughly doubles the delivery surface** — a second build pipeline, a second
signing regime, two store relationships and review latency measured in days —
before the first pipeline has produced a signed artifact.

## Consequences

The six-runner build matrix stays desktop-only, which is its current shape. No
`bare-pack`, Expo or EAS work is scheduled, and no Apple or Play store
relationship needs an owner yet.

The Apple Developer Program account is **still on the critical path** for macOS
notarization, so deferring mobile does not defer that procurement. Section 5 of
the delivery plan is unaffected by this decision.

Worth being precise about what stays true: the Bare worker really is shared code,
and choosing this today costs us nothing structurally. The peer-to-peer logic we
write for desktop is the same logic a worklet would run. What we are deferring is
delivery, not portability.

## Revisit when

Desktop has shipped a signed release and applied at least one over-the-air update
in the field, and we have usage data showing mobile demand. At that point the
choice is between the store route with a curated catalogue and the Android-only
sideload route, and real users should inform it rather than speculation.

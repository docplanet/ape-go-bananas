// The one distinction every subcommand's error handling needs: a mistake in
// how the command was invoked (exit 2, check-deck-contract.md §1.5's "usage
// error" row and render-review-and-conventions.md §1.2's identical "wrong
// arg count" row -- both Python tools reserve exit 2 for exactly this) versus
// anything else going wrong once the arguments themselves were fine (exit 1).
// index.ts's top-level catch is the only place that inspects this class; every
// other thrown Error just means exit 1 with that Error's own message.
export class UsageError extends Error {}

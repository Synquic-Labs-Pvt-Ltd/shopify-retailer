// Shown while a poll keeps failing for a reason that may pass (offline, timeout, outage). The page keeps the last
// good data on screen and polling goes on by itself, so this is a note, not a banner with a button.
export function ConnectionNotice() {
  return (
    <s-stack direction="inline" alignItems="center" gap="small-200">
      <s-spinner size="base" accessibilityLabel="Reconnecting" />
      <s-text color="subdued">Connection problem, retrying...</s-text>
    </s-stack>
  );
}

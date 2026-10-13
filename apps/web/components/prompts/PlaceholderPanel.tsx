import type { PlaceholderStatus } from './logic';

interface PlaceholderPanelProps {
  statuses: readonly PlaceholderStatus[];
  // A save or a switch is running: the placeholders cannot be added.
  disabled: boolean;
  onInsert: (name: string) => void;
}

function UseBadge({ status }: { status: PlaceholderStatus }) {
  if (status.present) return <s-badge tone="success">Present</s-badge>;
  return <s-badge tone={status.required ? 'critical' : 'neutral'}>Missing</s-badge>;
}

// The aside of the editor: the placeholders the pipeline fills in, whether the text uses each one, and a click to add
// one at the end of the text.
export function PlaceholderPanel({ statuses, disabled, onInsert }: PlaceholderPanelProps) {
  return (
    <s-section slot="aside" heading="Placeholders">
      <s-stack gap="base">
        <s-paragraph color="subdued">
          The pipeline fills these in for every shot. A required one that is missing blocks the save; click one to add it
          at the end of the text.
        </s-paragraph>
        {statuses.map((status) => (
          <s-clickable
            key={status.name}
            border="base"
            borderRadius="base"
            padding="small-200"
            disabled={disabled}
            accessibilityLabel={`Add ${status.token} to the text`}
            onClick={() => onInsert(status.name)}
          >
            <s-stack gap="small-500">
              <s-stack direction="inline" alignItems="center" gap="small-200">
                <s-text type="strong">{status.token}</s-text>
                <s-badge tone={status.required ? 'info' : 'neutral'}>{status.required ? 'Required' : 'Optional'}</s-badge>
                <UseBadge status={status} />
              </s-stack>
              <s-text color="subdued">{status.description}</s-text>
            </s-stack>
          </s-clickable>
        ))}
      </s-stack>
    </s-section>
  );
}

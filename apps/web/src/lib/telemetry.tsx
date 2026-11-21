import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";

// #96 telemetry is optional: a field the client never reports is null. Both the session
// inspector and the agents panel use these helpers so a reported value reads the same on
// every surface, and a null value is never shown as a fake zero.

const number = new Intl.NumberFormat();
const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
});

export type TelemetryProps = {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsdMicros: number | null;
};

/** Micro-USD to a human USD string, e.g. 12300 -> "$0.0123". */
export function formatUsdMicros(micros: number): string {
  return currency.format(micros / 1_000_000);
}

/** dt/dd pairs for a description list; renders nothing when no value was reported. */
export function TelemetryFacts({ inputTokens, outputTokens, costUsdMicros }: TelemetryProps) {
  return (
    <>
      {inputTokens !== null && (
        <>
          <dt>Input tokens</dt>
          <dd data-telemetry-input-tokens>{number.format(inputTokens)}</dd>
        </>
      )}
      {outputTokens !== null && (
        <>
          <dt>Output tokens</dt>
          <dd data-telemetry-output-tokens>{number.format(outputTokens)}</dd>
        </>
      )}
      {costUsdMicros !== null && (
        <>
          <dt>Reported cost</dt>
          <dd data-telemetry-cost>{formatUsdMicros(costUsdMicros)}</dd>
        </>
      )}
    </>
  );
}

/** Compact badges for dense rows such as the agents panel. */
export function TelemetryInline({ inputTokens, outputTokens, costUsdMicros }: TelemetryProps) {
  if (inputTokens === null && outputTokens === null && costUsdMicros === null) return null;
  return (
    <Stack direction="horizontal" gap={2} wrap="wrap" data-telemetry-inline>
      {inputTokens !== null && (
        <Text type="inherit" color="inherit" data-telemetry-input-tokens>
          input tokens: {number.format(inputTokens)}
        </Text>
      )}
      {outputTokens !== null && (
        <Text type="inherit" color="inherit" data-telemetry-output-tokens>
          output tokens: {number.format(outputTokens)}
        </Text>
      )}
      {costUsdMicros !== null && (
        <Text type="inherit" color="inherit" data-telemetry-cost>
          cost: {formatUsdMicros(costUsdMicros)}
        </Text>
      )}
    </Stack>
  );
}

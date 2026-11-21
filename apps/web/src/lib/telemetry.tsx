import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";

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

export function formatUsdMicros(micros: number): string {
  return currency.format(micros / 1_000_000);
}

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

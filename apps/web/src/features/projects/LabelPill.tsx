import { Text } from "@astryxdesign/core/Text";
import type { ProjectLabel } from "@orrery/contract";
import type { CSSProperties } from "react";

type LabelStyle = CSSProperties & { "--label-color": string };

export function LabelPill({ label }: { label: ProjectLabel }) {
  const style: LabelStyle = { "--label-color": label.color };
  return (
    <Text
      as="span"
      type="supporting"
      className="label-pill"
      style={style}
      data-label-id={label.id}
      data-label-name={label.name}
    >
      {label.name}
    </Text>
  );
}
